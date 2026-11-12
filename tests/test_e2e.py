"""End to end: the real MCP Session, the real host.py and the real add-on scripts
(core.js, page.js, background.js) in tests/harness/firefox.js, two profiles at once.

Run: python3 -m unittest discover -s tests
What this cannot see: real pages (executeScript is canned) and Firefox's own
window and permission behaviour. Those are checked live in Firefox.
"""

import json
import math
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
# The suite never reads the developer's own Foxlatch config (personal-id
# included): everything this process resolves lives in a throwaway directory.
_OWN_STATE = tempfile.TemporaryDirectory()
os.environ["FOXLATCH_STATE_DIR"] = _OWN_STATE.name
sys.path.insert(0, str(ROOT / "mcp"))
sys.path.insert(0, str(ROOT / "host"))
import host  # noqa: E402
import server  # noqa: E402
from foxlatch import build as builds  # noqa: E402

NODE = shutil.which("node")
PACKAGES: dict[str, Path] = {}  # build -> its package, unpacked (setUpModule)


def setUpModule():
    global PACKAGES_TMP
    PACKAGES_TMP = tempfile.TemporaryDirectory(dir="/tmp")
    for name in builds.BUILDS:
        d = Path(PACKAGES_TMP.name) / name
        d.mkdir()
        for file, data in builds.package_files(ROOT / "extension", name).items():
            (d / file).write_bytes(data)
        PACKAGES[name] = d


def injected_args(code: str) -> dict:
    """The JSON arguments an injected page script runs its function on (page.js pageScript)."""
    return json.loads(re.search(r"\}\)\((\{.*\})\); \}\)\(\)$", code, re.S)[1])


def tearDownModule():
    PACKAGES_TMP.cleanup()


class Profile:
    """One fake Firefox profile with the add-on, running the real host. root
    is the tree whose host and harness run; build, the add-on package it
    loads (as install.sh packages it from root's extension/)."""

    def __init__(self, state_dir: Path, name: str, directory: str, root: Path = ROOT, build: str = "personal"):
        env = {**os.environ, "FOXLATCH_STATE_DIR": str(state_dir), "PYTHON": sys.executable,
               "FOXLATCH_EXTENSION_DIR": str(PACKAGES[build]) if root == ROOT else str(root / "extension")}
        self.proc = subprocess.Popen([NODE, str(root / "tests/harness/firefox.js"), name, directory],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=env, text=True)
        self.events: queue.Queue = queue.Queue()
        self.replies: queue.Queue = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        self.wait_event("ready")

    def _pump(self):
        for line in self.proc.stdout:
            msg = json.loads(line)
            (self.replies if "reply" in msg else self.events).put(msg)

    def wait_event(self, kind: str, timeout: float = 10) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                msg = self.events.get(timeout=deadline - time.time())
            except queue.Empty:
                break
            if msg.get("event") == kind:
                return msg
        raise AssertionError(f"no {kind} event")

    def cmd(self, **c):
        self.proc.stdin.write(json.dumps(c) + "\n")
        self.proc.stdin.flush()
        return self.replies.get(timeout=10)["reply"]

    def stop(self):
        self.proc.terminate()
        self.proc.wait(5)
        self.proc.stdin.close()
        self.proc.stdout.close()


def wait_until(check, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check():
            return True
        time.sleep(0.05)
    return False


@unittest.skipUnless(NODE, "node is required for the add-on harness")
class EndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.state = Path(self.tmp.name)
        self.run_dir = self.state / "run"
        # the user's config: one session at a time on the portal, as in their own,
        # and a portal that signs in through another host, as one lock.
        (self.state / "config.json").write_text(json.dumps({"exclusive": ["benefits.example.gov", ["portal.test", "login.idp.test"]]}))
        self.work = Profile(self.state, "Profile 4", "/profiles/s05tgCMm.Profile 4")
        self.personal = Profile(self.state, "default-release", "/profiles/4kvaja97.default-release")
        self.sessions = []

    def tearDown(self):
        for s in self.sessions:
            if s.conn:
                s.conn.close()
        self.work.stop()
        self.personal.stop()
        self.tmp.cleanup()

    def session(self, project="acme"):
        s = server.Session(run_dir=self.run_dir, cwd=f"/home/user/Projects/{project}")
        self.sessions.append(s)
        return s

    def call(self, s, name, **args):
        # As a client sends it, so every call here also passes the schema check
        # (eval and define require a purpose, which these tests do not vary).
        if name in ("eval", "define"):
            args.setdefault("purpose", "Checks the page for the test.")
        reply = server.handle(s, {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}})
        out = reply["result"]
        text = out["content"][0].get("text", "")
        return text, out.get("isError", False)

    def call_in_background(self, s, name, **args):
        """Starts a tool call that waits on the user; join() returns (text, is_error)."""
        box = {}
        t = threading.Thread(target=lambda: box.update(out=self.call(s, name, **args)), daemon=True)
        t.start()

        def join(timeout=10):
            t.join(timeout)
            self.assertFalse(t.is_alive(), f"{name} still waiting")
            return box["out"]
        join.running = t.is_alive
        return join

    def direct(self, s, name, **args):
        """A call past the schema check, as no client can send it: for the
        add-on's own limits, which stand behind that check."""
        out = server.run_tool(s, name, args)
        return out["content"][0].get("text", ""), out.get("isError", False)

    def ask(self, s, name, **args):
        """eval or define: returns at once, before the user answers, with the id
        of the question it put to them."""
        started = time.time()
        text, err = self.call(s, name, **args)
        self.assertFalse(err, text)
        self.assertLess(time.time() - started, 10, f"{name} waited for the user")  # it used to wait up to 100 s
        found = re.search(r'await_approval with question "(r\d+)"', text)
        self.assertIsNotNone(found, text)
        return found[1]

    def answer(self, s, question, timeout=5):
        """await_approval on a question: (text, is_error)."""
        return self.call(s, "await_approval", question=question, timeout_seconds=timeout)

    def pair(self, s, profile, firefox):
        text, err = self.call(s, "connect", profile=profile)
        self.assertFalse(err, text)
        shown = firefox.wait_event("confirm")
        self.assertEqual(shown["sessionId"], s.id)
        self.assertTrue(shown["inUsersWindow"])  # beside their own tabs, not a floating window
        self.assertIn(shown["code"], text)  # the chat shows the code the profile shows
        decided = firefox.cmd(cmd="decide", sessionId=s.id, approve=True)
        self.assertFalse(decided["confirmTabOpen"])  # the add-on closed the confirm tab
        text, err = self.call(s, "await_approval", timeout_seconds=5)
        self.assertIn("Connected", text)

    # ---- tests ----

    def test_profiles_are_listed_separately_with_their_status(self):
        s = self.session()
        text, _ = self.call(s, "profiles")
        self.assertIn("Profile 4", text)
        self.assertIn("default-release", text)
        self.assertEqual(text.count("free"), 2)

    def test_nothing_works_before_the_user_allows_it_and_a_page_cannot_allow_it(self):
        s = self.session()
        text, err = self.call(s, "open", url="https://example.com/")
        self.assertTrue(err)
        self.assertIn("no Firefox profile chosen", text)
        self.call(s, "connect", profile="Profile 4")
        self.work.wait_event("confirm")
        text, err = self.call(s, "open", url="https://example.com/")
        self.assertTrue(err)
        self.assertIn("not connected", text)
        self.assertIsNone(self.work.cmd(cmd="spoof", sessionId=s.id))  # ignored, not even refused
        self.assertEqual(len(self.work.cmd(cmd="view")["pending"]), 1)
        text, _ = self.call(s, "await_approval", timeout_seconds=5)
        self.assertIn("Still waiting", text)
        self.assertEqual(self.work.cmd(cmd="scripts"), [])

    def test_a_wrong_code_is_refused(self):
        s = self.session()
        self.call(s, "connect", profile="Profile 4")
        self.work.wait_event("confirm")
        reply = self.work.cmd(cmd="decide", sessionId=s.id, code="000 000", approve=True)
        self.assertFalse(reply["ok"])
        text, err = self.call(s, "tabs")
        self.assertTrue(err)

    def test_paired_session_drives_only_its_profile_and_its_tabs(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        text, err = self.call(s, "open", url="https://search.google.com/search-console")
        self.assertFalse(err, text)
        tab = json.loads(text)["tabId"]
        text, err = self.call(s, "snapshot", tabId=tab)
        self.assertIn('e1 button "Request indexing"', text)
        text, err = self.call(s, "click", tabId=tab, ref="e1")
        self.assertFalse(err, text)
        self.assertEqual(self.personal.cmd(cmd="scripts"), [])  # nothing ran in the other profile
        self.assertEqual(self.personal.cmd(cmd="view")["leases"], [])
        text, err = self.call(s, "click", tabId=tab + 1000, ref="e1")
        self.assertTrue(err)
        self.assertIn("not one of this session's tabs", text)
        self.assertIn("Foxlatch · acme", self.work.cmd(cmd="titles")[-1])

    def test_refused_urls_never_reach_a_page(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        for url in ["javascript:alert(1)", "about:config", "file:///etc/hosts"]:
            text, err = self.call(s, "open", url=url)
            self.assertTrue(err, url)
            self.assertIn("refused", text)
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        join = self.call_in_background(s, "navigate", tabId=tab, url="https://outlook.office.com/mail/")
        asked = self.work.wait_event("ask")
        self.work.cmd(cmd="closeAsk", id=asked["id"])  # closing the question is a no
        text, err = join()
        self.assertTrue(err)
        self.assertIn("did not allow", text)
        self.assertEqual([x["url"] for x in self.work.cmd(cmd="scripts")], [])

    def test_a_protected_site_waits_for_the_user_and_the_answer_stays_with_that_session_and_site(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        join = self.call_in_background(s, "open", url="https://mail.google.com/mail/u/0/")
        asked = self.work.wait_event("ask")
        self.assertEqual((asked["kind"], asked["subject"]), ("site", "mail.google.com"))
        self.assertTrue(asked["inUsersWindow"])  # the session has no window of its own yet
        self.assertIsNone(self.work.cmd(cmd="spoofAnswer", id=asked["id"]))  # a page cannot answer
        self.assertEqual(len(self.work.cmd(cmd="view")["requests"]), 1)
        self.assertTrue(self.work.cmd(cmd="answer", id=asked["id"], approve=True)["ok"])
        text, err = join()
        self.assertFalse(err, text)
        tab = json.loads(text)["tabId"]
        self.assertFalse(self.call(s, "snapshot", tabId=tab)[1])
        self.assertFalse(self.call(s, "open", url="https://mail.google.com/mail/u/1/")[1])  # no second question
        self.assertEqual(self.work.cmd(cmd="view")["leases"][0]["sites"], ["mail.google.com"])
        # Control ends: the next lease starts with nothing allowed.
        self.work.cmd(cmd="revoke", sessionId=s.id)
        text, _ = self.call(s, "await_approval", timeout_seconds=5)
        self.assertIn("Control ended", text)
        self.pair(s, "Profile 4", self.work)
        join = self.call_in_background(s, "open", url="https://mail.google.com/")
        asked = self.work.wait_event("ask")
        self.work.cmd(cmd="answer", id=asked["id"], approve=False)
        text, err = join()
        self.assertTrue(err)
        self.assertIn("did not allow", text)

    def test_eval_runs_only_the_code_the_user_saw_and_asks_every_time(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        for approve in (True, False):
            q = self.ask(s, "eval", tabId=tab, code="document.title.length")
            asked = self.work.wait_event("ask")
            self.assertEqual((asked["id"], asked["kind"]), (q, "eval"))
            self.assertTrue(asked["inSessionWindow"])  # in front of the user as they watch, not behind it
            self.assertEqual(json.loads(asked["subject"])["code"], "document.title.length")
            self.work.cmd(cmd="answer", id=asked["id"], approve=approve)
            text, err = self.answer(s, q)
            self.assertEqual(err, not approve, text)
        ran = [x for x in self.work.cmd(cmd="scripts") if x["fn"] == "evalInPage"]
        self.assertEqual(len(ran), 1)
        args = injected_args(ran[0]["code"])
        self.assertRegex(args.pop("token"), r"^[0-9a-f]{32}$")  # the shown document's mark
        self.assertEqual(args, {"code": "document.title.length", "href": "https://example.com/"})
        text, err = self.call(s, "eval", tabId=tab, code="x" * 20001)
        self.assertTrue(err)
        self.assertIn("keep it under", text)

    def test_an_approved_function_is_asked_once_then_called_with_data_only(self):
        # A script run for every row of a long form would ask at every row. They approve
        # a function once; later calls pass only JSON data, on the same origin,
        # until the session's control ends.
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/a")[0])["tabId"]
        q = self.ask(s, "define", tabId=tab, code="(step, n) => step + n")
        asked = self.work.wait_event("ask")
        self.assertEqual(asked["kind"], "function")
        self.assertEqual(json.loads(asked["subject"])["code"], "(step, n) => step + n")
        self.work.cmd(cmd="answer", id=asked["id"], approve=True)
        text, err = self.answer(s, q)
        self.assertFalse(err, text)
        fn = json.loads(text)["fn"]

        for n in (1, 2):   # no question: a call that asked would wait 100 s
            text, err = self.call(s, "call", tabId=tab, fn=fn, args=["go", n])
            self.assertFalse(err, text)
        ran = [x["code"] for x in self.work.cmd(cmd="scripts") if x["fn"] == "evalInPage"]
        self.assertEqual(len(ran), 2)
        self.assertEqual(injected_args(ran[1]), {"code": '((step, n) => step + n)(...["go",2])', "origin": "https://example.com"})

        text, err = self.call(s, "call", tabId=tab, fn=fn, args={"not": "a list"})
        self.assertTrue(err)
        self.assertIn("args must be an array", text)
        text, err = self.direct(s, "call", tabId=tab, fn=fn, args={"not": "a list"})  # the add-on's own check
        self.assertTrue(err)
        self.assertIn("JSON array", text)
        text, err = self.call(s, "call", tabId=tab, fn="f999", args=[])
        self.assertTrue(err)
        self.assertIn("no approved function", text)
        other = json.loads(self.call(s, "open", url="https://other.example.org/")[0])["tabId"]
        text, err = self.call(s, "call", tabId=other, fn=fn, args=[])
        self.assertTrue(err)
        self.assertIn("approved on https://example.com", text)

        self.work.cmd(cmd="revoke", sessionId=s.id)
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/a")[0])["tabId"]
        text, err = self.call(s, "call", tabId=tab, fn=fn, args=[])
        self.assertTrue(err)                          # the approval ended with the control
        self.assertIn("no approved function", text)

    def test_a_refused_function_is_never_callable(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        q = self.ask(s, "define", tabId=tab, code="() => 1")
        self.work.wait_event("ask")
        self.work.cmd(cmd="answer", id=q, approve=False)
        text, err = self.answer(s, q)
        self.assertTrue(err)
        self.assertIn("did not allow", text)
        text, err = self.call(s, "call", tabId=tab, fn="f1", args=[])
        self.assertTrue(err)
        self.assertEqual([x for x in self.work.cmd(cmd="scripts") if x["fn"] == "evalInPage"], [])

    def test_a_tab_that_wanders_onto_a_protected_site_is_refused_and_hides_its_title(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        self.work.cmd(cmd="pageNavigates", tabId=tab, url="https://mail.google.com/mail/u/0/#inbox")
        text, err = self.call(s, "snapshot", tabId=tab)
        self.assertTrue(err)
        self.assertIn("protected", text)
        listed = json.loads(self.call(s, "tabs")[0])
        self.assertNotIn("title", listed[0])
        self.assertNotIn("Inbox", self.call(s, "tabs")[0])
        self.assertEqual([x for x in self.work.cmd(cmd="scripts") if "mail.google" in x["url"]], [])

    def test_a_question_ends_at_once_when_control_ends(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        q = self.ask(s, "eval", tabId=tab, code="1")
        asked = self.work.wait_event("ask")
        join = self.call_in_background(s, "await_approval", question=q, timeout_seconds=20)
        time.sleep(0.3)
        self.work.cmd(cmd="revoke", sessionId=s.id)
        text, err = join(timeout=5)
        self.assertTrue(err)
        self.assertIn("revoked", text)
        self.assertEqual(self.work.cmd(cmd="view")["requests"], [])
        self.assertFalse(self.work.cmd(cmd="answer", id=asked["id"], approve=True)["ok"])
        self.assertEqual([x for x in self.work.cmd(cmd="scripts") if x["fn"] == "evalInPage"], [])

    def test_after_a_no_the_session_cannot_ask_again_at_once(self):
        s = self.session()
        self.call(s, "connect", profile="Profile 4")
        self.work.wait_event("confirm")
        self.work.cmd(cmd="decide", sessionId=s.id, approve=False)
        text, err = self.call(s, "connect", profile="Profile 4")
        self.assertTrue(err)
        self.assertIn("said no", text)
        self.assertEqual(self.work.cmd(cmd="view")["pending"], [])
        self.assertRaises(AssertionError, self.work.wait_event, "confirm", 0.5)

    def test_two_sessions_drive_one_profile_at_once_and_each_keeps_its_own(self):
        a, b = self.session("acme"), self.session("billing")
        self.pair(a, "Profile 4", self.work)
        a_tab = json.loads(self.call(a, "open", url="https://example.com/")[0])["tabId"]
        text, err = self.call(b, "connect", profile="Profile 4")
        self.assertFalse(err, text)
        self.assertIn(f"Also driving this profile: {a.label}", text)
        self.work.wait_event("confirm")
        self.assertFalse(self.call(a, "tabs")[1])  # a keeps control while the user decides
        self.assertTrue(self.call(b, "tabs")[1])   # b waits for its own code
        self.work.cmd(cmd="decide", sessionId=b.id, approve=True)
        self.assertIn("Connected", self.call(b, "await_approval", timeout_seconds=5)[0])
        b_tab = json.loads(self.call(b, "open", url="https://example.org/b")[0])["tabId"]
        for s, tab in ((a, a_tab), (b, b_tab)):   # both act, each on its own tab
            text, err = self.call(s, "click", tabId=tab, ref="e1")
            self.assertFalse(err, text)
        text, err = self.call(b, "click", tabId=a_tab, ref="e1")
        self.assertTrue(err)
        self.assertIn("not one of this session's tabs", text)
        text, _ = self.call(a, "profiles")
        self.assertIn(f"driven by this session, {b.label}", text)
        self.assertEqual(sorted(t for t in self.work.cmd(cmd="titles") if t.startswith("Foxlatch ·")),
                         sorted([f"Foxlatch · {a.label} — ", f"Foxlatch · {b.label} — "]))  # each window its own label
        # A page in b's tab opens a tab: it is b's, not a's.
        popup = self.work.cmd(cmd="pageOpensTab", tabId=b_tab, url="https://example.org/popup")
        self.assertIn(popup, [t["tabId"] for t in json.loads(self.call(b, "tabs")[0])])
        self.assertNotIn(popup, [t["tabId"] for t in json.loads(self.call(a, "tabs")[0])])
        # the user stops a alone; b keeps its control and its tabs.
        self.work.cmd(cmd="revoke", sessionId=a.id)
        self.assertIn("revoked in Firefox", self.call(a, "tabs")[0])
        self.assertFalse(self.call(b, "click", tabId=b_tab, ref="e1")[1])
        self.assertEqual([d["label"] for d in self.work.cmd(cmd="view")["leases"]], [b.label])

    def test_a_locked_site_takes_one_session_at_a_time(self):
        a, b = self.session("acme"), self.session("billing")
        self.pair(a, "Profile 4", self.work)
        self.pair(b, "Profile 4", self.work)
        a_tab = json.loads(self.call(a, "open", url="https://benefits.example.gov/portal")[0])["tabId"]
        self.assertFalse(self.call(a, "snapshot", tabId=a_tab)[1])
        text, err = self.call(b, "open", url="https://www.benefits.example.gov/claims")
        self.assertTrue(err)
        self.assertIn(f"benefits.example.gov is in use by {a.label}", text)
        b_tab = json.loads(self.call(b, "open", url="https://example.com/")[0])["tabId"]
        text, err = self.call(b, "navigate", tabId=b_tab, url="https://benefits.example.gov/portal")
        self.assertTrue(err)
        self.assertIn("in use by", text)
        # b's page wanders there by itself: b can neither read nor act on it.
        self.work.cmd(cmd="pageNavigates", tabId=b_tab, url="https://benefits.example.gov/portal/x")
        for tool, args in (("snapshot", {}), ("click", {"ref": "e1"}), ("navigate", {"url": "reload"})):
            text, err = self.call(b, tool, tabId=b_tab, **args)
            self.assertTrue(err, tool)
            self.assertIn("in use by", text)
        self.assertEqual([x for x in self.work.cmd(cmd="scripts") if x["tabId"] == b_tab and "benefits" in x["url"]], [])
        self.assertEqual(self.work.cmd(cmd="view")["leases"][0]["locks"], ["benefits.example.gov"])
        # A locked protected site is refused before the user is asked anything.
        join = self.call_in_background(a, "open", url="https://mail.google.com/")
        self.work.cmd(cmd="answer", id=self.work.wait_event("ask")["id"], approve=True)
        self.assertFalse(join()[1])
        text, err = self.call(b, "open", url="https://mail.google.com/")
        self.assertTrue(err)
        self.assertIn(f"mail.google.com is in use by {a.label}", text)
        self.assertRaises(AssertionError, self.work.wait_event, "ask", 0.5)
        # The lock ends with a's control, and b takes the site.
        self.call(a, "release")
        self.assertFalse(self.call(b, "snapshot", tabId=b_tab)[1])
        text, err = self.call(b, "open", url="https://benefits.example.gov/portal")
        self.assertFalse(err, text)

    def test_an_exclusive_entry_of_several_hosts_is_one_lock(self):
        a, b = self.session("acme"), self.session("billing")
        self.pair(a, "Profile 4", self.work)
        self.pair(b, "Profile 4", self.work)
        self.assertFalse(self.call(a, "open", url="https://www.portal.test/claims")[1])
        text, err = self.call(b, "open", url="https://login.idp.test/")
        self.assertTrue(err)
        self.assertIn(f"login.idp.test is in use by {a.label} under the portal.test + login.idp.test lock", text)
        self.assertEqual(self.work.cmd(cmd="view")["leases"][0]["locks"], ["portal.test + login.idp.test"])

    def test_closing_the_confirm_tab_is_a_refusal(self):
        s = self.session()
        self.call(s, "connect", profile="Profile 4")
        self.work.wait_event("confirm")
        self.work.cmd(cmd="closeConfirm", sessionId=s.id)
        self.assertIn("did not allow", self.call(s, "await_approval", timeout_seconds=5)[0])

    def test_await_returns_as_soon_as_the_user_answers(self):
        s = self.session()
        self.call(s, "connect", profile="Profile 4")
        self.work.wait_event("confirm")
        threading.Timer(0.5, lambda: self.work.cmd(cmd="decide", sessionId=s.id, approve=True)).start()
        started = time.time()
        self.assertIn("Connected", self.call(s, "await_approval", timeout_seconds=20)[0])
        self.assertLess(time.time() - started, 5)

    def test_revoking_in_firefox_ends_control(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        self.work.cmd(cmd="revoke", sessionId=s.id)
        text, err = self.call(s, "tabs")
        self.assertTrue(err)
        self.assertIn("revoked in Firefox", text)

    def test_session_ending_releases_the_profile_and_marks_its_window(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        self.call(s, "open", url="https://example.com/")
        s.conn.close()  # the Claude Code session exits
        self.assertTrue(wait_until(lambda: self.work.cmd(cmd="view")["leases"] == []))
        self.assertTrue(any("ended" in t for t in self.work.cmd(cmd="titles")))

    def test_a_host_restart_fails_closed_and_needs_a_new_confirmation(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        old_pid = s.target["pid"]
        self.work.cmd(cmd="restartHost")
        self.work.wait_event("ready", timeout=15)  # the add-on reconnected and Firefox started a new host
        text, err = self.call(s, "tabs")
        self.assertTrue(err)
        self.assertIn("not connected", text)
        self.assertNotEqual(s.target["pid"], old_pid)
        self.pair(s, "Profile 4", self.work)
        self.assertFalse(self.call(s, "tabs")[1])

    # about half of 19 script questions were the same
    # billing helpers defined again after each reconnect.
    def test_a_remembered_function_survives_a_host_restart_for_its_project_only(self):
        code = "(row) => document.querySelectorAll('tr')[row].innerText"
        s = self.session("billing")
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/claims")[0])["tabId"]
        self.ask(s, "define", tabId=tab, code=code, purpose="Reads one claim row.")
        asked = self.work.wait_event("ask")
        self.work.cmd(cmd="answer", id=asked["id"], approve=True, remember=True)
        self.assertTrue(wait_until(lambda: self.work.cmd(cmd="view")["approvals"]), "the host never confirmed the write")
        [entry] = self.work.cmd(cmd="view")["approvals"]
        path = self.state / "approvals" / f"{host.socket_key({'dir': '/profiles/s05tgCMm.Profile 4'})}.json"
        self.assertEqual(json.loads(path.read_text())["approvals"], [entry])

        self.work.cmd(cmd="restartHost")
        self.work.wait_event("ready", timeout=15)
        self.assertEqual(self.work.cmd(cmd="view")["approvals"], [entry], "the new host did not bring the file")
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/other")[0])["tabId"]
        text, err = self.call(s, "define", tabId=tab, code=code, purpose="Reads one claim row.")
        self.assertFalse(err, text)
        fn = json.loads(text)["fn"]  # no question: the fn id at once
        self.assertEqual(self.work.cmd(cmd="asking"), [])
        self.assertFalse(self.call(s, "call", tabId=tab, fn=fn, args=[1])[1])
        self.ask(s, "define", tabId=tab, code=code + " ")  # a changed byte asks

        other = self.session("acme")
        self.pair(other, "Profile 4", self.work)
        tab = json.loads(self.call(other, "open", url="https://example.com/claims")[0])["tabId"]
        self.ask(other, "define", tabId=tab, code=code)  # another project is asked

        self.work.cmd(cmd="forget", entry=entry)
        self.assertTrue(wait_until(lambda: json.loads(path.read_text())["approvals"] == []), "forget never reached the file")
        self.ask(s, "define", tabId=json.loads(self.call(s, "open", url="https://example.com/a")[0])["tabId"], code=code)

    def test_a_second_confirmation_does_not_open_in_the_agent_window(self):
        a, b = self.session("acme"), self.session("billing")
        self.pair(a, "Profile 4", self.work)
        self.call(a, "open", url="https://example.com/")
        self.call(b, "connect", profile="Profile 4")
        self.assertTrue(self.work.wait_event("confirm")["inUsersWindow"])

    # ---- questions that never block the session ----

    def evals(self):
        return [x for x in self.work.cmd(cmd="scripts") if x["fn"] == "evalInPage"]

    def test_eval_and_define_return_at_once_and_await_approval_brings_the_result(self):
        # 4 of 21 script approvals timed out: the eval call itself held the
        # session for the whole question, so it could not tell the user to look.
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        q = self.ask(s, "eval", tabId=tab, code="document.title.length")
        self.assertEqual(self.work.wait_event("ask")["id"], q)
        self.assertEqual(self.evals(), [])  # nothing runs before they answer
        text, err = self.answer(s, q)
        self.assertFalse(err, text)
        self.assertIn(f'Still waiting for the user to answer question {q}', text)
        join = self.call_in_background(s, "await_approval", question=q, timeout_seconds=30)
        time.sleep(0.3)
        started = time.time()
        self.work.cmd(cmd="answer", id=q, approve=True)
        self.assertEqual(join(), ("42", False))  # the script's value, as eval used to return it
        self.assertLess(time.time() - started, 10)
        self.assertEqual(len(self.evals()), 1)
        self.assertEqual(self.work.cmd(cmd="asking"), [])  # its question tab closed
        text, err = self.answer(s, q)  # it ran once, for that call
        self.assertFalse(err, text)
        self.assertIn(f"Question {q} was already collected by another call, and its script ran once", text)
        self.assertIn("Do not ask again", text)
        self.assertEqual(len(self.evals()), 1)

        q = self.ask(s, "define", tabId=tab, code="(n) => n")
        self.work.cmd(cmd="answer", id=self.work.wait_event("ask")["id"], approve=True)
        text, err = self.answer(s, q)
        self.assertFalse(err, text)
        self.assertEqual(json.loads(text)["origin"], "https://example.com")
        self.assertEqual(self.call(s, "call", tabId=tab, fn=json.loads(text)["fn"], args=[1]), ("42", False))

    def test_a_question_belongs_to_the_session_that_asked_it(self):
        a, b = self.session("acme"), self.session("billing")
        self.pair(a, "Profile 4", self.work)
        self.pair(b, "Profile 4", self.work)
        tab = self.open_tab(a, "https://example.com/")
        q = self.ask(a, "eval", tabId=tab, code="1")
        self.work.wait_event("ask")
        for answered in (False, True):
            text, err = self.answer(b, q)
            self.assertTrue(err, text)
            self.assertIn(f"no question {q} is waiting for this session", text)
            if not answered:
                self.work.cmd(cmd="answer", id=q, approve=True)
        self.assertEqual(self.evals(), [])
        self.assertEqual(self.answer(a, q), ("42", False))  # b's tries did not use it up

    def test_a_question_ends_with_control_even_while_no_one_waits_on_it(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        q = self.ask(s, "eval", tabId=tab, code="1")
        self.work.wait_event("ask")
        self.assertEqual(self.work.cmd(cmd="asking"), [q])
        self.work.cmd(cmd="revoke", sessionId=s.id)
        self.assertEqual(self.work.cmd(cmd="view")["requests"], [])
        self.assertTrue(wait_until(lambda: self.work.cmd(cmd="asking") == []))  # its tab closed
        self.assertFalse(self.work.cmd(cmd="answer", id=q, approve=True)["ok"])
        # Allowed but not yet collected when control ends: a new lease does not run it.
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")  # the tab it had is the user's since Stop
        q = self.ask(s, "eval", tabId=tab, code="2")
        self.work.cmd(cmd="answer", id=self.work.wait_event("ask")["id"], approve=True)
        self.work.cmd(cmd="revoke", sessionId=s.id)
        self.pair(s, "Profile 4", self.work)
        text, err = self.answer(s, q)
        self.assertTrue(err)
        self.assertIn(f"no question {q} is waiting for this session", text)  # forgotten with the lease
        self.assertEqual(self.evals(), [])

    def test_a_refused_question_leaves_every_other_question_and_call_alone(self):
        a, b = self.session("acme"), self.session("billing")
        self.pair(a, "Profile 4", self.work)
        self.pair(b, "Profile 4", self.work)
        a_tab, b_tab = self.open_tab(a, "https://example.com/a"), self.open_tab(b, "https://example.com/b")
        q1 = self.ask(a, "eval", tabId=a_tab, code="1")
        q2 = self.ask(a, "define", tabId=a_tab, code="() => 2")
        q3 = self.ask(b, "eval", tabId=b_tab, code="3")
        for _ in range(3):
            self.work.wait_event("ask")
        calls = {"a wait_for": self.call_in_background(a, "wait_for", tabId=a_tab, text="never", timeoutMs=8000),
                 "b sleep": self.call_in_background(b, "sleep", ms=6000),
                 "b await": self.call_in_background(b, "await_approval", question=q3, timeout_seconds=30)}
        time.sleep(0.5)
        self.work.cmd(cmd="answer", id=q1, approve=False)
        self.assertIn("did not allow", self.answer(a, q1)[0])
        time.sleep(0.5)
        self.assertEqual(sorted(r["id"] for r in self.work.cmd(cmd="view")["requests"]), sorted([q2, q3]))
        self.assertEqual(sorted(self.work.cmd(cmd="asking")), sorted([q2, q3]))
        self.assertEqual([k for k, j in calls.items() if not j.running()], [])
        self.work.cmd(cmd="answer", id=q3, approve=True)
        self.assertEqual(calls["b await"](), ("42", False))
        self.assertEqual(calls["b sleep"](timeout=15), ("slept 6000 ms", False))
        self.assertIn('text "never" not met', calls["a wait_for"](timeout=15)[0])

    def test_an_allowed_script_runs_only_where_it_was_shown_when_it_is_collected(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/a")
        q = self.ask(s, "eval", tabId=tab, code="1")
        self.work.wait_event("ask")
        self.work.cmd(cmd="pageNavigates", tabId=tab, url="https://example.org/elsewhere")
        self.work.cmd(cmd="answer", id=q, approve=True)
        text, err = self.answer(s, q)
        self.assertTrue(err)
        self.assertIn("moved to https://example.org/elsewhere after the user allowed the script", text)
        other = self.open_tab(s, "https://example.com/b")
        q = self.ask(s, "eval", tabId=other, code="1")
        self.work.wait_event("ask")
        self.call(s, "close", tabId=other)
        self.work.cmd(cmd="answer", id=q, approve=True)
        text, err = self.answer(s, q)
        self.assertTrue(err)
        self.assertIn("not one of this session's tabs", text)
        self.assertEqual(self.evals(), [])

    def test_an_allowed_script_does_not_run_after_its_page_reloads_at_the_same_url(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/a")
        q = self.ask(s, "eval", tabId=tab, code="1")
        self.work.cmd(cmd="answer", id=self.work.wait_event("ask")["id"], approve=True)
        self.call(s, "navigate", tabId=tab, url="reload")
        text, err = self.answer(s, q)
        self.assertTrue(err)
        self.assertIn("reloaded or replaced after the user allowed the script, though its URL is the same", text)
        self.assertEqual(self.evals(), [])

    # ---- code that changed under a running session ----

    def warnings(self, out):
        return [c["text"] for c in out["content"][1:] if c.get("type") == "text"]

    def test_no_warning_while_the_add_on_runs_the_code_in_the_repo(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        self.assertEqual(s.addon["build"], "personal")
        self.assertEqual(s.addon["code"], server.addon_digest(ROOT / "extension", "personal"))  # JS and Python agree
        out = server.run_tool(s, "tabs", {})
        self.assertFalse(out.get("isError"), out)
        self.assertEqual(self.warnings(out), [])

    def test_add_on_code_other_than_the_repos_is_reported_with_what_to_do(self):
        ext = self.state / "extension"
        shutil.copytree(ROOT / "extension", ext)
        shutil.copytree(ROOT / builds.SCRIPTS_DIR, self.state / builds.SCRIPTS_DIR)  # this profile runs the personal package
        s = server.Session(run_dir=self.run_dir, cwd="/home/user/projects/acme", extension_dir=ext)
        self.sessions.append(s)
        self.pair(s, "Profile 4", self.work)
        self.assertEqual(self.warnings(server.run_tool(s, "tabs", {})), [])
        (ext / "background.js").write_text((ext / "background.js").read_text() + "\n// a newer add-on\n")
        out = server.run_tool(s, "tabs", {})
        self.assertFalse(out.get("isError"), out)
        self.assertEqual(len(json.loads(out["content"][0]["text"])), 0)  # the result itself is untouched
        [warning] = self.warnings(out)
        self.assertIn("add-on in Profile 4", warning)
        self.assertIn("reload", warning)
        self.assertIn("connect again", warning)

    def test_an_add_on_whose_expected_code_cannot_be_worked_out_is_reported(self):
        # The personal package needs extension-personal/; without it the
        # server has nothing to compare, and said nothing (attack, 2026-11-07).
        ext = self.state / "extension"
        shutil.copytree(ROOT / "extension", ext)
        s = server.Session(run_dir=self.run_dir, cwd="/home/user/projects/acme", extension_dir=ext)
        self.sessions.append(s)
        self.pair(s, "Profile 4", self.work)
        [warning] = self.warnings(server.run_tool(s, "tabs", {}))
        self.assertIn("cannot tell", warning)
        self.assertIn("personal", warning)

    def test_an_add_on_that_does_not_report_its_code_is_reported_as_older(self):
        s = self.session()
        real = server.Connection.call

        def old_addon(conn, method, params, timeout_s=60):
            reply = real(conn, method, params, timeout_s)
            if method == "claim" and reply.get("ok"):
                reply["result"].pop("addon", None)
            return reply

        with mock.patch.object(server.Connection, "call", old_addon):
            self.pair(s, "Profile 4", self.work)
        [warning] = self.warnings(server.run_tool(s, "tabs", {}))
        self.assertIn("add-on in Profile 4", warning)
        self.assertIn("older than this server", warning)

    def test_a_change_to_the_servers_own_source_is_reported(self):
        src = self.state / "server.py"
        shutil.copy(ROOT / "mcp/server.py", src)
        s = server.Session(run_dir=self.run_dir, cwd="/home/user/projects/acme", server_file=src)
        self.sessions.append(s)
        self.assertEqual(self.warnings(server.run_tool(s, "profiles", {})), [])
        src.write_text(src.read_text() + "\n# a new tool\n")
        out = server.run_tool(s, "profiles", {})
        self.assertIn("Profile 4", out["content"][0]["text"])
        [warning] = self.warnings(out)
        self.assertIn("server changed on disk", warning)
        self.assertIn("restart it", warning)

    # ---- waiting that survives navigation ----

    def open_tab(self, s, url):
        text, err = self.call(s, "open", url=url)
        self.assertFalse(err, text)
        return json.loads(text)["tabId"]

    def test_wait_for_keeps_waiting_across_a_navigation_to_another_page(self):
        # 13 waits hung to the server's timeout: the action before them reloaded
        # the page, and the waiting script died with it.
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/form")
        join = self.call_in_background(s, "wait_for", tabId=tab, text="Saved", timeoutMs=10000)
        time.sleep(0.6)
        self.work.cmd(cmd="pageNavigates", tabId=tab, url="https://claims.example.org/done", text="Claim Saved")
        text, err = join()
        self.assertFalse(err, text)
        self.assertIn('text "Saved" met after', text)
        self.assertIn("now at https://claims.example.org/done", text)
        polled = {x["url"] for x in self.work.cmd(cmd="scripts") if x["fn"] == "present"}
        self.assertEqual(polled, {"https://example.com/form", "https://claims.example.org/done"})

    def test_wait_for_stops_when_its_tab_moves_to_a_page_the_session_may_not_use(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        join = self.call_in_background(s, "wait_for", tabId=tab, text="Saved", timeoutMs=10000)
        time.sleep(0.6)
        self.work.cmd(cmd="pageNavigates", tabId=tab, url="https://mail.google.com/mail/u/0/", text="Saved")
        text, err = join(timeout=5)
        self.assertTrue(err)
        self.assertIn(f"stopped waiting: tab {tab} moved to https://mail.google.com/mail/u/0/", text)
        self.assertIn("protected", text)
        self.assertNotIn("Inbox", text)  # the URL only, never the title
        self.assertEqual([x for x in self.work.cmd(cmd="scripts") if "mail.google" in x["url"]], [])

    def test_wait_for_ends_when_control_ends(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        join = self.call_in_background(s, "wait_for", tabId=tab, text="never", timeoutMs=10000)
        time.sleep(0.5)
        self.work.cmd(cmd="revoke", sessionId=s.id)
        text, err = join(timeout=5)
        self.assertTrue(err)
        self.assertIn("revoked in Firefox", text)

    def test_wait_for_url_load_selector_and_gone(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        join = self.call_in_background(s, "wait_for", tabId=tab, url="/claims/", load=True, timeoutMs=5000)
        time.sleep(0.3)
        self.work.cmd(cmd="pageNavigates", tabId=tab, url="https://example.com/claims/42", loadMs=800)
        started = time.time()
        text, err = join()
        self.assertFalse(err, text)
        self.assertIn("url /claims/, loaded met", text)
        self.assertGreater(time.time() - started, 0.5)  # the URL matched at once; the load took 800 ms
        self.assertEqual([x for x in self.work.cmd(cmd="scripts") if x["fn"] == "present"], [])  # no page access needed
        self.assertIn("url example.com/claims/*2 met", self.call(s, "wait_for", tabId=tab, url="example.com/claims/*2", timeoutMs=500)[0])
        self.assertIn("not met", self.call(s, "wait_for", tabId=tab, url="/claims\\/\\d+$/", timeoutMs=300)[0])  # no regex
        text, err = self.call(s, "wait_for", tabId=tab, url="/claims/", gone=True, timeoutMs=300)
        self.assertFalse(err, text)
        self.assertIn("url /claims/ gone not met after", text)
        self.assertIn("the tab is at https://example.com/claims/42", text)
        self.work.cmd(cmd="setPage", tabId=tab, selectors=[".done"])
        self.assertIn("selector .done met", self.call(s, "wait_for", tabId=tab, selector=".done", timeoutMs=500)[0])
        self.assertIn("still there", self.call(s, "wait_for", tabId=tab, text="page text", gone=True, timeoutMs=300)[0])
        self.assertIn("url must be at most 2000 characters", self.call(s, "wait_for", tabId=tab, url="x" * 2001)[0])
        for args, why in (({"url": "x" * 2001}, "under 2000 characters"), ({}, "pass text, selector, url or load")):
            text, err = self.direct(s, "wait_for", tabId=tab, **args)
            self.assertTrue(err)
            self.assertIn(why, text)

    def test_gone_is_not_met_by_a_page_that_is_still_loading(self):
        # A reload's new document is empty until it renders; gone must not be
        # met on that blank moment while the page still shows the text.
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/claims")
        self.work.cmd(cmd="setPage", tabId=tab, text="Loading claims")
        join = self.call_in_background(s, "wait_for", tabId=tab, text="Loading claims", gone=True, timeoutMs=3000)
        time.sleep(0.4)
        self.work.cmd(cmd="pageNavigates", tabId=tab, url="https://example.com/claims", text="", loadMs=1500)
        time.sleep(0.6)
        self.work.cmd(cmd="setPage", tabId=tab, text="Loading claims")  # the reloaded page shows it again
        text, err = join()
        self.assertFalse(err, text)
        self.assertIn("gone not met", text)

    def test_an_actions_load_condition_waits_for_the_load_the_action_started(self):
        # The page navigates by script half a second after the click; at the
        # first poll the tab is still complete from the page before.
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/claim")
        join = self.call_in_background(s, "click", tabId=tab, ref="e1", waitFor={"load": True, "timeoutMs": 4000})
        time.sleep(0.5)
        self.work.cmd(cmd="pageNavigates", tabId=tab, url="https://example.com/claim/saved", text="Saved", loadMs=800)
        text, err = join()
        self.assertFalse(err, text)
        self.assertIn("loaded met", text)
        self.assertIn("now at https://example.com/claim/saved", text)
        self.assertIn("no load has started", self.call(s, "click", tabId=tab, ref="e1", waitFor={"load": True, "timeoutMs": 300})[0])

    def test_navigate_waits_for_the_new_document_before_checking_text(self):
        # The old page still shows "Saved" until the new one commits.
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/form")
        self.work.cmd(cmd="setPage", tabId=tab, text="Claim Saved")
        self.work.cmd(cmd="onNavigate", tabId=tab, commitMs=800, text="Draft")
        text, err = self.call(s, "navigate", tabId=tab, url="https://example.com/next", waitFor={"text": "Saved", "timeoutMs": 1500})
        self.assertFalse(err, text)
        self.assertIn('text "Saved" not met', json.loads(text)["waitFor"])
        polled = {x["url"] for x in self.work.cmd(cmd="scripts") if x["fn"] == "present"}
        self.assertEqual(polled, {"https://example.com/next"})
        self.work.cmd(cmd="onNavigate", tabId=tab, commitMs=500, text="Claim Saved")
        started = time.time()
        text, err = self.call(s, "navigate", tabId=tab, url="https://example.com/done", waitFor={"text": "Saved", "timeoutMs": 3000})
        self.assertIn('text "Saved" met', json.loads(text)["waitFor"])
        self.assertGreater(time.time() - started, 0.45)

    def test_an_invalid_timeout_is_refused_before_the_action_runs(self):
        # "NaN" made every timeout NaN: Event.wait(NaN) returns at once, so the
        # server reported a timeout while the add-on clicked; "0xEA60" and
        # [60000] were 60 s to the add-on and 15 s to the server.
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/claim")
        for ms in ("NaN", "0xEA60", [60000], None, True):
            text, err = self.call(s, "click", tabId=tab, ref="e1", waitFor={"text": "x", "timeoutMs": ms})
            self.assertTrue(err, ms)
            self.assertIn("timeoutMs", text)
            text, err = self.call(s, "wait_for", tabId=tab, text="x", timeoutMs=ms)
            self.assertTrue(err, ms)
        time.sleep(0.3)
        self.assertEqual([x for x in self.work.cmd(cmd="scripts") if x["fn"] in ("act", "present")], [])

    def test_wait_for_works_on_a_tab_the_page_opened_before_it_loads(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        new = self.work.cmd(cmd="pageOpensTab", tabId=tab, url="about:blank")
        join = self.call_in_background(s, "wait_for", tabId=new, url="example.com/receipt", timeoutMs=3000)
        time.sleep(0.4)
        self.work.cmd(cmd="pageNavigates", tabId=new, url="https://example.com/receipt")
        text, err = join()
        self.assertFalse(err, text)
        self.assertIn("url example.com/receipt met", text)

    def test_a_url_or_load_condition_after_an_action_that_opened_a_tab_is_checked_there(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/claim")
        self.work.cmd(cmd="onAct", tabId=tab, openTab="https://example.org/receipt")
        text, err = self.call(s, "click", tabId=tab, ref="e1", waitFor={"url": "/receipt", "load": True, "timeoutMs": 2000})
        self.assertFalse(err, text)
        receipt = [t["tabId"] for t in json.loads(self.call(s, "tabs")[0]) if t["url"] == "https://example.org/receipt"][0]
        self.assertTrue(text.startswith("clicked; url /receipt, loaded met after"), text)
        self.assertIn(f"checked on tab {receipt}, which the action opened", text)
        # Text is read in the tab the action ran in, and the result says so.
        self.work.cmd(cmd="onAct", tabId=tab, openTab="https://example.org/receipt2")
        text, err = self.call(s, "click", tabId=tab, ref="e1", waitFor={"text": "page text", "timeoutMs": 2000})
        self.assertFalse(err, text)
        self.assertIn(f"met after", text)
        self.assertIn(f"checked on tab {tab}, where the action ran", text)

    def test_a_wait_or_sleep_stops_at_once_when_control_ends(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        self.work.cmd(cmd="setPage", tabId=tab, hang=True)  # a modal dialog: the poll never answers
        join = self.call_in_background(s, "wait_for", tabId=tab, text="never", timeoutMs=8000)
        time.sleep(0.5)
        started = time.time()
        self.call(s, "release")
        text, err = join(timeout=5)
        self.assertLess(time.time() - started, 1.5)
        self.assertTrue(err)
        self.assertIn("not connected: released by the session", text)
        self.pair(s, "Profile 4", self.work)
        join = self.call_in_background(s, "sleep", ms=8000)
        time.sleep(0.5)
        started = time.time()
        self.work.cmd(cmd="revoke", sessionId=s.id)
        text, err = join(timeout=5)
        self.assertLess(time.time() - started, 1.5)
        self.assertTrue(err)
        self.assertIn("not connected: revoked in Firefox", text)

    def test_sleep_pauses_without_touching_a_page_is_capped_and_needs_control(self):
        s = self.session()
        self.assertTrue(self.call(s, "sleep", ms=10)[1])
        self.pair(s, "Profile 4", self.work)
        started = time.time()
        text, err = self.call(s, "sleep", ms=300)
        self.assertEqual((text, err), ("slept 300 ms", False))
        self.assertGreaterEqual(time.time() - started, 0.3)
        self.work.cmd(cmd="timeScale", scale=0.01)  # the add-on's 30 s takes 0.3 s here
        self.assertEqual(self.call(s, "sleep", ms=600000), ("invalid arguments for sleep: ms must be at most 30000. "
                                                          "Call it again as its inputSchema says.", True))
        text, err = self.direct(s, "sleep", ms=600000)
        self.assertFalse(err, text)
        self.assertIn("slept 30000 ms (capped at 30000", text)
        self.assertEqual(self.work.cmd(cmd="scripts"), [])

    def test_the_server_outwaits_the_add_on_so_a_wait_always_gives_its_own_answer(self):
        cap_s = int(re.search(r"const WAIT_MAX_MS = (\d+);", (ROOT / "extension/background.js").read_text())[1]) / 1000
        sleep_s = int(re.search(r"const SLEEP_MAX_MS = (\d+);", (ROOT / "extension/background.js").read_text())[1]) / 1000
        self.assertGreater(server.TIMEOUTS["wait_for"], cap_s)
        self.assertGreater(server.TIMEOUTS["sleep"], sleep_s)
        for name in ("click", "type", "key", "select", "call", "navigate"):
            base = server.timeout_for(name, {})
            self.assertGreater(server.timeout_for(name, {"waitFor": {"text": "x", "timeoutMs": 10 ** 9}}), base + cap_s)
            self.assertLessEqual(server.timeout_for(name, {"waitFor": {"timeoutMs": 10 ** 9}}), host.MAX_TIMEOUT_S)
            # Anything the add-on refuses as a timeout gets the default here, never NaN.
            for ms in ("NaN", "nan", "0xEA60", [60000], None, True, float("nan"), float("inf")):
                got = server.timeout_for(name, {"waitFor": {"text": "x", "timeoutMs": ms}})
                self.assertTrue(math.isfinite(got), ms)
                self.assertEqual(got, server.timeout_for(name, {"waitFor": {"text": "x"}}), ms)

    def test_an_action_waits_for_what_it_should_bring_and_reports_where_it_landed(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/claim")
        self.work.cmd(cmd="onAct", tabId=tab, openTab="https://example.org/receipt",
                      navigate={"url": "https://example.com/claim/saved", "text": "Claim saved", "loadMs": 1500})
        text, err = self.call(s, "click", tabId=tab, ref="e1", waitFor={"text": "Claim saved"})
        self.assertFalse(err, text)
        self.assertTrue(text.startswith('clicked; text "Claim saved" met after'), text)
        self.assertIn("now at https://example.com/claim/saved (Title of https://example.com/claim/saved); still loading", text)
        receipt = [t["tabId"] for t in json.loads(self.call(s, "tabs")[0]) if t["url"] == "https://example.org/receipt"]
        self.assertEqual(len(receipt), 1)  # handed to this session
        self.assertIn(f"opened tab {receipt[0]} at https://example.org/receipt", text)
        for tool, args in (("type", {"ref": "e1", "text": "x"}), ("key", {"key": "Enter"}), ("select", {"ref": "e1", "option": "A"})):
            text, err = self.call(s, tool, tabId=tab, waitFor={"text": "Claim saved"}, **args)
            self.assertFalse(err, text)
            self.assertIn('text "Claim saved" met', text)
            self.assertNotIn("opened tab", text)  # only the action that opened it reports it
        text, err = self.call(s, "navigate", tabId=tab, url="https://example.com/next", waitFor={"url": "/next", "load": True})
        self.assertFalse(err, text)
        self.assertEqual((json.loads(text)["url"], json.loads(text)["waitFor"][:21]), ("https://example.com/next", "url /next, loaded met"))
        # A miss is reported, not an error: the click happened and must not be repeated.
        text, err = self.call(s, "click", tabId=tab, ref="e1", waitFor={"text": "Never", "timeoutMs": 300})
        self.assertFalse(err, text)
        self.assertTrue(text.startswith('clicked; text "Never" not met after'), text)
        # A bad waitFor is refused before anything runs in the page.
        acted = len([x for x in self.work.cmd(cmd="scripts") if x["fn"] == "act"])
        for bad in ({"url": "x" * 2001}, {"gone": True}, "Saved"):
            text, err = self.call(s, "click", tabId=tab, ref="e1", waitFor=bad)
            self.assertTrue(err, bad)
        self.assertEqual(len([x for x in self.work.cmd(cmd="scripts") if x["fn"] == "act"]), acted)

    # Since the page's move is stopped before it is sent,
    # not let through and refused once it has loaded.
    def test_an_action_whose_page_moves_somewhere_refused_says_it_ran_and_what_was_stopped(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        self.work.cmd(cmd="onAct", tabId=tab, navigate={"url": "https://accounts.google.com/signin", "text": "Sign in"})
        text, err = self.call(s, "click", tabId=tab, ref="e1", waitFor={"text": "Welcome", "timeoutMs": 2000})
        self.assertIn("clicked", text)
        self.assertIn("Foxlatch stopped this tab from loading https://accounts.google.com/signin", text)
        self.assertIn("accounts.google.com is protected", text)
        self.assertIn("now at https://example.com/", text)
        self.assertEqual([x for x in self.work.cmd(cmd="scripts") if "accounts.google" in x["url"]], [])

    def test_call_with_waitFor_reports_the_result_and_where_the_tab_went(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/a")
        q = self.ask(s, "define", tabId=tab, code="(n) => n")
        self.work.cmd(cmd="answer", id=self.work.wait_event("ask")["id"], approve=True)
        fn = json.loads(self.answer(s, q)[0])["fn"]
        self.assertEqual(self.call(s, "call", tabId=tab, fn=fn, args=[1]), ("42", False))  # unchanged without waitFor
        self.work.cmd(cmd="onAct", tabId=tab)  # no effect; the function's page stays
        text, err = self.call(s, "call", tabId=tab, fn=fn, args=[1], waitFor={"url": "example.com/a"})
        self.assertFalse(err, text)
        out = json.loads(text)
        self.assertEqual((out["result"], out["url"]), (42, "https://example.com/a"))
        self.assertIn("url example.com/a met", out["waitFor"])

    def test_a_filter_that_matches_nothing_offers_the_nearest_lines(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        text, err = self.call(s, "snapshot", tabId=tab, filter="indexing request")
        self.assertFalse(err, text)
        self.assertIn('no element matches "indexing request"; the nearest lines, as suggestions:\ne1 button "Request indexing"', text)
        text, _ = self.call(s, "snapshot", tabId=tab, filter="request")
        self.assertNotIn("suggestions", text)

    # ---- concurrency ----

    def test_a_slow_call_does_not_hold_up_a_fast_one_in_the_same_session(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = self.open_tab(s, "https://example.com/")
        join = self.call_in_background(s, "wait_for", tabId=tab, text="never", timeoutMs=3000)
        time.sleep(0.3)
        started = time.time()
        for _ in range(3):
            text, err = self.call(s, "tabs")
            self.assertFalse(err, text)
            self.assertEqual(json.loads(text)[0]["tabId"], tab)
        self.assertLess(time.time() - started, 1.5)
        text, err = join(timeout=10)
        self.assertFalse(err, text)
        # The elapsed time is measured, so under load it reads 3.1s or more.
        self.assertRegex(text, r'text "never" not met after [3-9]\.\ds')

    def test_listing_profiles_never_collides_with_this_sessions_own_connection(self):
        # profiles probed each profile under the session's own id; a connect
        # while a probe was open was refused as "already connected".
        s = self.session()
        real = server.Connection.call
        probing, connected = threading.Event(), threading.Event()

        def held_status(conn, method, params, timeout_s=60):
            if method == "status" and conn.info["profile"]["name"] == "Profile 4":
                probing.set()
                connected.wait(5)  # the probe stays open while connect runs
            return real(conn, method, params, timeout_s)

        with mock.patch.object(server.Connection, "call", held_status):
            join = self.call_in_background(s, "profiles")
            self.assertTrue(probing.wait(5))
            text, err = self.call(s, "connect", profile="Profile 4")
            connected.set()
            self.assertFalse(err, text)
            self.assertIn("Code:", text)
            self.assertFalse(join()[1])

    # ---- the MCP layer (public release, Phase 3a) ----

    # Arguments were passed to Firefox as sent, whatever the schema said; a
    # wrong type surfaced as whatever the add-on made of it, or not at all.
    def test_tool_arguments_are_checked_against_the_advertised_schema_before_reaching_firefox(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        before = self.work.cmd(cmd="scripts")
        bad = [
            ("click", {"tabId": tab}, "ref is required"),
            ("click", {"tabId": tab, "ref": "e1", "waitFor": {"timeoutMs": 90000}}, "waitFor.timeoutMs must be at most 60000"),
            ("click", {"tabId": tab, "ref": "e1", "waitFor": {"txt": "Done"}}, "waitFor.txt is not a known field"),
            ("type", {"tabId": tab, "text": 5}, "text must be a string"),
            ("open", {"url": "https://example.com/", "tab": 1}, "tab is not an argument of this tool"),
            ("snapshot", {"tabId": "1"}, "tabId must be an integer"),
            ("scroll", {"tabId": tab, "dy": True}, "dy must be an integer"),
            ("await_approval", {"timeout_seconds": "soon"}, "timeout_seconds must be a number"),
            ("eval", {"tabId": tab, "code": "1", "purpose": "x" * 201}, "purpose must be at most 200 characters"),
        ]
        for name, args, why in bad:
            reply = server.handle(s, {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": args}})
            out = reply["result"]
            self.assertTrue(out.get("isError"), (name, args, out))
            self.assertIn(f"invalid arguments for {name}: {why}", out["content"][0]["text"])
        reply = server.handle(s, {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {"name": "tabs", "arguments": [1]}})
        self.assertIn("arguments must be an object", reply["result"]["content"][0]["text"])
        self.assertEqual(self.work.cmd(cmd="scripts"), before)  # nothing reached a page
        self.assertEqual(self.work.cmd(cmd="view")["requests"], [])  # and no question was put
        self.assertEqual(len(json.loads(self.call(s, "tabs")[0])), 1)  # nor a tab opened

    # ---- agent context (Phase 4) ----

    # A table, a form or the end of a long page took a screenshot or an eval
    #; find, read and text's offset read them, checked like any call.
    def test_find_read_and_paged_text_are_listed_checked_and_reach_the_page(self):
        s = self.session()
        listed = {t["name"]: t for t in server.handle(s, {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})["result"]["tools"]}
        self.assertTrue({"find", "read"} <= set(listed))
        self.assertIn("offset", listed["text"]["inputSchema"]["properties"])
        self.pair(s, "Profile 4", self.work)
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        before = self.work.cmd(cmd="scripts")
        for name, args, why in [
            ("find", {"tabId": tab, "role": "button", "max": "5"}, "max must be an integer"),
            ("find", {"tabId": tab, "role": 1}, "role must be a string"),
            ("find", {"tabId": tab, "near": "Save"}, "near is not an argument of this tool"),
            ("read", {"tabId": tab, "offset": 1.5}, "offset must be an integer"),
            ("read", {"ref": "ae1"}, "tabId is required"),
            ("text", {"tabId": tab, "offset": "100"}, "offset must be an integer"),
        ]:
            reply = server.handle(s, {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": args}})
            self.assertIn(f"invalid arguments for {name}: {why}", reply["result"]["content"][0]["text"])
        self.assertEqual(self.work.cmd(cmd="scripts"), before)  # nothing reached a page

        out = server.handle(s, {"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                                "params": {"name": "find", "arguments": {"tabId": tab, "name": "indexing"}}})["result"]
        self.assertFalse(out.get("isError"), out)
        found = json.loads(out["content"][0]["text"])
        self.assertEqual(found["matches"], 1)
        self.assertRegex(found["lines"][0], r'^[a-df-z]+e1 button "Request indexing"$')
        text, err = self.call(s, "read", tabId=tab, selector="table", max=1)
        self.assertFalse(err, text)
        table = json.loads(text)
        self.assertEqual((table["kind"], table["headers"], table["total"], table["next"]), ("table", ["Member", "Status"], 2, 1))
        self.assertRegex(table["rows"][0]["refs"][0]["ref"], r"^[a-df-z]+e1$")
        self.assertEqual(table["rows"][0]["refs"][0]["name"], "Edit")
        self.assertFalse(self.call(s, "click", tabId=tab, ref=table["rows"][0]["refs"][0]["ref"])[1])

        self.work.cmd(cmd="setPage", tabId=tab, text="abcdefghij")
        text, err = self.call(s, "text", tabId=tab, max=4)
        self.assertFalse(err, text)
        self.assertIn("characters 0 to 4 of 10; pass offset 4 for the rest", text)
        self.assertTrue(text.endswith("\n\nabcd"), text)
        text, _ = self.call(s, "text", tabId=tab, offset=8)
        self.assertIn("characters 8 to 10 of 10, the end", text)
        self.assertTrue(text.endswith("\n\nij"), text)
        text, _ = self.call(s, "text", tabId=tab)
        self.assertNotIn("characters", text)  # the whole text needs no note
        self.assertTrue(text.endswith("\n\nabcdefghij"), text)

    def test_the_instructions_map_each_need_to_its_tool_and_the_public_build_never_names_eval(self):
        for scripts in (False, True):
            text = server.instructions(scripts)
            self.assertNotIn("Typical loop", text)
            for need in ("`find`", "`snapshot`", "`read`", "`text`", "`offset`", "`waitFor`", "`screenshot`"):
                self.assertIn(need, text, (scripts, need))
            self.assertIn("ask the user", text)  # consent rules kept
            self.assertIn("not connected", text)  # recovery kept
            self.assertEqual("eval" in text, scripts, scripts)

    # A cancelled request still ran: notifications/cancelled was ignored.
    def test_a_cancelled_call_that_has_not_reached_firefox_never_does(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        call = server.Call()
        call.set()  # the client cancelled it before its thread reached Firefox
        msg = {"jsonrpc": "2.0", "id": "c1", "method": "tools/call", "params": {"name": "open", "arguments": {"url": "https://example.com/"}}}
        self.assertIsNone(server.respond(s, msg, call))  # no reply to a cancelled request
        self.assertEqual(json.loads(self.call(s, "tabs")[0]), [], "the cancelled open opened a tab")
        self.assertIsNotNone(server.respond(s, {**msg, "id": "c2"}, server.Call()))  # one not cancelled runs

    # cancellation was checked before the call waited for
    # its turn to send, so one cancelled while it waited was sent anyway.
    def test_a_call_cancelled_while_it_waits_to_send_is_never_sent(self):
        s = self.session()
        self.pair(s, "Profile 4", self.work)
        call = server.Call()
        msg = {"jsonrpc": "2.0", "id": "c1", "method": "tools/call", "params": {"name": "open", "arguments": {"url": "https://example.com/"}}}
        out = {}
        with s.conn.send_lock:  # another call is sending
            t = threading.Thread(target=lambda: out.setdefault("reply", server.respond(s, msg, call)))
            t.start()
            time.sleep(0.3)  # it has passed its first check and waits for the lock
            call.set()
        t.join(10)
        self.assertIsNone(out["reply"])
        self.assertEqual(json.loads(self.call(s, "tabs")[0]), [], "the cancelled open opened a tab")

    def test_a_cancelled_call_already_in_firefox_finishes_there_and_gets_no_reply(self):
        proc = subprocess.Popen([sys.executable, str(ROOT / "mcp/server.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                env={**os.environ, "FOXLATCH_STATE_DIR": str(self.state)}, cwd=self.tmp.name, text=True)
        lines: queue.Queue = queue.Queue()
        threading.Thread(target=lambda: [lines.put(json.loads(l)) for l in proc.stdout], daemon=True).start()

        def send(method, params, mid=None):
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method, "params": params,
                                         **({} if mid is None else {"id": mid})}) + "\n")
            proc.stdin.flush()

        try:
            send("initialize", {"protocolVersion": "2025-06-18"}, 1)
            self.assertEqual(lines.get(timeout=10)["result"]["protocolVersion"], "2025-06-18")
            send("tools/call", {"name": "connect", "arguments": {"profile": "Profile 4"}}, 2)
            lines.get(timeout=10)
            self.work.cmd(cmd="decide", sessionId=self.work.wait_event("confirm")["sessionId"], approve=True)
            send("tools/call", {"name": "await_approval", "arguments": {"timeout_seconds": 5}}, 3)
            self.assertIn("Connected", lines.get(timeout=10)["result"]["content"][0]["text"])
            send("tools/call", {"name": "sleep", "arguments": {"ms": 1500}}, "slow")
            time.sleep(0.3)  # in the add-on by now
            send("notifications/cancelled", {"requestId": "slow", "reason": "the user pressed Escape"})
            send("notifications/cancelled", {"requestId": 99})  # unknown: ignored
            send("tools/call", {"name": "tabs", "arguments": {}}, 5)
            self.assertEqual(lines.get(timeout=10)["id"], 5)
            with self.assertRaises(queue.Empty, msg="a cancelled request was answered"):
                lines.get(timeout=3)
            send("tools/call", {"name": "sleep", "arguments": {"ms": 10}}, 6)
            self.assertEqual(lines.get(timeout=10)["result"]["content"][0]["text"], "slept 10 ms")
        finally:
            proc.stdin.close()
            proc.wait(5)
            proc.stdout.close()

    def test_connect_retries_once_while_the_host_still_holds_the_last_connection(self):
        s = self.session()
        info = s._find("Profile 4")
        held = server.Connection(info, s.id, s.project)  # a socket the host has not yet seen close
        threading.Timer(0.1, held.close).start()
        text, err = self.call(s, "connect", profile="Profile 4")
        self.assertFalse(err, text)
        self.assertIn("Code:", text)

    def test_the_mcp_server_answers_a_fast_call_while_a_slow_one_runs(self):
        proc = subprocess.Popen([sys.executable, str(ROOT / "mcp/server.py")], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                env={**os.environ, "FOXLATCH_STATE_DIR": str(self.state)}, cwd=self.tmp.name, text=True)
        lines: queue.Queue = queue.Queue()
        threading.Thread(target=lambda: [lines.put(json.loads(l)) for l in proc.stdout], daemon=True).start()

        def send(mid, method, params):
            proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid, "method": method, "params": params}) + "\n")
            proc.stdin.flush()

        try:
            send(1, "initialize", {})
            self.assertEqual(lines.get(timeout=10)["id"], 1)
            send(2, "tools/call", {"name": "connect", "arguments": {"profile": "Profile 4"}})
            lines.get(timeout=10)
            self.work.cmd(cmd="decide", sessionId=self.work.wait_event("confirm")["sessionId"], approve=True)
            send(3, "tools/call", {"name": "await_approval", "arguments": {"timeout_seconds": 5}})
            self.assertIn("Connected", lines.get(timeout=10)["result"]["content"][0]["text"])
            send(4, "tools/call", {"name": "sleep", "arguments": {"ms": 2000}})
            send(5, "tools/call", {"name": "tabs", "arguments": {}})
            first = lines.get(timeout=10)
            self.assertEqual(first["id"], 5, first)  # the fast call did not queue behind the slow one
            self.assertEqual(lines.get(timeout=10)["result"]["content"][0]["text"], "slept 2000 ms")
        finally:
            proc.stdin.close()
            proc.wait(5)
            proc.stdout.close()


@unittest.skipUnless(NODE, "node is required for the add-on harness")
class Builds(unittest.TestCase):
    """Two builds from one tree (2026-11-07): the public build has no eval,
    define or call (Mozilla's remote-code policy), the personal one keeps
    them. Each profile runs its package as install.sh builds it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.state = Path(self.tmp.name)
        self.run_dir = self.state / "run"
        self.profiles, self.sessions = [], []

    def tearDown(self):
        for s in self.sessions:
            if s.conn:
                s.conn.close()
        for p in self.profiles:
            p.stop()
        self.tmp.cleanup()

    def profile(self, name, build):
        firefox = Profile(self.state, name, f"/profiles/{name}", build=build)
        self.profiles.append(firefox)
        # The registry says the build once the add-on's own hello reaches its host.
        self.assertTrue(wait_until(lambda: any(i["profile"]["name"] == name and i.get("build") == build
                                               for i in server.discover(self.run_dir))), f"{name}: no build in the registry")
        return firefox

    def session(self):
        s = server.Session(run_dir=self.run_dir, cwd="/home/user/projects/acme")
        self.sessions.append(s)
        return s

    def handle(self, s, method, params=None):
        return server.handle(s, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})["result"]

    def tools(self, s):
        return {t["name"]: t for t in self.handle(s, "tools/list")["tools"]}

    def call(self, s, name, **args):
        out = self.handle(s, "tools/call", {"name": name, "arguments": args})
        return out["content"][0].get("text", ""), out.get("isError", False)

    def pair(self, s, name, firefox):
        text, err = self.call(s, "connect", profile=name)
        self.assertFalse(err, text)
        firefox.cmd(cmd="decide", sessionId=firefox.wait_event("confirm")["sessionId"], approve=True)
        self.assertIn("Connected", self.call(s, "await_approval", timeout_seconds=5)[0])

    def test_the_public_build_hides_and_refuses_scripts_end_to_end(self):
        public = self.profile("Public", "public")
        s = self.session()
        self.assertNotIn("`eval`", self.handle(s, "initialize", {"protocolVersion": "2025-11-25"})["instructions"])
        for when in ("before connect", "after connect"):
            tools = self.tools(s)
            self.assertFalse({"eval", "define", "call"} & set(tools), when)
            self.assertNotIn("question", tools["await_approval"]["inputSchema"]["properties"], when)
            self.assertNotIn("eval", tools["await_approval"]["description"], when)
            if when == "before connect":
                self.pair(s, "Public", public)
        self.assertEqual((s.addon["build"], s.addon["code"]), ("public", server.addon_digest(ROOT / "extension", "public")))
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        # Through the MCP surface: not a tool here.
        text, err = self.call(s, "eval", tabId=tab, code="1", purpose="Reads the page.")
        self.assertTrue(err)
        self.assertIn("build without scripts", text)
        text, err = self.call(s, "await_approval", question="r1")
        self.assertTrue(err)
        self.assertIn("question is not an argument", text)
        # Past the server, as a client that ignored tools/list: the add-on refuses each one.
        for name, args in [("eval", {"tabId": tab, "code": "1", "purpose": "x"}), ("define", {"tabId": tab, "code": "(n) => n", "purpose": "x"}),
                           ("call", {"tabId": tab, "fn": "f1", "args": []})]:
            out = server.run_tool(s, name, args)
            self.assertTrue(out.get("isError"), out)
            self.assertIn("this Foxlatch build runs no scripts", out["content"][0]["text"])
        self.assertFalse({"canEval", "markDocument", "evalInPage"} & {x["fn"] for x in public.cmd(cmd="scripts")})
        self.assertEqual(public.cmd(cmd="view")["requests"], [])
        self.assertEqual([c["text"] for c in server.run_tool(s, "tabs", {})["content"][1:]], [])  # no stale-code warning

    def test_the_personal_build_lists_and_runs_scripts(self):
        personal = self.profile("Personal", "personal")
        s = self.session()
        self.assertIn("`eval`", self.handle(s, "initialize", {})["instructions"])
        self.assertTrue({"eval", "define", "call"} <= set(self.tools(s)))
        self.pair(s, "Personal", personal)
        self.assertTrue({"eval", "define", "call"} <= set(self.tools(s)))
        self.assertIn("question", self.tools(s)["await_approval"]["inputSchema"]["properties"])
        tab = json.loads(self.call(s, "open", url="https://example.com/")[0])["tabId"]
        text, err = self.call(s, "eval", tabId=tab, code="40 + 2", purpose="Adds.")
        self.assertFalse(err, text)
        question = re.search(r'question "(r\d+)"', text)[1]
        personal.cmd(cmd="answer", id=personal.wait_event("ask")["id"], approve=True)
        self.assertEqual(self.call(s, "await_approval", question=question, timeout_seconds=5), ("42", False))
        self.assertEqual([c["text"] for c in server.run_tool(s, "tabs", {})["content"][1:]], [])  # personal digest matches

    # Mozilla's signing rewrites manifest.json (the same JSON, laid out its
    # own way) and adds META-INF: the signed 1.0.0 warned "runs other code"
    # on every tool result though nothing in it differed (2026-11-09).
    def test_a_package_mozilla_signed_is_the_same_code(self):
        signed = Path(PACKAGES_TMP.name) / "signed"
        shutil.copytree(PACKAGES["personal"], signed)
        manifest = json.loads((signed / "manifest.json").read_text())
        (signed / "manifest.json").write_text(json.dumps(manifest, indent=2))
        (signed / "META-INF").mkdir()
        (signed / "META-INF" / "manifest.mf").write_text("Manifest-Version: 1.0\n")
        self.addCleanup(PACKAGES.__setitem__, "personal", PACKAGES["personal"])
        PACKAGES["personal"] = signed
        firefox = self.profile("Signed", "personal")
        s = self.session()
        self.pair(s, "Signed", firefox)
        self.assertEqual([c["text"] for c in server.run_tool(s, "tabs", {})["content"][1:]], [])

    def test_a_call_is_checked_against_the_tools_this_client_was_last_listed(self):
        # Listed while only a public profile was open (no eval); the client
        # never lists again, so eval was never advertised to it.
        public = self.profile("Public", "public")
        s = self.session()
        self.assertNotIn("eval", self.tools(s))
        personal = self.profile("Personal", "personal")
        self.pair(s, "Personal", personal)
        before = personal.cmd(cmd="scripts")
        text, err = self.call(s, "eval", tabId=1, code="1", purpose="x")
        self.assertTrue(err, text)
        self.assertIn("list the tools again", text)
        self.assertEqual(personal.cmd(cmd="scripts"), before)
        self.assertIn("eval", self.tools(s))  # listed again, it is there
        del public

    def test_the_tools_follow_the_build_of_the_profile_connected_to(self):
        self.profile("Public", "public")
        self.profile("Personal", "personal")
        s = self.session()
        written: list[dict] = []
        lines = [json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
                 json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "connect", "arguments": {"profile": "Public"}}})]
        server.serve_stdio(s, lines, written.append)
        self.assertTrue(wait_until(lambda: any(m.get("method") == "notifications/tools/list_changed" for m in written)), written)
        listed = next(m for m in written if m.get("id") == 1)["result"]["tools"]
        self.assertIn("eval", {t["name"] for t in listed})  # before connect: an open profile has scripts
        self.assertNotIn("eval", self.tools(s))  # connected to the public build
        self.assertFalse(s.tools_changed())  # said once


@unittest.skipUnless(NODE, "node is required for the add-on harness")
class ProjectIdentity(unittest.TestCase):
    """F7 (attack on remembered approvals, 2026-11-07): the project was the
    working directory's last name, so ~/Projects/billing and /tmp/clone/billing
    shared remembered approvals, every session started in $HOME was the user
    name, and any src directory was src."""

    def test_the_project_is_the_canonical_path_of_the_git_root_else_of_the_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(os.path.realpath(tmp))
            one, two = root / "Projects" / "billing", root / "clone" / "billing"
            for repo in (one, two):
                (repo / "src" / "deep").mkdir(parents=True)
                (repo / ".git").mkdir()
            worktree = root / "wt" / "billing"
            worktree.mkdir(parents=True)
            (worktree / ".git").write_text("gitdir: /elsewhere/.git/worktrees/billing\n")
            plain = root / "plain" / "src"
            plain.mkdir(parents=True)
            (root / "link").symlink_to(one)
            s = server.Session(run_dir=root / "run", cwd=str(one / "src"))
            self.assertEqual((s.project, s.label), (str(one), f"billing · {s.id[:4]}"))
            self.assertEqual(server.project_of(str(one / "src" / "deep")), str(one))
            self.assertEqual(server.project_of(str(two)), str(two))
            self.assertEqual(server.project_of(str(root / "link" / "src")), str(one), "a symlinked path is another project")
            self.assertEqual(server.project_of(str(worktree)), str(worktree))
            self.assertEqual(server.project_of(str(plain)), str(plain))
            self.assertEqual(server.project_of(str(root / "Projects")), str(root / "Projects"))


class AddonDigest(unittest.TestCase):
    """What the server expects the add-on to report at connect."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.ext = Path(self.tmp.name) / "extension"
        shutil.copytree(ROOT / "extension", self.ext)
        self.before = server.addon_digest(self.ext)
        self.assertIsNotNone(self.before)

    def tearDown(self):
        self.tmp.cleanup()

    # The digest covered background.scripts only, so a stale ask.js (the page
    # that shows the user the code and arms Allow) was never reported.
    def test_it_covers_the_page_that_asks_the_user(self):
        (self.ext / "ask.js").write_text((self.ext / "ask.js").read_text().replace("HOLD_MS = 1500", "HOLD_MS = 0"))
        self.assertNotEqual(server.addon_digest(self.ext), self.before, "ask.js changed (Allow no longer needs a hold) and no warning")

    def test_it_covers_the_manifest(self):
        m = json.loads((self.ext / "manifest.json").read_text())
        m["permissions"].append("cookies")
        m["version"] = "0.4.0"
        (self.ext / "manifest.json").write_text(json.dumps(m))
        self.assertNotEqual(server.addon_digest(self.ext), self.before, "manifest.json changed (version, permissions) and no warning")

    def test_it_reads_the_manifest_as_json_not_as_bytes(self):
        m = json.loads((self.ext / "manifest.json").read_text())
        (self.ext / "manifest.json").write_text(json.dumps(m, indent=2))  # as Mozilla's signing leaves it
        self.assertEqual(server.addon_digest(self.ext), self.before)


class Negotiation(unittest.TestCase):
    """initialize echoed any protocolVersion the client sent, so a server that
    speaks one revision claimed to speak every one, past and future."""

    def test_initialize_answers_the_clients_version_if_supported_else_the_newest(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            s = server.Session(run_dir=Path(tmp) / "run", cwd="/x")

            def init(params):
                return server.handle(s, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": params})["result"]

            for v in ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"):
                self.assertEqual(init({"protocolVersion": v})["protocolVersion"], v)
            for asked in ({"protocolVersion": "2099-01-01"}, {"protocolVersion": "2026-07-28"}, {"protocolVersion": 5}, {}):
                self.assertEqual(init(asked)["protocolVersion"], "2025-11-25", asked)
            result = init({"protocolVersion": "2025-11-25"})
            self.assertEqual(result["serverInfo"]["name"], "foxlatch")
            self.assertEqual(result["serverInfo"]["title"], "Foxlatch")
            self.assertNotIn("Acme", result["instructions"])
            self.assertNotIn("Claude", result["instructions"])
            tools = json.dumps(server.handle(s, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"])
            self.assertNotIn("Claude", tools)
            self.assertNotIn("Acme", tools)


class ToolArguments(unittest.TestCase):
    """Arguments the schema types, sent anyway as something else."""

    # float(None) raised TypeError out of _run_tool; handle() turned it into
    # a JSON-RPC internal error, and the result and its warning were lost.
    def test_a_missing_or_malformed_timeout_is_a_default_not_a_crash(self):
        with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
            s = server.Session(run_dir=Path(tmp) / "run", cwd="/x")
            s.target = {"key": "k", "profile": {"name": "Profile 4"}}
            for args in ({"question": "r1", "timeout_seconds": None}, {"timeout_seconds": None},
                         {"question": "r1", "timeout_seconds": "soon"}, {"timeout_seconds": [5]}):
                try:
                    out = server.run_tool(s, "await_approval", args)
                except Exception as e:  # noqa: BLE001
                    self.fail(f"run_tool raised {e!r} for {args}; handle() turns it into an internal error and no tool result")
                self.assertTrue(out.get("isError"), out)  # Profile 4 is not open: a tool error, as for any timeout
                self.assertIn("not open", out["content"][0]["text"])


if __name__ == "__main__":
    unittest.main()
