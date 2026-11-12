#!/usr/bin/env python3
"""Native messaging host for the Foxlatch add-on, one per Firefox profile.

Firefox starts this process when the add-on in a profile connects, and owns
its stdin and stdout (4-byte native-endian length, then UTF-8 JSON). The host
works out which profile started it, then serves agent sessions on a Unix
socket named for that profile, inside a directory only this user can open.
It announces itself with a registry file in the run directory, which names
the socket (beside it, or in a short private directory when the run
directory's path is too long for a socket) and the add-on's build.

Socket protocol, one JSON object per line:
  -> {"hello": {"protocol": 2, "sessionId": "<32 hex>", "project": "/full/path"}}
  <- {"ok": true, "profile": {"name", "dir"}}        or {"ok": false, "error"}
  -> {"id": n, "method": "...", "params": {...}, "timeout": seconds}
  <- {"id": n, "ok": true, "result": ...}            or {"id": n, "ok": false, "error"}

The host binds the session id to the connection: requests carry no session id
of their own, and a second connection claiming a live session id is refused.
A hello's label, if it has one, is not passed on: the add-on names a session
from its project, so no session can pair under a name that hides it.
The add-on decides what a session may do; the host only routes, and keeps the
profile's remembered approvals file, which it alone writes, and only when the
add-on asks over the Firefox port (the user ticked Remember, or clicked Forget).

Firefox runs this through the launcher install.sh writes, which names the
Python interpreter install found; foxlatch/paths.py says where every file is.
"""

from __future__ import annotations

import configparser
import fcntl
import hashlib
import json
import math
import os
import re
import shutil
import socket
import sqlite3
import stat
import struct
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from foxlatch import paths  # noqa: E402

PROTOCOL = 2
PATHS = paths.resolve()
RUN_DIR = PATHS.run
APPROVALS_VERSION = 1
CONFIG = PATHS.config
BUILD_NAME = re.compile(r"^[a-z]{1,32}$")
DEFAULT_TIMEOUT_S = 60
# Firefox drops the native port on a host-to-add-on message over 1 MB, which
# would end every session's control; refuse anything near that instead.
MAX_TO_FIREFOX_BYTES = 900_000
# A navigate that waits for the user (100 s) and then for its waitFor (60 s).
MAX_TIMEOUT_S = 210
SESSION_ID = re.compile(r"^[0-9a-f]{32}$")
# What one socket connection may cost the host before and after its hello. A
# line past its limit is refused once the limit is passed, never read whole.
MAX_HELLO_BYTES = 128 * 1024
MAX_LINE_BYTES = MAX_TO_FIREFOX_BYTES
HELLO_TIMEOUT_S = 5
MAX_CONNECTIONS = 32
MAX_IN_FLIGHT = 16  # requests one connection may have waiting on Firefox at once
# Request worker threads alive at once across every connection. A worker
# outlives its connection while it waits on Firefox (up to MAX_TIMEOUT_S), so
# the per-connection count alone let hanging up and reconnecting multiply them.
MAX_WORKERS = 64
# The hello and every answer to a remember or forget carry the whole list of
# remembered approvals, so it is held well under what Firefox takes: at most
# this many entries, and this many bytes as sent (json.dumps, as Firefox.send).
# core.js holds the same count as MAX_APPROVALS. A file past either was not
# written by this host and is moved aside.
MAX_APPROVALS = 500
MAX_APPROVALS_BYTES = 256 * 1024
MAX_APPROVALS_FILE_BYTES = 4 * MAX_APPROVALS_BYTES  # read no more than this; the file is indented
# A project is a canonical full path (mcp/server.py project_of); core.js MAX_PROJECT_CHARS.
MAX_PROJECT_CHARS = 400


def log(*args):
    print("foxlatch host:", *args, file=sys.stderr, flush=True)


# ---------- which profile started us ----------

# Firefox's profile lock on macOS and Linux (parent.lock is the Windows name).
LOCK_FILES = ("/.parentlock",)


def profile_dir_of(pid: int, system: str = PATHS.system, proc: Path = Path("/proc")) -> Path | None:
    """The profile directory Firefox process `pid` has locked, read from its
    open files: /proc/<pid>/fd on Linux, lsof on macOS (it has no /proc, and
    lsof ships with it). None, with a log line saying why, if they cannot
    be read; the host then serves the profile as unidentified."""
    if system == "linux":
        fd_dir = proc / str(pid) / "fd"
        try:
            fds = os.listdir(fd_dir)
        except OSError as e:
            log(f"cannot read {fd_dir} to tell which profile started this host ({e.strerror or e})")
            return None
        for fd in fds:
            try:
                target = os.readlink(fd_dir / fd)
            except OSError:
                continue  # closed since the listing
            if target.endswith(LOCK_FILES):
                return Path(target).parent
        return None
    # The system's own first: PATH comes from Firefox's environment.
    lsof = next((p for p in ("/usr/sbin/lsof", "/usr/bin/lsof") if os.access(p, os.X_OK)), None) or shutil.which("lsof")
    if lsof is None:
        log("cannot tell which profile started this host: lsof is not in /usr/sbin, /usr/bin or on PATH")
        return None
    try:
        out = subprocess.run([lsof, "-a", "-p", str(pid), "-Fn"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.TimeoutExpired) as e:
        log(f"cannot tell which profile started this host: {lsof} failed ({e})")
        return None
    for line in out.splitlines():
        if line.startswith("n") and line.endswith(LOCK_FILES):
            return Path(line[1:]).parent
    return None


def _salt_stripped(profile_dir: Path) -> str:
    """Firefox names profile directories '<8 random chars>.<name>'."""
    salt, dot, rest = profile_dir.name.partition(".")
    return rest if dot and rest and len(salt) == 8 and salt.isalnum() else profile_dir.name


def _same(a: Path, b: Path) -> bool:
    try:
        return a.resolve() == b.resolve()
    except OSError:
        return False


def profile_name(profile_dir: Path, root: Path | None = None) -> str:
    """The name Firefox shows for `profile_dir`, from `root` or each of the
    platform's Firefox directories (paths.Paths.firefox_roots) in turn.

    Profiles from the classic profile manager are named in profiles.ini; those
    created with Firefox's newer profile switcher are named in a
    "Profile Groups" SQLite store instead. Falls back to the directory name
    without its random prefix.
    """
    for r in (root,) if root is not None else PATHS.firefox_roots:
        name = _named_in(profile_dir, r)
        if name:
            return name
    return _salt_stripped(profile_dir)


def _named_in(profile_dir: Path, root: Path) -> str | None:
    parser = configparser.ConfigParser(interpolation=None)
    try:
        parser.read(root / "profiles.ini", encoding="utf-8")
    except (OSError, configparser.Error):
        pass
    for section in parser.sections():
        path = parser.get(section, "Path", fallback=None)
        if path:
            full = root / path if parser.get(section, "IsRelative", fallback="1") == "1" else Path(path)
            if _same(full, profile_dir) and parser.get(section, "Name", fallback=None):
                return parser.get(section, "Name")
    for store in sorted((root / "Profile Groups").glob("*.sqlite")):
        try:
            with sqlite3.connect(f"{store.as_uri()}?mode=ro", uri=True, timeout=1) as db:
                rows = db.execute("SELECT path, name FROM Profiles").fetchall()
        except sqlite3.Error:
            continue
        for path, name in rows:
            if path and name and (_same(root / path, profile_dir) or _same(Path(path), profile_dir)):
                return str(name)
    return None


def resolve_profile(ppid: int) -> dict:
    override = os.environ.get("FOXLATCH_PROFILE")  # test hook: "name\tdir"
    if override:
        name, _, directory = override.partition("\t")
        return {"name": name, "dir": directory or name}
    directory = profile_dir_of(ppid)
    if directory is None:
        # The pairing code shown inside the profile is what proves identity;
        # this name is only a label. Keep serving, under a label that says so.
        # identified False: a pid names no profile for long (a later Firefox,
        # another profile, can get the same one), so Host keeps no approvals file.
        return {"name": f"unidentified profile (Firefox pid {ppid})", "dir": f"pid-{ppid}", "identified": False}
    return {"name": profile_name(directory), "dir": str(directory)}


def socket_key(profile: dict) -> str:
    return hashlib.sha256(profile["dir"].encode()).hexdigest()[:16]


CONFIG_KEYS = ("deny", "protect", "exclusive")


def host_problem(h: object) -> str | None:
    """Why `h` is not a bare host name as config.json takes it, or None. The
    add-on turns a good one into the form page URLs use (lowercase, IDN as
    punycode) and refuses anything else, so the two never disagree on a host."""
    if not isinstance(h, str) or not h.strip():
        return "is not a host name"
    h = h.strip()
    if "://" in h:
        return "has a scheme; write the host name alone, like portal.example.com"
    if "/" in h:
        return "has a path; write the host name alone, like portal.example.com"
    if "*" in h:
        return "has a wildcard; a host already covers its subdomains"
    if ":" in h:
        return "has a port; write the host name alone, like portal.example.com"
    if re.search(r"[\s?#@\\\[\]%]", h):
        return "is not a host name"
    return None


def load_config(path: Path = CONFIG) -> tuple[dict, str | None]:
    """config.json's lists, and what is wrong with the file, if anything:
    "deny" (always refused), "protect" (asks the user first) and "exclusive"
    (one session at a time; an entry may be a list of hosts that share one
    sign-in, locked as one). The add-on adds its built-in protected sites
    itself. A missing file is an empty config. Anything else wrong (it does
    not parse, a key or entry it does not know) is an error, and control is
    refused until it is fixed: skipping a bad part would drop its rules."""
    empty = {k: [] for k in CONFIG_KEYS}
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return empty, None
    except (OSError, ValueError) as e:
        return empty, f"it could not be read ({e})"
    try:
        data = json.loads(text)
    except (ValueError, RecursionError) as e:
        return empty, f"it is not valid JSON ({e})"
    if not isinstance(data, dict):
        return empty, "it is not a JSON object of deny, protect and exclusive lists"
    unknown = sorted(set(data) - set(CONFIG_KEYS))
    if unknown:
        return empty, f"it has the key {json.dumps(unknown[0])}, which it does not know (it takes deny, protect and exclusive)"
    lists = {}
    for key in CONFIG_KEYS:
        items = data.get(key, [])
        if not isinstance(items, list):
            return empty, f'"{key}" is not a list of host names'
        for item in items:
            if key == "exclusive" and isinstance(item, list) and not item:
                return empty, 'an "exclusive" group is empty'
            for h in item if key == "exclusive" and isinstance(item, list) else [item]:
                problem = host_problem(h)
                if problem:
                    return empty, f'"{key}" entry {json.dumps(h)[:80]} {problem}'
        lists[key] = items
    return lists, None


ENTRY_FIELDS = {"site": ("project", "kind", "site", "added", "label"),
                "function": ("project", "kind", "origin", "sha256", "added", "label")}
ENTRY_KEY = {"site": ("project", "kind", "site"), "function": ("project", "kind", "origin", "sha256")}
SITE = re.compile(r"^[a-z0-9.-]{1,253}$")
ORIGIN = re.compile(r"^https?://[^\s/?#]{1,300}$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def project_ok(project: object) -> bool:
    """A project as core.js projectPath takes it: an absolute path in
    canonical form, one plain line, no longer than MAX_PROJECT_CHARS."""
    if not (isinstance(project, str) and project.startswith("/") and len(project) <= MAX_PROJECT_CHARS):
        return False
    if any(unicodedata.category(ch) in ("Cc", "Cf", "Zl", "Zp") for ch in project):
        return False
    return project == "/" or all(part not in ("", ".", "..") for part in project.split("/")[1:])


def entry_key(entry: dict | object) -> tuple | None:
    """What makes two remembered approvals the same one, or None if `entry`
    names no approval: a project and a site, or a project, an origin and the
    SHA-256 of a function's code."""
    if not isinstance(entry, dict) or entry.get("kind") not in ENTRY_KEY:
        return None
    kind = entry["kind"]
    if not project_ok(entry.get("project")):
        return None
    if kind == "site":
        ok = isinstance(entry.get("site"), str) and SITE.match(entry["site"])
    else:
        ok = isinstance(entry.get("origin"), str) and ORIGIN.match(entry["origin"]) \
            and isinstance(entry.get("sha256"), str) and SHA256.match(entry["sha256"])
    return tuple(entry[k] for k in ENTRY_KEY[kind]) if ok else None


def valid_entry(entry: object) -> dict | None:
    """A whole remembered approval, exactly its fields, or None."""
    if entry_key(entry) is None or set(entry) != set(ENTRY_FIELDS[entry["kind"]]):
        return None
    added, label = entry["added"], entry["label"]
    if not (isinstance(added, int) and not isinstance(added, bool) and added >= 0 and isinstance(label, str) and len(label) <= 80):
        return None
    return {k: entry[k] for k in ENTRY_FIELDS[entry["kind"]]}


def approvals_size(approvals: list[dict]) -> int:
    """The bytes the list takes in a message to Firefox."""
    return len(json.dumps(approvals).encode())


def read_approvals(path: Path) -> tuple[list[dict], str | None]:
    """The approvals in `path`, and what is wrong with the file if it cannot
    be used (None if it can). A missing file is none and nothing wrong. One
    that is not a regular file, does not parse, is another version, holds an
    entry that is not a valid approval, or is past the caps, is unusable: no
    approval in it stands (fail closed: the user is asked), and the caller
    moves it aside rather than write over it."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return [], None
    except OSError as e:
        return [], f"could not be opened ({e.strerror or e})"
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return [], "is not a regular file"
        raw, chunk = b"", b"x"
        while chunk and len(raw) <= MAX_APPROVALS_FILE_BYTES:
            chunk = os.read(fd, 65536)
            raw += chunk
    except OSError as e:
        return [], f"could not be read ({e.strerror or e})"
    finally:
        os.close(fd)
    if len(raw) > MAX_APPROVALS_FILE_BYTES:
        return [], f"is over {MAX_APPROVALS_FILE_BYTES} bytes"
    try:
        data = json.loads(raw)
    except (ValueError, RecursionError) as e:
        return [], f"is not valid JSON ({e})"
    if not (isinstance(data, dict) and data.get("version") == APPROVALS_VERSION and isinstance(data.get("approvals"), list)):
        return [], f"is not a version {APPROVALS_VERSION} approvals file"
    entries = [valid_entry(e) for e in data["approvals"]]
    if None in entries:
        return [], "holds an entry that is not a valid approval"
    seen, out = set(), []
    for e in entries:
        if entry_key(e) not in seen:
            seen.add(entry_key(e))
            out.append(e)
    if len(out) > MAX_APPROVALS or approvals_size(out) > MAX_APPROVALS_BYTES:
        return [], f"holds more than {MAX_APPROVALS} approvals or {MAX_APPROVALS_BYTES // 1024} KB of them"
    return out, None


def move_aside(path: Path) -> Path:
    """Renames an unusable approvals file to <name>.bad-<UTC time>, beside it
    and private (0600), never over another; returns where it went."""
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    for n in range(1000):
        dest = path.with_name(f"{path.name}.bad-{stamp}" + (f"-{n}" if n else ""))
        if os.path.lexists(dest):
            continue
        os.rename(path, dest)
        if not dest.is_symlink():
            try:
                os.chmod(dest, 0o600)
            except OSError as e:
                log(f"could not make {dest} private:", e)
        return dest
    raise OSError(f"no free name beside {path}")


def write_approvals(path: Path, approvals: list[dict]) -> None:
    """Replaces `path` with `approvals` so that a reader, or a crash at any
    point, sees the old file or the new one whole: a fresh temp file (0600)
    beside it, written and fsynced, renamed over it, and the directory
    fsynced so the rename itself survives."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.unlink(missing_ok=True)  # left by a host that died mid-write
    data = json.dumps({"version": APPROVALS_VERSION, "approvals": approvals}, indent=1).encode()
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        try:
            view = memoryview(data)
            while view:
                view = view[os.write(fd, view):]
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    dfd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


def req_timeout(value) -> float:
    """A request's timeout in seconds: a finite positive number, capped, or
    the default. Event.wait(NaN) returns at once, which would report a
    timeout while Firefox goes on to act."""
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0
    return min(float(value), MAX_TIMEOUT_S) if ok else DEFAULT_TIMEOUT_S


# ---------- the Firefox side ----------

class Firefox:
    """Native messaging framing over a pair of binary streams."""

    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.lock = threading.Lock()

    def send(self, msg: dict) -> None:
        data = json.dumps(msg).encode()
        with self.lock:
            try:
                self.writer.write(struct.pack("=I", len(data)) + data)
                self.writer.flush()
            except ValueError as e:  # the stream was closed under us: the port is gone, as a broken pipe is
                raise BrokenPipeError(str(e)) from e

    def receive(self) -> dict | None:
        head = self.reader.read(4)
        if len(head) < 4:
            return None
        (length,) = struct.unpack("=I", head)
        body = self.reader.read(length)
        if len(body) < length:
            return None
        return json.loads(body)


class LineTooLong(Exception):
    """A line went past its limit; `head` is how it starts. The rest of it is still unread."""

    def __init__(self, head: bytes):
        super().__init__("line too long")
        self.head = head


class Lines:
    """Newline-ended lines from a socket, each read only up to the limit the
    caller gives, so a session cannot make the host hold an endless line."""

    def __init__(self, conn: socket.socket):
        self.conn, self.buf = conn, bytearray()

    def _recv(self, deadline: float | None) -> bytes:
        if deadline is None:
            self.conn.settimeout(None)
        else:
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError("deadline passed")
            self.conn.settimeout(left)
        return self.conn.recv(65536)

    def read(self, limit: int, deadline: float | None = None) -> bytes | None:
        """The next line, None at the end of the stream. Raises LineTooLong
        once the line passes `limit` bytes (call skip to drop the rest), and
        TimeoutError if no whole line came by `deadline` (time.monotonic)."""
        while True:
            end = self.buf.find(b"\n")
            if end > limit or (end < 0 and len(self.buf) > limit):
                raise LineTooLong(bytes(self.buf[:64]))
            if end >= 0:
                line = bytes(self.buf[:end + 1])
                del self.buf[:end + 1]
                return line
            chunk = self._recv(deadline)
            if not chunk:
                line, self.buf = bytes(self.buf), bytearray()
                return line or None
            self.buf += chunk

    def skip(self) -> bool:
        """Drops the rest of the current line, holding no more than a chunk
        of it at a time; False if the stream ended first."""
        while (end := self.buf.find(b"\n")) < 0:
            self.buf.clear()
            chunk = self._recv(None)
            if not chunk:
                return False
            self.buf += chunk
        del self.buf[:end + 1]
        return True


def request_id_in(head: bytes) -> int | None:
    """The id of a request from how its line starts, as mcp/server.py writes it."""
    m = re.match(rb'\s*\{\s*"id"\s*:\s*(-?\d{1,15})\s*[,}]', head)
    return int(m.group(1)) if m else None


class Host:
    def __init__(self, firefox: Firefox, profile: dict, deny: list[str], run_dir: Path = RUN_DIR, protect: list[str] | None = None,
                 exclusive: list[str | list[str]] | None = None, approvals_dir: Path | None = None, config_error: str | None = None,
                 system: str = PATHS.system, socket_root: Path = paths.SOCKET_FALLBACK_ROOT):
        self.firefox = firefox
        self.profile = profile
        self.deny = deny
        self.protect = protect or []
        self.exclusive = exclusive or []
        # What is wrong with config.json; the add-on refuses control while it is set.
        self.config_error = config_error
        self.hello_timeout_s = HELLO_TIMEOUT_S
        self.max_connections = MAX_CONNECTIONS
        self.max_in_flight = MAX_IN_FLIGHT
        self.max_workers = MAX_WORKERS
        self.connections = 0
        self.workers = 0  # request worker threads alive, under self.lock; freed only as each exits
        self.run_dir = run_dir
        key = socket_key(profile)
        self.key = key
        self.profile_lock: int | None = None  # the fd holding this profile, while this host serves it
        # How long to wait for the profile's lock: after a reload the host
        # before this one may still be exiting.
        self.claim_wait_s = 5.0
        # In run_dir if the path fits AF_UNIX's limit, else under socket_root; the registry says which.
        self.sock_path = paths.socket_path(run_dir, key, system, socket_root)
        self.registry_path = run_dir / f"{key}.json"
        # What the add-on said of itself in its hello: {build, scripts}, for the registry.
        self.addon: dict | None = None
        # Beside run/ in the state directory unless given: one file per profile, this host its one writer.
        self.approvals_path = (approvals_dir or run_dir.parent / "approvals") / f"{key}.json"
        self.approvals: list[dict] = []
        # Why no remember or forget may be written: the file could not be read
        # and could not be moved aside, so a write would destroy it.
        self.approvals_blocked: str | None = None
        self.lock = threading.Lock()
        self.pending: dict[int, dict] = {}
        self.sessions: set[str] = set()
        self.next_id = 0
        self.server: socket.socket | None = None

    # Firefox -> sessions
    def pump_firefox(self) -> None:
        while True:
            msg = self.firefox.receive()
            if msg is None:
                return
            if isinstance(msg, dict) and msg.get("type") == "hello":
                self.addon_hello(msg)
                continue
            if isinstance(msg, dict) and msg.get("type") in ("remember", "forget"):
                # In this thread, one at a time: answers go back in the order asked.
                self.change_approvals(msg["type"], msg.get("entry"))
                continue
            with self.lock:
                slot = self.pending.get(msg.get("id"))
            if slot is not None:
                slot["reply"] = msg
                slot["event"].set()

    def addon_hello(self, msg: dict) -> None:
        """The add-on's build, for agents to read before they connect: a
        build without scripts lists no eval, define or call. Only a hint to
        them; the add-on itself refuses what its build lacks."""
        build, scripts = msg.get("build"), msg.get("scripts")
        if not (isinstance(build, str) and BUILD_NAME.match(build) and isinstance(scripts, bool)):
            return log(f"ignored an add-on hello that does not say its build: {json.dumps(msg)[:200]}")
        self.addon = {"build": build, "scripts": scripts}
        if self.profile_lock is None:
            return  # refused: the registry is the serving host's
        try:
            self.write_registry()
        except OSError as e:
            log(f"could not write {self.registry_path}:", e)

    def change_approvals(self, op: str, entry: object) -> None:
        """Remember or forget one approval, from the add-on only (a session's
        requests reach the add-on as tool calls, never here). The file is
        written first; self.approvals, and the answer's list, change only
        once it is. Answers {type: remembered, approvals, did, error?}."""
        did = {"type": op, "entry": entry}
        if self.approvals_blocked:
            return self.firefox.send({"type": "remembered", "approvals": self.approvals, "did": did, "error": self.approvals_blocked})
        if op == "remember":
            new = valid_entry(entry)
            if new is None:
                return self.firefox.send({"type": "remembered", "approvals": self.approvals, "did": did, "error": "not a valid entry"})
            keep = self.approvals if any(entry_key(e) == entry_key(new) for e in self.approvals) else [*self.approvals, new]
            full = (f"{MAX_APPROVALS} remembered approvals is the most" if len(keep) > MAX_APPROVALS
                    else f"the remembered approvals would pass {MAX_APPROVALS_BYTES // 1024} KB" if approvals_size(keep) > MAX_APPROVALS_BYTES
                    else None)
            if full:
                return self.firefox.send({"type": "remembered", "approvals": self.approvals, "did": did, "error": f"{full}; forget some in the toolbar first"})
        else:
            key = entry_key(entry)
            if key is None:
                return self.firefox.send({"type": "remembered", "approvals": self.approvals, "did": did, "error": "not a valid entry"})
            keep = [e for e in self.approvals if entry_key(e) != key]
        if keep != self.approvals:
            try:
                write_approvals(self.approvals_path, keep)
            except OSError as e:
                log(f"could not write {self.approvals_path}:", e)
                return self.firefox.send({"type": "remembered", "approvals": self.approvals, "did": did, "error": f"could not save: {e}"})
            self.approvals = keep
        self.firefox.send({"type": "remembered", "approvals": self.approvals, "did": did})

    def load_approvals(self) -> tuple[list[dict], str | None]:
        """The approvals file at start, and what the add-on should tell the user
        about it. An unusable file is moved aside, never written over (that
        would lose every approval in it without a word), and a fresh one
        starts with the next remember. One that cannot be moved aside blocks
        every write until it is fixed."""
        if self.profile.get("identified") is False:
            # Its key is Firefox's pid: another profile's Firefox may have had it.
            self.approvals_blocked = ("this Firefox profile could not be identified, so nothing is remembered "
                                      "or forgotten here (another profile's approvals file could be under its key)")
            return [], self.approvals_blocked
        approvals, problem = read_approvals(self.approvals_path)
        if problem is None:
            return approvals, None
        try:
            dest = move_aside(self.approvals_path)
        except OSError as e:
            self.approvals_blocked = (f"{self.approvals_path} {problem}, and it could not be moved aside ({e.strerror or e}), "
                                      "so nothing can be remembered or forgotten until it is fixed")
            log(self.approvals_blocked)
            return [], self.approvals_blocked
        log(f"{self.approvals_path} {problem}; moved it to {dest} and started a fresh one")
        return [], f"the file {problem}; it was moved aside to {dest}"

    # sessions -> Firefox
    def call(self, session_id: str, method: str, params: dict, timeout: float) -> dict:
        with self.lock:
            self.next_id += 1
            rid = self.next_id
            slot = self.pending[rid] = {"event": threading.Event(), "reply": None}
        try:
            msg = {"id": rid, "sessionId": session_id, "method": method, "params": params}
            size = len(json.dumps(msg).encode())
            if size > MAX_TO_FIREFOX_BYTES:
                return {"ok": False, "error": f"request is {size} bytes; the limit is {MAX_TO_FIREFOX_BYTES}"}
            self.firefox.send(msg)
            if not slot["event"].wait(timeout):
                return {"ok": False, "error": f"Firefox did not answer {method} within {timeout:.0f}s "
                                              "(the page may be showing a dialog, or Firefox is busy)"}
            reply = slot["reply"]
            return {"ok": bool(reply.get("ok")), **({"result": reply.get("result")} if reply.get("ok") else {"error": reply.get("error", "unknown error")})}
        finally:
            with self.lock:
                self.pending.pop(rid, None)

    def serve_connection(self, conn: socket.socket) -> None:
        session_id = None
        write_lock = threading.Lock()
        in_flight = [0]  # this connection's requests waiting on Firefox, under self.lock
        with conn, conn.makefile("wb") as wfile:
            def send(obj):
                with write_lock:
                    wfile.write(json.dumps(obj).encode() + b"\n")
                    wfile.flush()

            lines = Lines(conn)
            try:
                try:
                    first = lines.read(MAX_HELLO_BYTES, time.monotonic() + self.hello_timeout_s)
                except LineTooLong:
                    conn.settimeout(1)
                    return send({"ok": False, "error": f"expected hello: the first line is over {MAX_HELLO_BYTES} bytes"})
                except TimeoutError:
                    conn.settimeout(1)
                    return send({"ok": False, "error": f"expected hello within {self.hello_timeout_s:g} s of connecting"})
                conn.settimeout(None)
                try:
                    parsed = json.loads(first) if first else None
                except (ValueError, RecursionError):
                    parsed = None
                hello = parsed.get("hello") if isinstance(parsed, dict) else None
                if not isinstance(hello, dict):
                    return send({"ok": False, "error": "expected hello"})
                if hello.get("protocol") != PROTOCOL:
                    return send({"ok": False, "error": f"protocol {hello.get('protocol')} not supported; host speaks {PROTOCOL}"})
                sid = str(hello.get("sessionId", ""))
                if not SESSION_ID.match(sid):
                    return send({"ok": False, "error": "bad session id"})
                with self.lock:
                    if sid in self.sessions:
                        return send({"ok": False, "error": "that session is already connected"})
                    self.sessions.add(sid)
                session_id = sid
                # Passed on whole or not at all: the add-on checks it is a path,
                # and approvals are kept under the exact string.
                project = hello.get("project")
                project = project if isinstance(project, str) and len(project) <= MAX_PROJECT_CHARS else ""
                self.firefox.send({"type": "opened", "sessionId": session_id, "project": project})
                send({"ok": True, "profile": self.profile})

                while True:
                    try:
                        line = lines.read(MAX_LINE_BYTES)
                    except LineTooLong as e:
                        send({"id": request_id_in(e.head), "ok": False,
                              "error": f"request is over {MAX_LINE_BYTES} bytes; the limit is {MAX_LINE_BYTES}"})
                        if not lines.skip():
                            break
                        continue
                    if line is None:
                        break
                    try:
                        req = json.loads(line)
                        if not isinstance(req, dict):
                            raise TypeError("a request is a JSON object")
                        rid, method = req["id"], str(req["method"])
                        params = req.get("params") or {}
                        if not isinstance(params, dict):
                            raise TypeError("params is a JSON object")
                        timeout = req_timeout(req.get("timeout"))
                    except (ValueError, KeyError, TypeError, RecursionError) as e:
                        send({"id": None, "ok": False, "error": f"bad request: {e}"})
                        continue

                    # Counted here and freed only as the worker exits, which may
                    # be after this connection closes: the host-wide count is the bound.
                    with self.lock:
                        full = (f"too many requests in flight on this connection ({self.max_in_flight}); "
                                "wait for an answer before sending more") if in_flight[0] >= self.max_in_flight \
                            else (f"too many requests waiting on Firefox across this profile's sessions ({self.max_workers}); "
                                  "wait for an answer before sending more") if self.workers >= self.max_workers \
                            else None
                        if not full:
                            in_flight[0] += 1
                            self.workers += 1
                    if full:
                        send({"id": rid, "ok": False, "error": full})
                        continue

                    def done():
                        with self.lock:
                            in_flight[0] -= 1
                            self.workers -= 1

                    def work(rid=rid, method=method, params=params, timeout=timeout):
                        try:
                            reply = self.call(session_id, method, params, timeout)
                            try:
                                send({"id": rid, **reply})
                            except (OSError, ValueError):
                                pass  # the session hung up before the answer came
                        finally:
                            done()

                    try:
                        threading.Thread(target=work, daemon=True).start()
                    except RuntimeError:  # the process is out of threads: the worker never ran
                        done()
                        send({"id": rid, "ok": False, "error": "the host could not start a thread for this request; try again"})
            except (OSError, ValueError, RecursionError):
                pass
            finally:
                if session_id:
                    with self.lock:
                        self.sessions.discard(session_id)
                    try:
                        self.firefox.send({"type": "closed", "sessionId": session_id})
                    except OSError:
                        pass

    def claim_profile(self) -> str | None:
        """One host per profile: two add-ons in one profile (both builds
        installed) would each start one, and the second would unlink the
        first's live socket and write the same approvals file. The lock lasts
        as long as this process. None if this host holds it, else why not."""
        self.run_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.run_dir.parent, 0o700)
        os.chmod(self.run_dir, 0o700)
        fd = os.open(self.run_dir / f"{self.key}.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        deadline = time.monotonic() + self.claim_wait_s
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() < deadline:
                    time.sleep(0.05)
                    continue
                why = (f"another Foxlatch add-on already serves {self.profile['name']} (are both the public and the personal "
                       "build installed?): keep one, remove the other in about:addons, then restart Firefox")
            except OSError as e:  # a filesystem without locks (some network homes): fail closed, and say so
                why = f"could not lock {self.run_dir / (self.key + '.lock')} ({e}), so this host cannot tell whether another serves {self.profile['name']}"
            os.close(fd)
            return why
        self.profile_lock = fd
        return None

    def listen(self) -> None:
        if self.sock_path.parent != self.run_dir:
            # The short fallback: made 0700 here, or refused unless it is a
            # real directory of this user's that only they can open.
            paths.private_dir(self.sock_path.parent)
        self.sock_path.unlink(missing_ok=True)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        old = os.umask(0o177)
        try:
            server.bind(str(self.sock_path))
        finally:
            os.umask(old)
        server.listen()
        self.server = server
        self.started = int(time.time())
        self.write_registry()

    def write_registry(self) -> None:
        tmp = self.registry_path.with_suffix(".tmp")
        tmp.write_text(json.dumps({
            "protocol": PROTOCOL, "profile": self.profile, "socket": str(self.sock_path),
            "pid": os.getpid(), "started": self.started, **(self.addon or {}),
        }))
        os.chmod(tmp, 0o600)
        tmp.replace(self.registry_path)

    def accept_loop(self) -> None:
        while True:
            try:
                conn, _ = self.server.accept()
            except OSError:
                return
            with self.lock:
                full = self.connections >= self.max_connections
                if not full:
                    self.connections += 1
            if full:
                try:
                    conn.settimeout(1)
                    conn.sendall(json.dumps({"ok": False, "error": f"too many connections to this profile's host "
                                                                   f"({self.max_connections}); end some sessions and try again"}).encode() + b"\n")
                except OSError:
                    pass
                conn.close()
                continue
            threading.Thread(target=self.serve_counted, args=(conn,), daemon=True).start()

    def serve_counted(self, conn: socket.socket) -> None:
        try:
            self.serve_connection(conn)
        finally:
            with self.lock:
                self.connections -= 1

    def cleanup(self) -> None:
        if self.server:
            self.server.close()
        if self.profile_lock is None:
            return  # another host serves this profile; its files are not ours
        # Remove our socket and registry only if a newer host has not replaced them.
        try:
            if json.loads(self.registry_path.read_text()).get("pid") == os.getpid():
                self.registry_path.unlink(missing_ok=True)
                self.sock_path.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass
        os.close(self.profile_lock)
        self.profile_lock = None

    def run(self) -> None:
        refused = self.claim_profile()
        if refused:
            # No socket, no registry, no approvals: the add-on shows why, and
            # a remember or forget from it is answered with the same reason.
            log(f"not serving: {refused}")
            self.approvals_blocked = refused
            self.firefox.send({"type": "hello", "profile": self.profile, "deny": self.deny, "refused": refused})
            self.pump_firefox()
            return
        self.listen()
        self.approvals, approvals_error = self.load_approvals()
        self.firefox.send({"type": "hello", "profile": self.profile, "deny": self.deny,
                           **({"approvalsError": approvals_error} if approvals_error else {}),
                           **({"configError": self.config_error} if self.config_error else {}),
                           **({"protect": self.protect} if self.protect else {}),
                           **({"exclusive": self.exclusive} if self.exclusive else {}),
                           **({"approvals": self.approvals} if self.approvals else {})})
        threading.Thread(target=self.accept_loop, daemon=True).start()
        log(f"serving {self.profile['name']!r} on {self.sock_path}")
        try:
            self.pump_firefox()  # returns when Firefox closes the port
        finally:
            self.cleanup()


def main() -> None:
    firefox = Firefox(sys.stdin.buffer, sys.stdout.buffer)
    config, error = load_config()
    if error:
        log(f"{CONFIG} is broken, so the add-on refuses control until it is fixed: {error}")
    try:
        Host(firefox, resolve_profile(os.getppid()), config["deny"], protect=config["protect"],
             exclusive=config["exclusive"], config_error=error).run()
    except paths.NotPrivate as e:
        log(f"not serving: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
