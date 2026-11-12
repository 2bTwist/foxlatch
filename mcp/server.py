#!/usr/bin/env python3
"""Foxlatch MCP server (stdio) for one agent session: drives one Firefox
profile that the user confirms, through that profile's Foxlatch host.

Standard library only. Speaks newline-delimited JSON-RPC 2.0 (MCP stdio
transport). The session id is generated here, kept in memory, and sent only
to the host over a Unix socket; when this process exits the socket closes and
the add-on ends the session's control of the profile.

eval, define and call exist only in the add-on's personal build: tools/list
names them only when the connected profile (before connect, any open
profile) runs a build with scripts, and notifications/tools/list_changed
says when that changes. Any other build's package has no code for them, and
the add-on refuses them.
"""

from __future__ import annotations

import contextvars
import hashlib
import json
import math
import os
import secrets
import socket
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from foxlatch import build as builds  # noqa: E402
from foxlatch import paths  # noqa: E402

PROTOCOL = 2
RUN_DIR = paths.resolve().run
SLACK_S = 10  # host timeout beyond the add-on's own
SERVER_FILE = Path(__file__).resolve()
EXTENSION_DIR = SERVER_FILE.parent.parent / "extension"

INSTRUCTIONS_HEAD = """\
Drives the user's everyday Firefox through the Foxlatch add-on, without WebDriver, so sites
treat it as a normal browser. Each Firefox profile with the add-on is listed by `profiles`;
a profile without it does not exist to you.

Before any browsing:
1. Call `profiles`. Ask the user which profile to use unless they already named one in this
   conversation. Never pick one yourself, even when only one is listed.
2. Call `connect` with that profile. It returns a six-digit code and Firefox opens a
   confirmation tab in that profile's own window. Tell the user the code exactly as returned
   and ask them to click Allow there only if the codes match.
3. Call `await_approval`. Proceed only when it returns granted.

Several sessions may drive one profile at once, each with its own confirmation, window and
tabs; another session connecting never ends yours. Control ends when this session ends or
when the user stops it from the add-on's toolbar button. A tool that answers "not connected"
means control has ended: tell the user, do not reconnect on your own. Protected sites, and
others the user chose, take one session at a time: if another session is using one, the
call is refused with its label. Wait for it to finish or ask the user; do not work around it.

You act only on tabs you opened, in your own window. Password fields are refused. The
account, sign-in and web mail pages of Google, Microsoft and Apple are protected, with any
sites the user added: the first `open` or `navigate` there asks the user in Firefox (unless
the site was remembered for this project before you connected) and waits up to 100 s. What
you read there is private, so go there only when the user asked for it in this
conversation, and tell them before you call so they expect the question."""
# Only in a build with scripts: the rest of that paragraph.
INSTRUCTIONS_SCRIPTS = """ Every `eval` asks
them too, showing them the exact code and your one-line `purpose`; prefer snapshot, click
and type, and keep scripts short and readable. For a script run many times, `define` it once
(they approve the function) and `call` it with data. `eval` and `define` return at once with
a question id: tell the user a script is waiting for them in Firefox, then call
`await_approval` with that question, which returns the script's result (or the function's
id) once they allow it. If they say no, do not ask again unless they tell you to."""
# Refs from find, snapshot and read are one kind: any of them works in click,
# type, select and key.
INSTRUCTIONS_MAP = """

What to use, after `open`:
- Find a control: `find` (by role, name or text); it returns refs.
- See what is on screen: `snapshot` (use `filter` on big pages).
- Read a table, form or list: `read` (a ref or selector), paged with `offset` and `next`.
- Read long text: `text`, passing the `next` it returns as `offset` for the rest.
- Act: `click`, `type`, `select` or `key` by ref, with `waitFor` naming what should follow
  (text, selector, url or load).
- Confirm visually: `screenshot`, as a last resort; it costs far more than reading."""
# Only in a build with scripts.
INSTRUCTIONS_MAP_SCRIPTS = """
- Anything the tools above cannot do: `define` and `call`, or `eval`; each asks the user."""
INSTRUCTIONS_TAIL = """

Every action reports where its tab ended up and any tab it opened. `wait_for` survives
reloads and navigations. For a plain pause use `sleep`; never wait_for text that will not
appear. Clicks are synthetic DOM events; a control that ignores them needs the user. If a
human check (CAPTCHA, Cloudflare) appears, ask the user to complete it. Firefox keeps every
add-on off addons.mozilla.org and Mozilla account pages: ask the user to do those parts. A result that ends
with a warning that code changed means some tools may be missing or fail: tell the user what
it says.
"""


def instructions(scripts: bool) -> str:
    return (INSTRUCTIONS_HEAD + (INSTRUCTIONS_SCRIPTS if scripts else "") + INSTRUCTIONS_MAP
            + (INSTRUCTIONS_MAP_SCRIPTS if scripts else "") + INSTRUCTIONS_TAIL)


def log(*args):
    print("foxlatch mcp:", *args, file=sys.stderr, flush=True)


class HostError(Exception):
    pass


class CallTimeout(HostError):
    """Firefox did not answer one call in time; the connection is still good."""


class Cancelled(Exception):
    """The client cancelled the request before this call reached Firefox. Not
    a HostError, so nothing retries it or reports it as a tool error."""


class Call(threading.Event):
    """One tools/call request in flight; set once the client cancels it."""


# The request the current thread serves (respond sets it), so every call to
# Firefox made for it can see a cancellation before it is sent.
CURRENT_CALL: contextvars.ContextVar[Call | None] = contextvars.ContextVar("call", default=None)


def source_digest(path: Path) -> str | None:
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except OSError:
        return None


def addon_digest(extension_dir: Path = EXTENSION_DIR, build: str = "public") -> str | None:
    """The code the add-on of `build` should report at connect (background.js
    addonCode): every file its package ships as foxlatch/build.py packages
    it, the pages that ask the user included. None if they cannot be read."""
    return builds.package_digest(extension_dir, build)


def project_of(cwd: str) -> str:
    """The project remembered approvals are kept under: the canonical full
    path (symlinks resolved) of the git root that holds `cwd`, or of `cwd`
    itself outside one. A .git file counts (a worktree or submodule is its
    own root). Never the directory's last name alone: ~/Projects/billing and
    /tmp/clone/billing are two projects, and so are two src directories."""
    here = Path(os.path.realpath(cwd))
    for d in (here, *here.parents):
        if (d / ".git").exists():
            return str(d)
    return str(here)


def discover(run_dir: Path = RUN_DIR) -> list[dict]:
    """Live hosts, one per Firefox profile that has the add-on and is open;
    each says its add-on's build once the add-on has told its host."""
    return paths.live_hosts(run_dir, PROTOCOL)


class Connection:
    """The session's socket to one profile's host. Tool calls from several
    threads share it: each reply is handed to its caller by request id, so a
    slow call never holds up a fast one."""

    def __init__(self, info: dict, session_id: str, project: str = ""):
        self.info = info
        # The registry names the socket; it must be one this user's host made,
        # in a directory only this user can open, before the session id goes to it.
        problem = paths.socket_problem(Path(info["socket"]))
        if problem:
            raise HostError(f"refusing to connect to the add-on in {info['profile']['name']}: {problem}")
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        try:
            self.sock.connect(info["socket"])
        except OSError as e:
            raise HostError(f"cannot reach the add-on in {info['profile']['name']}: {e}") from e
        self.rfile = self.sock.makefile("rb")
        self.lock = threading.Lock()  # next_id, pending, dead
        self.send_lock = threading.Lock()
        self.next_id = 0
        self.pending: dict[int, dict] = {}
        self.dead: str | None = None
        try:
            # No label: the add-on names the session from its project and id, so
            # what the user reads at pairing always says where it comes from.
            self._send({"hello": {"protocol": PROTOCOL, "sessionId": session_id, "project": project}})
            reply = self._read()
        except (OSError, ValueError) as e:
            self.close()
            raise HostError(f"cannot reach the add-on in {info['profile']['name']}: {e}") from e
        if not reply.get("ok"):
            self.close()
            raise HostError(reply.get("error", "host refused the connection"))
        self.profile = reply["profile"]
        self.sock.settimeout(None)  # replies can be minutes apart; each call keeps its own deadline
        threading.Thread(target=self._pump, daemon=True).start()

    def _send(self, obj: dict, cancelled: threading.Event | None = None) -> None:
        with self.send_lock:
            # Checked again here, at the last moment before it is sent: a call
            # cancelled while it waited for its turn never reaches Firefox.
            if cancelled is not None and cancelled.is_set():
                raise Cancelled(obj.get("method", ""))
            self.sock.sendall(json.dumps(obj).encode() + b"\n")

    def _read(self) -> dict:
        line = self.rfile.readline()
        if not line:
            raise HostError("Firefox closed the connection (Firefox quit, or the add-on was reloaded)")
        return json.loads(line)

    def _pump(self) -> None:
        """Hands each reply to the call waiting on its id. When the socket
        ends, every waiting call learns at once."""
        try:
            while True:
                reply = self._read()
                if not isinstance(reply, dict):
                    continue
                with self.lock:
                    slot = self.pending.get(reply.get("id"))
                if slot is not None:
                    slot["reply"] = reply
                    slot["event"].set()
        except (HostError, OSError, ValueError, RecursionError) as e:
            reason = str(e)
        with self.lock:
            self.dead = reason
            slots = list(self.pending.values())
        for slot in slots:
            slot["event"].set()

    def call(self, method: str, params: dict, timeout_s: float = 60) -> dict:
        cancelled = CURRENT_CALL.get()
        if cancelled is not None and cancelled.is_set():
            raise Cancelled(method)  # not sent: nothing happens in Firefox
        slot = {"event": threading.Event(), "reply": None}
        with self.lock:
            if self.dead:
                raise HostError(f"lost the connection to Firefox: {self.dead}")
            self.next_id += 1
            rid = self.next_id
            self.pending[rid] = slot
        try:
            try:
                self._send({"id": rid, "method": method, "params": params, "timeout": timeout_s}, cancelled)
            except OSError as e:
                raise HostError(f"lost the connection to Firefox: {e}") from e
            if not slot["event"].wait(timeout_s + SLACK_S):
                raise CallTimeout(f"Firefox did not answer {method} within {timeout_s + SLACK_S:.0f}s "
                                  "(the page may be showing a dialog, or Firefox is busy)")
            if slot["reply"] is None:
                raise HostError(f"lost the connection to Firefox: {self.dead}")
            return slot["reply"]
        finally:
            with self.lock:
                self.pending.pop(rid, None)

    def close(self) -> None:
        try:
            self.sock.shutdown(socket.SHUT_RDWR)  # wakes the reader thread
        except OSError:
            pass
        try:
            self.rfile.close()
            self.sock.close()
        except OSError:
            pass


class Session:
    def __init__(self, run_dir: Path = RUN_DIR, cwd: str | None = None, server_file: Path = SERVER_FILE,
                 extension_dir: Path = EXTENSION_DIR):
        self.run_dir = run_dir
        self.id = secrets.token_hex(16)
        # The project remembered approvals are kept under (project_of), and
        # the label the add-on makes from it, as the user reads it.
        self.project = project_of(cwd or os.getcwd())
        self.label = f"{(Path(self.project).name or '/')[:60]} · {self.id[:4]}"
        self.conn: Connection | None = None
        self.target: dict | None = None  # registry entry of the chosen profile
        # Tool calls run on their own threads: one connection per session,
        # opened or replaced by one thread at a time.
        self.lock = threading.Lock()
        # The code this process runs, and what the add-on said it runs at connect.
        self.server_file, self.extension_dir = server_file, extension_dir
        self.started_as = source_digest(server_file)
        self.addon: dict | None = None  # {profile, version?, build?, scripts?, code?}
        self.listed: bool | None = None  # whether the last tools/list named eval, define and call
        self.told: bool | None = None  # the scripts state list_changed last announced
        self.listed_lock = threading.Lock()

    # ---- which build ----

    def scripts(self) -> bool:
        """Whether eval, define and call exist for this session: as the add-on
        of the profile it connected to said at connect, or, before that, if
        any open profile's add-on is a build with them. Only what to list;
        the add-on refuses them itself in a build without them."""
        if self.addon is not None:
            return self.addon.get("scripts") is True
        return any(info.get("scripts") is True for info in discover(self.run_dir))

    def tools(self) -> list[dict]:
        """The tools/list answer, recorded as what this client was shown."""
        with self.listed_lock:
            self.listed, self.told = self.scripts(), None
            return TOOLS_WITH_SCRIPTS if self.listed else TOOLS_WITHOUT_SCRIPTS

    def advertised(self) -> bool:
        """Whether the tools this client was last listed named eval, define
        and call (before any tools/list, what it would be listed now). Calls
        are checked against that: a client that ignored list_changed gets no
        tool it was never shown."""
        with self.listed_lock:
            return self.scripts() if self.listed is None else self.listed

    def tools_changed(self) -> bool:
        """True, once, when the tools this session has (scripts) are no longer
        the ones its last tools/list named; the client lists them again.
        Leaves self.listed alone: only a tools/list changes what was shown."""
        with self.listed_lock:
            if self.listed is None or self.scripts() == self.listed or self.told == self.scripts():
                return False
            self.told = self.scripts()
            return True

    def stale(self) -> str | None:
        """What to tell the user when the code running is not the code on disk:
        this server's own source (its tool list is from when it started), or
        the add-on's files in the profile it connected to."""
        if source_digest(self.server_file) != self.started_as:
            return ("Warning: the Foxlatch MCP server changed on disk after this session started it, so its tools "
                    "may be missing or out of date. Tell the user: restart it (reconnect the MCP server in the agent, or "
                    "start a new session); control ends with the old server, so connect again after.")
        addon = self.addon
        if addon is None:
            return None
        if not addon.get("code"):
            return (f"Warning: the Foxlatch add-on in {addon['profile']} does not say which code it runs (it is "
                    "older than this server, or could not read its own files), so some tools may fail. Tell the user: update or reload the add-on in that "
                    "profile, then connect again.")
        build = addon.get("build") or "public"
        if build not in builds.BUILDS:
            return (f"Warning: the Foxlatch add-on in {addon['profile']} says it is a {build!r} build, which this server "
                    "does not know, so some tools may fail. Tell the user: install the add-on built from this server's "
                    "tree (install.sh), then connect again.")
        expected = addon_digest(self.extension_dir, build)
        if expected is None:
            return (f"Warning: this server cannot tell whether the Foxlatch add-on in {addon['profile']} runs current code: "
                    f"it cannot work out the {build} build's package from {self.extension_dir} (a file is missing or "
                    "unreadable). Tell the user: run install.sh --doctor in the server's checkout.")
        if addon["code"] != expected:
            return (f"Warning: the Foxlatch add-on in {addon['profile']} (version {addon.get('version', '?')}) runs "
                    f"other code than {self.extension_dir}, so some tools may fail or behave differently. Tell the user: "
                    "reload or update the add-on in that profile (this ends control), then connect again.")
        return None

    # ---- profile selection ----

    def profiles(self) -> str:
        found = discover(self.run_dir)
        if not found:
            return ("No Firefox profile has the Foxlatch add-on running. Ask the user to open the "
                    "profile they want you to use (the add-on must be installed in it).")
        lines = []
        for info in found:
            status = self._status_of(info)
            lines.append(f"- {info['profile']['name']}  [id {info['key'][:6]}]  {status}")
        return "Firefox profiles with the add-on:\n" + "\n".join(lines)

    def _status_of(self, info: dict) -> str:
        conn, target = self.conn, self.target
        try:
            if conn and target and target["key"] == info["key"]:
                reply = conn.call("status", {}, 10)
            else:
                # A throwaway id: under this session's own, the probe would hold
                # it at the host, and a connect meanwhile would be refused.
                probe = Connection(info, secrets.token_hex(16))
                try:
                    reply = probe.call("status", {}, 10)
                finally:
                    probe.close()
        except HostError as e:
            return f"(unreachable: {e})"
        if not reply.get("ok"):
            return f"(error: {reply.get('error')})"
        drivers = reply["result"].get("drivers") or []
        if not drivers:
            return "free"
        return "driven by " + ", ".join("this session" if d.get("you") else d["label"] for d in drivers)

    def _find(self, name: str) -> dict:
        found = discover(self.run_dir)
        want = name.strip().lower()
        exact = [i for i in found if i["profile"]["name"].lower() == want or i["key"].startswith(want)]
        if len(exact) == 1:
            return exact[0]
        names = ", ".join(i["profile"]["name"] for i in found) or "none"
        if exact:
            raise HostError(f"'{name}' matches more than one profile ({names}); use the id from profiles")
        raise HostError(f"no open profile named '{name}' has the add-on (open profiles: {names})")

    def connect(self, profile: str) -> str:
        info = self._find(profile)
        with self.lock:
            old = self.conn if self.conn and self.target and self.target["key"] != info["key"] else None
            if old:
                self.conn = None
            self.target = info
        if old:
            try:
                old.call("release", {}, 10)
            except HostError:
                pass
            finally:
                old.close()  # a cancelled release still lets go of the old profile
        reply = self._call("claim", {}, 30)
        result = reply["result"]
        name = result.get("profile") or info["profile"]["name"]
        self.addon = {**(result.get("addon") or {}), "profile": name}
        if result["status"] == "granted":
            return f"Already connected to {name}."
        if result["status"] == "denied":
            raise HostError(f"The user said no to this session {name and 'in ' + name}. It may ask again in "
                            f"{result.get('retryAfterS', 0)} s, but only if they tell you to.")
        others = result.get("others") or []
        also = f" Also driving this profile: {', '.join(others)}; they keep their control." if others else ""
        return (f"Confirmation requested in Firefox profile {name}. Code: {result['code']}\n"
                f"Tell the user this code and ask them to click Allow on the confirmation tab that just opened "
                f"in that profile's window, only if the codes match.{also} Then call await_approval.")

    def await_approval(self, timeout_seconds: object = 90) -> str:
        if not self.target:
            raise HostError("call connect first")
        wait = max(5.0, min(finite(timeout_seconds, 90), 110.0))
        reply = self._call("await_claim", {"timeoutMs": int(wait * 1000)}, wait + 5)
        status = reply["result"]["status"]
        name = reply["result"].get("profile") or self.target["profile"]["name"]
        return {
            "granted": f"Connected: the user allowed this session to drive {name}.",
            "pending": f"Still waiting for the user to answer in {name}. Call await_approval again, or ask them.",
            "denied": "The user did not allow it. Do not ask again unless they tell you to.",
            "expired": "The request expired after 3 minutes. Call connect again if the user still wants this.",
            "cancelled": "The request was cancelled.",
            "ended": "Control ended (stopped in Firefox, or Firefox restarted). Tell the user; do not reconnect on your own.",
        }.get(status, f"No request is pending ({status}). Call connect.")

    def await_question(self, question: str, timeout_seconds: object = 90) -> object:
        """The user's answer to an eval or define: the add-on's question result."""
        if not self.target:
            raise HostError("call connect first")
        wait = max(5.0, min(finite(timeout_seconds, 90), 110.0))
        # Once the user allows a script, it runs before the answer comes back.
        return self.tool("await_question", {"id": question, "timeoutMs": int(wait * 1000)}, wait + TIMEOUTS["eval"])

    def release(self) -> str:
        if not self.conn:
            return "Not connected to any profile."
        reply = self._call("release", {}, 10)
        return str(reply.get("result"))

    # ---- calls ----

    def _ensure(self) -> Connection:
        with self.lock:
            if not self.target:
                raise HostError("no Firefox profile chosen. Call profiles, ask the user which one, then connect.")
            if self.conn is None:
                live = {i["key"]: i for i in discover(self.run_dir)}
                info = live.get(self.target["key"])
                if not info:
                    raise HostError(f"Firefox profile {self.target['profile']['name']} is not open, or its add-on is not running.")
                self.target = info
                try:
                    self.conn = Connection(info, self.id, self.project)
                except HostError as e:
                    # The host frees an id when it sees the last socket close,
                    # which can trail this side's close by a moment: once more.
                    if "already connected" not in str(e):
                        raise
                    time.sleep(0.3)
                    self.conn = Connection(info, self.id, self.project)
            return self.conn

    def _call(self, method: str, params: dict, timeout_s: float = 60) -> dict:
        for attempt in (1, 2):
            conn = self._ensure()
            try:
                reply = conn.call(method, params, timeout_s)
            except CallTimeout:
                raise  # Firefox is slow, not gone; dropping the socket would end this session's control
            except HostError:
                with self.lock:
                    if self.conn is conn:
                        self.conn = None
                conn.close()
                if attempt == 2:
                    raise
                continue  # Firefox or the add-on restarted: reconnect once
            if not reply.get("ok"):
                raise HostError(reply.get("error", "unknown error"))
            return reply
        raise AssertionError("unreachable")

    def tool(self, method: str, args: dict, timeout_s: float = 60) -> object:
        return self._call(method, args, timeout_s)["result"]


# ---------- MCP surface ----------

TAB = {"tabId": {"type": "integer", "description": "Tab id from open or tabs"}}
REF = {"ref": {"type": "string", "description": "Element ref exactly as snapshot lists it, e.g. ae12 or f3:ae12; "
                                               "a ref from a page the tab has since left is refused, so snapshot again"}}
FRAME = {"frame": {"type": "string", "description": "Frame id from snapshot (f3); omit for the top frame"}}
CONDITION = {
    "text": {"type": "string", "description": "Text that appears in the top frame's visible text"},
    "selector": {"type": "string", "description": "A CSS selector that matches in the top frame"},
    "url": {"type": "string", "maxLength": 2000, "description": "A substring of the tab's URL; * matches any run of characters"},
    "load": {"type": "boolean", "description": "true: the tab has finished loading (after an action, a load that action started)"},
    "gone": {"type": "boolean", "default": False, "description": "Wait for text, selector and url to stop matching instead"},
    "timeoutMs": {"type": "integer", "default": 15000, "maximum": 60000},
}
PURPOSE = {"purpose": {
    "type": "string", "maxLength": 200,
    "description": "One plain sentence for the user: what the script does and why, e.g. 'Reads the order table "
                   "into rows so I can check the totals.' Shown beside the code as your words; say it straight.",
}}
WAIT = {"waitFor": {
    "type": "object", "properties": CONDITION, "additionalProperties": False,
    "description": "After the action, wait until this holds (every condition given). The result says whether it "
                   "held; the action has run either way, so do not repeat it on a miss.",
}}


def tool(name, description, props=None, required=()):
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": props or {}, "required": list(required), "additionalProperties": False}}


TOOLS = [
    tool("profiles", "List open Firefox profiles that have the add-on, and which sessions are driving each."),
    tool("connect", "Ask to drive a profile. Returns a code the user must confirm in that profile's Firefox window.",
         {"profile": {"type": "string", "description": "Profile name or id from profiles"}}, ["profile"]),
    tool("await_approval", "Wait for the user's answer: to connect (no question), or to an eval or define (pass the question "
                           "id it returned). For an eval, returns the script's result once they allow it; for a define, the "
                           "function's {fn, origin}. While they have not answered, says so: call it again. An eval another "
                           "call already collected says it is running or ran; do not ask again then.",
         {"question": {"type": "string", "description": "Question id from eval or define, e.g. r12"},
          "timeout_seconds": {"type": "number", "default": 90, "maximum": 110}}),
    tool("release", "Stop driving the profile. Your window stays open."),
    tool("tabs", "List this session's tabs."),
    tool("open", "Open a URL in a new tab in this session's window and wait for it to load. "
                 "A protected site (account, sign-in and web mail pages, and sites the user added) first waits for "
                 "the user's approval in Firefox.",
         {"url": {"type": "string"}}, ["url"]),
    tool("navigate", "Load a URL in a tab, or 'back', 'forward', 'reload'. Without waitFor, waits for the load (up to 30 s). "
                     "back and forward are refused while another session holds a locked site; navigate by URL then.",
         {**TAB, "url": {"type": "string"}, **WAIT}, ["tabId", "url"]),
    tool("close", "Close one of this session's tabs.", TAB, ["tabId"]),
    tool("show", "Bring a tab and its window to the front so the user can watch.", TAB, ["tabId"]),
    tool("snapshot", "Visible interactive elements with refs, plus headings and dialogs, across frames and open shadow roots; links show "
                     "where they go (-> path, or the full address off-site). "
                     "filter keeps elements whose line contains it (case-insensitive); when nothing matches, the nearest "
                     "lines come back marked as suggestions, not matches.",
         {**TAB, "filter": {"type": "string"}, "max": {"type": "integer", "default": 300}}, ["tabId"]),
    tool("find", "Elements matching every criterion given, with refs, in document order across frames and open shadow "
                 "roots, as snapshot lines; matches counts them all, so narrow when it passes the lines shown. role: an "
                 "ARIA role (link, button, checkbox, heading, table, row...) or the role snapshot prints (a, "
                 "input[checkbox]); name: the accessible name, a case-insensitive substring, or exact in double quotes "
                 '(\"Save\"); text: the innermost element, of any kind, whose visible text holds it. Pass at least one.',
         {**TAB, "role": {"type": "string"}, "name": {"type": "string"}, "text": {"type": "string"},
          "within": {"type": "string", "description": "A ref: search only inside its element (and its frame)"},
          "max": {"type": "integer", "default": 20, "description": "Lines to return, 1 to 200"}}, ["tabId"]),
    tool("read", "Read one part of a page as JSON, shaped by what it is: a table {kind, headers, rows: [{cells, refs: [{ref, role, name}]}]}, "
                 "a form or a ref/selector holding fields {kind, fields: [{ref, role, label, value, options?, checked?, "
                 "required?, disabled?, invalid?}]} (never a password's value), a list {kind, items: [{text, refs}]}, "
                 "or else {kind: text, blocks: [{role, text}]}. Without ref or selector, reads the main landmark or the "
                 "body. Each result has total; pass next as offset for the following page (no next: the end). A row, "
                 "field, item or block with cut: true was shortened (long text, over 100 cells or refs, or a select "
                 "showing its first 50 options and the selected ones, with optionsTotal, and selectedTotal when over 100 are "
                 "selected), and headersCut says "
                 "the same of a table's headers: `text` has the full wording. Refs work in click, type and select.",
         {**TAB, **REF, "selector": {"type": "string", "description": "A CSS selector; its first match is read"},
          **FRAME, "offset": {"type": "integer", "default": 0},
          "max": {"type": "integer", "default": 50, "description": "Rows, fields, items or blocks to return, 1 to 200"}},
         ["tabId"]),
    tool("text", "The page's visible text, from offset, at most max characters (up to 200000). When there is more, "
                 "the result says so and gives the offset for the rest.",
         {**TAB, **FRAME, "offset": {"type": "integer", "default": 0}, "max": {"type": "integer", "default": 20000}}, ["tabId"]),
    tool("click", "Click an element once it is visible, enabled and not covered (retried up to 2 s, else says why). "
                  "Reports where the tab ended up, whether it is still loading, and any tab the click opened. "
                  "Pass waitFor for what the click should bring (text, selector, url, load) instead of a separate wait_for.",
         {**TAB, **REF, "force": {"type": "boolean", "default": False,
                                  "description": "Click even if something covers it, for a widget that lays its own overlay over "
                                                 "its button. It must still be visible and enabled."}, **WAIT}, ["tabId", "ref"]),
    tool("hover", "Move the pointer over an element once it is visible.", {**TAB, **REF}, ["tabId", "ref"]),
    tool("type", "Type into an input, textarea or editable element through the browser's editing path. "
                 "Replaces the content unless clear is false. Omit ref for the focused element. Password fields are refused. "
                 "Accepts waitFor, like click.",
         {**TAB, **REF, "text": {"type": "string"}, "clear": {"type": "boolean", "default": True}, **WAIT}, ["tabId", "text"]),
    tool("select", "Choose an option in a <select> by its label or value, even one a custom dropdown hides (snapshot marks "
                   "it hidden). Accepts waitFor, like click.",
         {**TAB, **REF, "option": {"type": "string"}, **WAIT}, ["tabId", "ref", "option"]),
    tool("key", "Press a key or chord (Enter, Escape, Tab, ArrowDown, Control+a) on the focused element or a ref. "
                "Enter in a form input submits the form. Accepts waitFor, like click.",
         {**TAB, **REF, "key": {"type": "string"}, **WAIT}, ["tabId", "key"]),
    tool("scroll", "Scroll an element into view, or the page by dy pixels.",
         {**TAB, **REF, "dy": {"type": "integer"}, "dx": {"type": "integer"}}, ["tabId"]),
    tool("wait_for", "Wait until the page shows text or matches a CSS selector, the tab's URL contains url (* matches any "
                     "run of characters), or the tab has loaded (load: true); every condition given must hold, and gone waits for "
                     "them to stop matching. Keeps waiting across reloads and navigations; stops if the tab moves to a page "
                     "this session may not use. Says whether it was met and where the tab is. For a plain pause, use sleep.",
         {**TAB, **CONDITION}, ["tabId"]),
    tool("sleep", "Pause for ms milliseconds (at most 30000) without touching any page. Use this instead of waiting on "
                  "text that will never appear.", {"ms": {"type": "integer", "maximum": 30000}}, ["ms"]),
    tool("eval", "Run JavaScript in the page's own world, with only the page's powers; under 20,000 characters. The user sees "
                 "the exact code in Firefox and must allow each run. Returns at once with a question id: tell the user, then "
                 "call await_approval with that question, which runs the script once they allow it (they have 100 s) and returns "
                 "the last expression as JSON. A page whose Content Security Policy forbids eval is refused before the user is asked.",
         {**TAB, **FRAME, "code": {"type": "string"}, **PURPOSE}, ["tabId", "code", "purpose"]),
    tool("define", "Ask the user to approve a JavaScript function expression once, e.g. (step, n) => ...; they see the exact "
                   "code in Firefox. Returns at once with a question id: tell the user, then call await_approval with that "
                   "question for its fn id (they have 100 s). Approved for the tab's origin until control ends. If this exact "
                   "code on this origin was remembered for this project before you connected, returns the fn id at once.",
         {**TAB, "code": {"type": "string"}, **PURPOSE}, ["tabId", "code", "purpose"]),
    tool("call", "Call an approved function in the page with JSON data, without asking the user again; returns its result as "
                 "JSON. Only on the origin it was approved for, and only the code they approved. With waitFor, returns "
                 "{result, waitFor, url, title, loading, opened}.",
         {**TAB, "fn": {"type": "string"}, "args": {"type": "array", "default": []}, **WAIT}, ["tabId", "fn"]),
    tool("screenshot", "Screenshot the visible part of a tab, or one element by ref.", {**TAB, **REF}, ["tabId"]),
]
# A build without scripts (the public one) has no eval, define or call, and
# await_approval there waits for connect alone.
SCRIPT_TOOLS = ("eval", "define", "call")
AWAIT_CONNECT = tool("await_approval", "Wait for the user's answer to connect. While they have not answered, says so: "
                                       "call it again.",
                     {"timeout_seconds": {"type": "number", "default": 90, "maximum": 110}})
TOOLS_WITH_SCRIPTS = TOOLS
TOOLS_WITHOUT_SCRIPTS = [AWAIT_CONNECT if t["name"] == "await_approval" else t for t in TOOLS if t["name"] not in SCRIPT_TOOLS]
TOOL_NAMES = {t["name"] for t in TOOLS}
SCHEMAS = {t["name"]: t["inputSchema"] for t in TOOLS_WITH_SCRIPTS}
SCHEMAS_WITHOUT_SCRIPTS = {t["name"]: t["inputSchema"] for t in TOOLS_WITHOUT_SCRIPTS}
# open and navigate may wait up to 100 s for the user's answer in Firefox; eval
# and define return before they answer, and await_approval adds eval's time to
# its wait. wait_for and sleep stop themselves (60 s, 30 s); these leave room
# for them to say so.
TIMEOUTS = {"open": 140, "navigate": 140, "wait_for": 75, "sleep": 40, "click": 30, "key": 30, "eval": 40, "define": 30, "call": 70}

# The JSON Schema keywords validate() checks. A schema using any other one
# fails at import, so no advertised constraint goes unchecked.
SCHEMA_KEYWORDS = {"type", "properties", "required", "additionalProperties", "maximum", "maxLength", "default", "description"}
JSON_TYPES = {
    "object": lambda v: isinstance(v, dict),
    "array": lambda v: isinstance(v, list),
    "string": lambda v: isinstance(v, str),
    "boolean": lambda v: isinstance(v, bool),
    "number": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v),
    "integer": lambda v: (isinstance(v, int) and not isinstance(v, bool)) or (isinstance(v, float) and v.is_integer()),
}
ARTICLE = {"object": "an object", "array": "an array", "string": "a string", "boolean": "true or false",
           "number": "a number", "integer": "an integer"}


def check_schema(schema: dict, where: str) -> None:
    unknown = set(schema) - SCHEMA_KEYWORDS
    if unknown or schema.get("type", "object") not in JSON_TYPES:
        raise AssertionError(f"{where}: validate() does not check {sorted(unknown) or schema.get('type')}")
    for key, sub in (schema.get("properties") or {}).items():
        check_schema(sub, f"{where}.{key}")


for _name, _schema in [*SCHEMAS.items(), *SCHEMAS_WITHOUT_SCRIPTS.items()]:
    check_schema(_schema, _name)


def validate(schema: dict, value: object, path: str = "arguments") -> str | None:
    """What is wrong with value under the subset of JSON Schema the tools
    use (SCHEMA_KEYWORDS), or None. The first problem only, by its path."""
    kind = schema.get("type")
    if kind and not JSON_TYPES[kind](value):
        return f"{path} must be {ARTICLE[kind]}, not {json.dumps(value)[:40]}"
    if kind in ("number", "integer") and "maximum" in schema and value > schema["maximum"]:
        return f"{path} must be at most {schema['maximum']}"
    if kind == "string" and "maxLength" in schema and len(value) > schema["maxLength"]:
        return f"{path} must be at most {schema['maxLength']} characters"
    if kind == "object":
        props = schema.get("properties") or {}
        for key in schema.get("required") or ():
            if key not in value:
                return f"{path}.{key} is required" if path != "arguments" else f"{key} is required"
        for key, item in value.items():
            where = f"{path}.{key}" if path != "arguments" else key
            if key not in props:
                if schema.get("additionalProperties") is False:
                    return f"{where} is not an argument of this tool" if path == "arguments" else f"{where} is not a known field"
                continue
            problem = validate(props[key], item, where)
            if problem:
                return problem
    return None


def finite(value, default: float) -> float:
    """value if it is a finite JSON number, else default. The add-on refuses
    any other timeoutMs before acting, so this only sizes the wait."""
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    return value if ok else default


def timeout_for(name: str, args: dict) -> float:
    """An action's own time, plus its waitFor's (capped at 60 s in the add-on)."""
    base = TIMEOUTS.get(name, 30)
    wait = args.get("waitFor")
    if not isinstance(wait, dict):
        return base
    ms = finite(wait.get("timeoutMs"), 15000)
    return base + min(max(ms, 0), 60000) / 1000 + 5


def text_content(text: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], **({"isError": True} if error else {})}


def render(name: str, result: object) -> dict:
    if name == "screenshot" and isinstance(result, str) and result.startswith("data:image/png;base64,"):
        return {"content": [{"type": "image", "mimeType": "image/png", "data": result.split(",", 1)[1]}]}
    if name == "snapshot" and isinstance(result, dict):
        return text_content(f"{result['title']}\n{result['url']}\nscroll {result['scroll']}\n\n{result['elements'] or '(no matching elements)'}")
    if name == "text" and isinstance(result, dict):
        head = f"{result['title']}\n{result['url']}"
        start, total, rest = result.get("offset", 0), result.get("total"), result.get("next")
        if total is not None and (start or rest is not None):
            end = rest if rest is not None else total
            more = f"; pass offset {rest} for the rest" if rest is not None else ", the end"
            head += f"\ncharacters {start} to {end} of {total}{more}"
        return text_content(f"{head}\n\n{result['text']}")
    return text_content(result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, separators=(",", ":")))


def render_question(name: str, result: object) -> dict:
    """eval, define, or await_approval on their question: still waiting, or
    the script's value or the function's id, as eval and define returned
    them when they waited."""
    if not (isinstance(result, dict) and result.get("status") in ("pending", "done", "running", "ran")):
        return render(name, result)  # not a question's answer: shown as it came
    if result["status"] == "done":
        if result.get("kind") == "function":
            return render("define", {"fn": result.get("fn"), "origin": result.get("origin")})
        return render("eval", result.get("value"))
    q, left = result.get("question"), result.get("expiresInS")
    if result["status"] == "running":
        return text_content(f"Question {q} was already collected by another call, and its script is still running in the "
                            "page; its result goes to that call. Do not ask again: read the page (snapshot or text) to see "
                            "what it did.")
    if result["status"] == "ran":
        return text_content(f"Question {q} was already collected by another call, and its script ran once; its result went "
                            "to that call. Do not ask again: read the page (snapshot or text) to see what it did.")
    if name == "await_approval":
        return text_content(f"Still waiting for the user to answer question {q} in Firefox ({left} s left). "
                            f'Call await_approval with question "{q}" again, or ask them.')
    what = "approve this function" if result.get("kind") == "function" else "run this script"
    return text_content(f"The user is asked in Firefox to {what} (question {q}; they have {left} s). Tell them it is waiting "
                        f'for them, then call await_approval with question "{q}".')


def run_tool(session: Session, name: str, args: dict) -> dict:
    out = _run_tool(session, name, args)
    warning = session.stale()
    if warning:
        out["content"].append({"type": "text", "text": warning})
    return out


def _run_tool(session: Session, name: str, args: dict) -> dict:
    try:
        if name not in TOOL_NAMES:
            return text_content(f"unknown tool {name}", True)
        if name == "profiles":
            return text_content(session.profiles())
        if name == "connect":
            return text_content(session.connect(str(args.get("profile", ""))))
        if name == "await_approval":
            if args.get("question"):
                return render_question(name, session.await_question(str(args["question"]), args.get("timeout_seconds", 90)))
            return text_content(session.await_approval(args.get("timeout_seconds", 90)))
        if name == "release":
            return text_content(session.release())
        if name in ("eval", "define"):
            return render_question(name, session.tool(name, args, timeout_for(name, args)))
        return render(name, session.tool(name, args, timeout_for(name, args)))
    except HostError as e:
        return text_content(str(e), True)


# MCP revisions this server speaks, newest first. They differ in nothing a
# stdio, tools-only server with text and image results uses, so the answer
# is the client's version when it is one of these, else the newest; a client
# that cannot use that disconnects (lifecycle, version negotiation). The
# stateless 2026-07-28 revision is not spoken: its clients probe with
# server/discover, get "unknown method" here, and fall back to initialize.
PROTOCOL_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "foxlatch", "title": "Foxlatch", "version": "1.0.4"}


def negotiate(requested: object) -> str:
    return requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]


def handle(session: Session, msg: dict) -> dict | None:
    if not isinstance(msg, dict):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "invalid request"}}
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        return None  # a notification (notifications/cancelled is read in serve_stdio)
    if method == "initialize":
        result = {
            "protocolVersion": negotiate((msg.get("params") or {}).get("protocolVersion")),
            # list_changed: the tools follow the build of the profile connected to (see Session.scripts).
            "capabilities": {"tools": {"listChanged": True}},
            "serverInfo": SERVER_INFO,
            "instructions": instructions(session.scripts()),
        }
    elif method == "tools/list":
        result = {"tools": session.tools()}
    elif method == "tools/call":
        p = msg.get("params") or {}
        name, args = str(p.get("name")), p.get("arguments")
        args = {} if args is None else args
        # Every argument is checked against the schema tools/list advertised
        # before anything reaches Firefox; a tool error, so the agent can fix it.
        shown = session.advertised()
        schemas = SCHEMAS if shown else SCHEMAS_WITHOUT_SCRIPTS
        problem = validate(schemas[name], args) if name in schemas else None
        if name in SCRIPT_TOOLS and name not in schemas and session.scripts():
            result = text_content(f"{name} was not in the tools this client was last listed; list the tools again "
                                  "(tools/list), then call it as its inputSchema says.", True)
        elif name in SCRIPT_TOOLS and name not in schemas:
            result = text_content(f"there is no {name} here: the Foxlatch add-on in this profile is a build without scripts "
                                  "(eval, define and call). Use snapshot, click, type and text instead.", True)
        elif problem:
            result = text_content(f"invalid arguments for {name}: {problem}. Call it again as its inputSchema says.", True)
        else:
            result = run_tool(session, name, args)
    elif method == "ping":
        result = {}
    else:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": f"unknown method {method}"}}
    return {"jsonrpc": "2.0", "id": mid, "result": result}


def respond(session: Session, msg: dict, call: Call | None = None) -> dict | None:
    """handle(), for one request on its own thread: the reply owed, or None
    for a notification or a request the client cancelled. A cancelled call
    that had not reached Firefox stops there (Connection.call); one that had
    runs to its end, since a click or a script cannot be taken back halfway,
    and its reply is dropped, as the client no longer waits for it."""
    serving = CURRENT_CALL.set(call)
    try:
        reply = handle(session, msg)
    except Cancelled:
        reply = None
    except Exception as e:  # noqa: BLE001  a reply is owed even when a tool breaks
        log("error handling", msg.get("method"), repr(e))
        reply = {"jsonrpc": "2.0", "id": msg.get("id"), "error": {"code": -32603, "message": f"internal error: {e}"}}
    finally:
        CURRENT_CALL.reset(serving)  # later work on this thread belongs to no request
    return None if call is not None and call.is_set() else reply


def serve_stdio(session: Session, lines, write) -> None:
    calls: dict[str, Call] = {}  # tools/call requests in flight, by id
    calls_lock = threading.Lock()

    def serve(msg: dict, call: Call | None, key: str | None) -> None:
        try:
            reply = respond(session, msg, call)
            if reply is not None:
                write(reply)
            # A connect to a profile of another build changes what this session has.
            if msg.get("method") == "tools/call" and session.tools_changed():
                write({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
        finally:
            with calls_lock:
                if key is not None and calls.get(key) is call:
                    del calls[key]

    for line in lines:
        if not line.strip():
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            write({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        if isinstance(msg, dict) and msg.get("method") == "notifications/cancelled":
            # A cancellation of a request that is unknown or done is ignored.
            rid = (msg.get("params") or {}).get("requestId")
            with calls_lock:
                call = calls.get(json.dumps(rid))
            if call is not None:
                call.set()
            continue
        # Each tool call runs on its own thread, so a slow one (a wait, a
        # question to the user) never holds up the rest; replies carry their id.
        if isinstance(msg, dict) and msg.get("method") == "tools/call":
            call, key = Call(), None
            if msg.get("id") is not None:
                key = json.dumps(msg["id"])
                with calls_lock:
                    calls[key] = call
            threading.Thread(target=serve, args=(msg, call, key), daemon=True).start()
        else:
            serve(msg, None, None)


def main() -> None:
    session = Session()
    out = threading.Lock()

    def write(obj: dict) -> None:
        line = json.dumps(obj) + "\n"
        with out:
            sys.stdout.write(line)
            sys.stdout.flush()

    serve_stdio(session, sys.stdin, write)


if __name__ == "__main__":
    main()
