"""Host: profile identity, socket privacy, session binding, routing, timeouts, cleanup.

Run: python3 -m unittest discover -s tests
The Firefox side is a pair of OS pipes speaking real native-messaging frames.
"""

import json
import os
import socket
import stat
import struct
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

# The suite never reads the developer's own Foxlatch config (personal-id
# included): everything this process resolves lives in a throwaway directory.
_OWN_STATE = tempfile.TemporaryDirectory()
os.environ["FOXLATCH_STATE_DIR"] = _OWN_STATE.name
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "host"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp"))
import host  # noqa: E402
import server  # noqa: E402

SID_A = "a" * 32
SID_B = "b" * 32


class FakeFirefox:
    """The add-on's end of the native port."""

    def __init__(self):
        to_host_r, self.to_host_w = os.pipe()
        self.from_host_r, from_host_w = os.pipe()
        self.host_side = host.Firefox(os.fdopen(to_host_r, "rb"), os.fdopen(from_host_w, "wb"))
        self._out = os.fdopen(self.to_host_w, "wb")
        self._in = os.fdopen(self.from_host_r, "rb")
        self._lock = threading.Lock()

    def read(self, timeout=5):
        result = {}

        def go():
            head = self._in.read(4)
            if len(head) == 4:
                result["msg"] = json.loads(self._in.read(struct.unpack("=I", head)[0]))

        t = threading.Thread(target=go, daemon=True)
        t.start()
        t.join(timeout)
        return result.get("msg")

    def send(self, msg):
        data = json.dumps(msg).encode()
        with self._lock:
            self._out.write(struct.pack("=I", len(data)) + data)
            self._out.flush()

    def quit(self):
        self._out.close()


class Client:
    def __init__(self, path):
        self.s = socket.socket(socket.AF_UNIX)
        self.s.settimeout(5)
        self.s.connect(str(path))
        self.f = self.s.makefile("rwb")

    def send(self, obj):
        self.f.write(json.dumps(obj).encode() + b"\n")
        self.f.flush()

    def read(self):
        line = self.f.readline()
        return json.loads(line) if line else None

    def hello(self, sid=SID_A, protocol=2):
        self.send({"hello": {"protocol": protocol, "sessionId": sid, "label": "test · aaaa"}})
        return self.read()

    def close(self):
        self.f.close()
        self.s.close()


class HostTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")  # short path: AF_UNIX names are limited to 104 bytes
        self.run_dir = Path(self.tmp.name) / "state" / "run"
        self.ff = FakeFirefox()
        self.host = host.Host(self.ff.host_side, {"name": "Profile 4", "dir": "/profiles/p4"}, ["claims.example"], self.run_dir)
        self.thread = threading.Thread(target=self.host.run, daemon=True)
        self.thread.start()
        hello = self.ff.read()
        self.assertEqual(hello, {"type": "hello", "profile": {"name": "Profile 4", "dir": "/profiles/p4"}, "deny": ["claims.example"]})

    def tearDown(self):
        try:
            self.ff.quit()
        except OSError:
            pass
        self.thread.join(5)
        self.tmp.cleanup()

    def answer(self, reply_fn):
        """Answer every tool call from the host with reply_fn(msg)."""
        def loop():
            while True:
                msg = self.ff.read(10)
                if msg is None:
                    return
                if "id" in msg:
                    def respond(msg=msg):
                        self.ff.send({"id": msg["id"], **reply_fn(msg)})
                    threading.Thread(target=respond, daemon=True).start()
                else:
                    self.events.append(msg)
        self.events = []
        threading.Thread(target=loop, daemon=True).start()

    def test_socket_and_registry_are_private_to_this_user(self):
        mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)
        self.assertEqual(mode(self.run_dir), 0o700)
        self.assertEqual(mode(self.run_dir.parent), 0o700)
        self.assertEqual(mode(self.host.sock_path), 0o600)
        self.assertEqual(mode(self.host.registry_path), 0o600)
        reg = json.loads(self.host.registry_path.read_text())
        self.assertEqual((reg["profile"]["name"], reg["pid"], reg["protocol"]), ("Profile 4", os.getpid(), 2))

    def test_two_profiles_get_two_sockets(self):
        other = host.Host(self.ff.host_side, {"name": "Personal", "dir": "/profiles/personal"}, [], self.run_dir)
        self.assertNotEqual(other.sock_path, self.host.sock_path)

    def test_hello_is_validated(self):
        for kwargs, err in [({"protocol": 1}, "protocol"), ({"sid": "short"}, "bad session id"), ({"sid": "G" * 32}, "bad session id")]:
            c = Client(self.host.sock_path)
            reply = c.hello(sid=kwargs.get("sid", SID_A), protocol=kwargs.get("protocol", 2))
            self.assertFalse(reply["ok"])
            self.assertIn(err, reply["error"])
            c.close()
        c = Client(self.host.sock_path)
        c.send({"id": 1, "method": "status"})
        self.assertIn("expected hello", c.read()["error"])
        c.close()

    def test_a_live_session_id_cannot_be_claimed_by_a_second_connection(self):
        self.answer(lambda m: {"ok": True, "result": None})
        first = Client(self.host.sock_path)
        self.assertTrue(first.hello()["ok"])
        second = Client(self.host.sock_path)
        self.assertIn("already connected", second.hello()["error"])
        first.close()
        time.sleep(0.2)
        third = Client(self.host.sock_path)
        self.assertTrue(third.hello()["ok"])  # free again once the first hung up
        third.close()

    def test_the_session_id_comes_from_the_connection_not_the_request(self):
        self.answer(lambda m: {"ok": True, "result": m["sessionId"]})
        c = Client(self.host.sock_path)
        c.hello(SID_A)
        c.send({"id": 7, "method": "status", "params": {"sessionId": SID_B}, "sessionId": SID_B})
        self.assertEqual(c.read(), {"id": 7, "ok": True, "result": SID_A})
        c.close()

    def test_opened_and_closed_reach_the_add_on(self):
        self.answer(lambda m: {"ok": True, "result": None})
        c = Client(self.host.sock_path)
        c.hello(SID_A)
        c.close()
        deadline = time.time() + 3
        while time.time() < deadline and len(self.events) < 2:
            time.sleep(0.05)
        self.assertEqual([(e["type"], e["sessionId"]) for e in self.events], [("opened", SID_A), ("closed", SID_A)])

    def test_concurrent_calls_on_one_connection_get_their_own_answers(self):
        def reply(m):
            if m["params"].get("slow"):
                time.sleep(0.5)
            return {"ok": True, "result": m["params"]["n"]}
        self.answer(reply)
        c = Client(self.host.sock_path)
        c.hello()
        c.send({"id": 1, "method": "x", "params": {"n": 1, "slow": True}})
        c.send({"id": 2, "method": "x", "params": {"n": 2}})
        got = [c.read(), c.read()]
        self.assertEqual([g["id"] for g in got], [2, 1])
        self.assertEqual({g["id"]: g["result"] for g in got}, {1: 1, 2: 2})
        c.close()

    def test_an_unanswered_call_times_out_and_a_late_answer_is_dropped(self):
        held = []
        self.answer(lambda m: self._hold(held, m))
        c = Client(self.host.sock_path)
        c.hello()
        c.send({"id": 1, "method": "slow", "timeout": 0.5})
        reply = c.read()
        self.assertFalse(reply["ok"])
        self.assertIn("did not answer slow", reply["error"])
        self.ff.send({"id": held[0]["id"], "ok": True, "result": "late"})  # must not crash or reach anyone
        c.send({"id": 2, "method": "fast"})
        held.clear()
        c.close()

    def test_a_timeout_that_is_not_a_finite_positive_number_waits_the_default(self):
        # Event.wait(NaN) returns at once: the session heard "did not answer"
        # while Firefox went on to act.
        self.answer(lambda m: (time.sleep(0.4), {"ok": True, "result": m["method"]})[1])
        c = Client(self.host.sock_path)
        c.hello()
        for i, raw in enumerate((b'"NaN"', b"NaN", b"Infinity", b"-1", b"true", b'[60]'), 1):
            c.f.write(b'{"id": %d, "method": "m%d", "timeout": %s}\n' % (i, i, raw))
            c.f.flush()
            reply = c.read()
            self.assertEqual((reply["id"], reply.get("result")), (i, f"m{i}"), raw)
        c.close()

    def _hold(self, held, m):
        held.append(m)
        if m["method"] == "slow":
            time.sleep(1.5)
            return {"ok": True, "result": "too late"}
        return {"ok": True, "result": "fast"}

    def test_bad_request_lines_are_reported_and_the_connection_survives(self):
        self.answer(lambda m: {"ok": True, "result": "fine"})
        c = Client(self.host.sock_path)
        c.hello()
        c.f.write(b"not json\n")
        c.f.flush()
        self.assertIn("bad request", c.read()["error"])
        c.send({"id": 3, "method": "status"})
        self.assertEqual(c.read()["result"], "fine")
        c.close()

    def test_firefox_quitting_removes_socket_and_registry(self):
        self.ff.quit()
        self.thread.join(5)
        self.assertFalse(self.host.sock_path.exists())
        self.assertFalse(self.host.registry_path.exists())

    # both builds installed in one profile started two
    # hosts; the second unlinked the first's live socket and both wrote one
    # approvals file, so one build's Remember undid the other's Forget.
    def test_a_second_host_for_the_profile_refuses_and_leaves_the_first_alone(self):
        ff2 = FakeFirefox()
        second = host.Host(ff2.host_side, {"name": "Profile 4", "dir": "/profiles/p4"}, ["claims.example"], self.run_dir)
        second.claim_wait_s = 0.3
        t2 = threading.Thread(target=second.run, daemon=True)
        t2.start()
        hello = ff2.read()
        self.assertEqual(hello["type"], "hello")
        self.assertRegex(hello.get("refused", ""), r"another Foxlatch add-on.*already.*Profile 4.*about:addons")
        self.assertNotIn("approvals", hello)
        # The add-on's own hello, which every connect sends, leaves the first host's registry alone.
        self.ff.send({"type": "hello", "build": "personal", "scripts": True})
        time.sleep(0.2)
        registry = self.host.registry_path.read_text()
        ff2.send({"type": "hello", "build": "public", "scripts": False})
        time.sleep(0.2)
        self.assertEqual(self.host.registry_path.read_text(), registry, "the refused host rewrote the registry")
        # The first host's socket and registry are untouched and still serve.
        self.assertEqual(json.loads(self.host.registry_path.read_text())["pid"], os.getpid())
        c = Client(self.host.sock_path)
        self.assertTrue(c.hello()["ok"])
        c.close()
        # A remember sent to the refused host writes nothing.
        ff2.send({"type": "remember", "entry": site_entry()})
        reply = ff2.read()
        self.assertEqual(reply["type"], "remembered")
        self.assertRegex(reply.get("error", ""), r"another Foxlatch add-on")
        self.assertFalse(second.approvals_path.exists())
        ff2.quit()
        t2.join(5)
        self.assertFalse(t2.is_alive())
        self.assertTrue(self.host.sock_path.exists(), "the refused host removed the first's socket")

    def test_cleanup_leaves_a_newer_hosts_files_alone(self):
        reg = json.loads(self.host.registry_path.read_text())
        reg["pid"] = os.getpid() + 1
        self.host.registry_path.write_text(json.dumps(reg))
        self.ff.quit()
        self.thread.join(5)
        self.assertTrue(self.host.registry_path.exists())


def site_entry(site="mail.google.com", project="/home/user/projects/acme"):
    return {"project": project, "kind": "site", "site": site, "added": 1762500000000, "label": f"{Path(project).name} · aaaa"}


FN_ENTRY = {"project": "/home/user/Projects/billing", "kind": "function", "origin": "https://portal.acme.example", "sha256": "ab" * 32,
            "added": 1762500000001, "label": "billing · cccc"}


class ApprovalsTest(unittest.TestCase):
    """The remembered approvals file: one per profile, written only by its
    host, only when the add-on asks over the Firefox port."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.run_dir = Path(self.tmp.name) / "state" / "run"
        self.running = []

    def tearDown(self):
        for ff, thread in self.running:
            try:
                ff.quit()
            except OSError:
                pass
            thread.join(5)
        self.tmp.cleanup()

    def start(self, profile=("Profile 4", "/profiles/p4")):
        ff = FakeFirefox()
        h = host.Host(ff.host_side, {"name": profile[0], "dir": profile[1]}, [], self.run_dir)
        thread = threading.Thread(target=h.run, daemon=True)
        thread.start()
        self.running.append((ff, thread))
        return ff, h, ff.read()

    def change(self, ff, op, entry):
        ff.send({"type": op, "entry": entry})
        reply = ff.read()
        self.assertEqual((reply["type"], reply["did"]), ("remembered", {"type": op, "entry": entry}))
        return reply

    def on_disk(self, h):
        return json.loads(h.approvals_path.read_text())

    def test_remember_writes_one_private_file_per_profile_and_forget_removes(self):
        ff, h, hello = self.start()
        self.assertNotIn("approvals", hello)
        reply = self.change(ff, "remember", site_entry())
        self.assertEqual(reply["approvals"], [site_entry()])
        self.assertNotIn("error", reply)
        mode = lambda p: stat.S_IMODE(os.stat(p).st_mode)
        self.assertEqual(h.approvals_path.parent, self.run_dir.parent / "approvals")
        self.assertEqual((mode(h.approvals_path.parent.parent), mode(h.approvals_path.parent), mode(h.approvals_path)), (0o700, 0o700, 0o600))
        self.assertEqual(self.on_disk(h), {"version": 1, "approvals": [site_entry()]})
        self.assertEqual(self.change(ff, "remember", {**site_entry(), "added": 5})["approvals"], [site_entry()])  # the same approval once
        self.assertEqual(self.change(ff, "remember", FN_ENTRY)["approvals"], [site_entry(), FN_ENTRY])
        other_ff, other, _ = self.start(("Personal", "/profiles/personal"))
        self.change(other_ff, "remember", site_entry("acme.example"))
        self.assertNotEqual(other.approvals_path, h.approvals_path)
        self.assertEqual(self.on_disk(h)["approvals"], [site_entry(), FN_ENTRY], "one profile's write touched another's file")
        # Forget matches the approval, not its date or label.
        self.assertEqual(self.change(ff, "forget", {"project": FN_ENTRY["project"], "kind": "function", "origin": FN_ENTRY["origin"],
                                                    "sha256": FN_ENTRY["sha256"]})["approvals"], [site_entry()])
        self.assertEqual(self.on_disk(h)["approvals"], [site_entry()])
        self.assertEqual(sorted(p.name for p in h.approvals_path.parent.iterdir()), sorted([h.approvals_path.name, other.approvals_path.name]))

    def test_a_restarted_host_reads_the_file_and_says_so_in_its_hello(self):
        ff, h, _ = self.start()
        self.change(ff, "remember", FN_ENTRY)
        ff.quit()
        _, _, hello = self.start()
        self.assertEqual(hello["approvals"], [FN_ENTRY])

    def test_a_write_that_fails_at_any_step_leaves_the_old_file_and_says_so(self):
        ff, h, _ = self.start()
        self.change(ff, "remember", site_entry())
        before = h.approvals_path.read_bytes()
        calls = {n: getattr(os, n) for n in ("open", "write", "fsync", "replace")}
        for fail_at in range(20):
            seen = []

            def wrap(name):
                def call(*a, **k):
                    seen.append(name)
                    if len(seen) - 1 == fail_at:
                        raise OSError(f"injected at {name}")
                    return calls[name](*a, **k)
                return call
            with mock.patch.multiple(host.os, **{n: wrap(n) for n in calls}):
                reply = self.change(ff, "remember", FN_ENTRY)
            if "error" not in reply:
                break
            self.assertIn(f"injected at {seen[fail_at]}", reply["error"])
            self.assertEqual(reply["approvals"], [site_entry()], f"failed at {seen[fail_at]} and the entry stood")
            data = h.approvals_path.read_bytes()
            if "replace" not in seen[:fail_at]:  # before the rename, the old file stands whole
                self.assertEqual(data, before, f"the file changed though the write failed at {seen[fail_at]}")
            self.assertEqual(json.loads(data)["version"], 1)  # never torn
            self.assertEqual([p.name for p in h.approvals_path.parent.iterdir()], [h.approvals_path.name], "a temp file was left")
        else:
            self.fail("the write never succeeded")
        self.assertEqual(seen, ["open", "write", "fsync", "replace", "open", "fsync"], "the steps were not open, write, fsync, rename, fsync the directory")
        self.assertEqual(reply["approvals"], [site_entry(), FN_ENTRY])

    def test_an_entry_that_is_not_one_is_refused_and_nothing_is_written(self):
        ff, h, _ = self.start()
        for bad in ({**site_entry(), "kind": "eval"}, {**site_entry(), "site": "Mail.google.com/x"}, {**FN_ENTRY, "sha256": "x" * 64},
                    {**site_entry(), "project": ""}, {**site_entry(), "extra": 1}, "mail.google.com", None,
                    {**site_entry(), "project": "acme"}, {**site_entry(), "project": "/home/user/\u202ebilling"},
                    {**site_entry(), "project": "/home/user/billing\n"}, {**site_entry(), "project": "/" + "x" * 500}):
            reply = self.change(ff, "remember", bad)
            self.assertEqual((reply["approvals"], reply["error"]), ([], "not a valid entry"), bad)
        self.assertFalse(h.approvals_path.exists())

    def test_an_unidentified_profile_reads_and_writes_no_approvals_file(self):
        # Its key comes from Firefox's pid, which a later Firefox (another
        # profile, after a reboot) can reuse: that one would load this one's
        # remembered approvals.
        with mock.patch.object(host, "profile_dir_of", lambda pid: None), \
                mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("FOXLATCH_PROFILE", None)
            profile = host.resolve_profile(4242)
        theirs = self.run_dir.parent / "approvals" / f"{host.socket_key(profile)}.json"
        theirs.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        host.write_approvals(theirs, [site_entry()])
        ff = FakeFirefox()
        h = host.Host(ff.host_side, profile, [], self.run_dir)
        thread = threading.Thread(target=h.run, daemon=True)
        thread.start()
        self.running.append((ff, thread))
        hello = ff.read()
        self.assertNotIn("approvals", hello)
        self.assertIn("could not be identified", hello["approvalsError"])
        ff.send({"type": "forget", "entry": site_entry()})
        reply = ff.read()
        self.assertIn("could not be identified", reply["error"])
        self.assertEqual(json.loads(theirs.read_text())["approvals"], [site_entry()])

    def test_a_session_can_neither_remember_nor_forget(self):
        ff, h, _ = self.start()
        self.change(ff, "remember", site_entry())
        before = h.approvals_path.read_bytes()
        forwarded = []

        def answer():
            while (msg := ff.read(3)) is not None:
                forwarded.append(msg)
                if "id" in msg:
                    ff.send({"id": msg["id"], "ok": False, "error": "unknown method"})
        threading.Thread(target=answer, daemon=True).start()
        c = Client(h.sock_path)
        self.assertTrue(c.hello()["ok"])
        for line in ({"type": "remember", "entry": FN_ENTRY}, {"type": "forget", "entry": site_entry()},
                     {"id": 1, "method": "remember", "params": {"entry": FN_ENTRY}, "type": "remember", "entry": FN_ENTRY},
                     {"id": 2, "method": "forget", "params": {"type": "forget", "entry": site_entry()}}):
            c.send(line)
            self.assertFalse(c.read()["ok"])
        c.close()
        time.sleep(0.3)
        self.assertEqual(h.approvals_path.read_bytes(), before)
        self.assertEqual(h.approvals, [site_entry()])
        # What reached the add-on came as tool calls with the connection's session id, never as a change.
        calls = [m for m in forwarded if "id" in m]
        self.assertEqual([(m["method"], m["sessionId"], "type" in m) for m in calls], [("remember", SID_A, False), ("forget", SID_A, False)])

    def test_the_project_reaches_the_add_on_with_the_session(self):
        ff, h, _ = self.start()
        for project, sid, expected in (("acme", SID_A, "acme"), (["x"], SID_B, ""), (None, "c" * 32, ""),
                                       ("/" + "x" * 5000, "d" * 32, "")):
            c = Client(h.sock_path)
            c.send({"hello": {"protocol": 2, "sessionId": sid, "label": "x · aaaa", "project": project}})
            self.assertTrue(c.read()["ok"])
            opened = ff.read()
            self.assertEqual((opened["type"], opened["project"]), ("opened", expected))
            # F1: the label is the add-on's to derive from the project, never the session's to choose.
            self.assertNotIn("label", opened)
            c.close()
            closed = ff.read()
            self.assertEqual(closed["type"], "closed")
            self.assertNotIn("label", closed)

    # F6: a file the host could not read counted as empty, and the next
    # Remember wrote over it, losing every approval in it without a word.
    def test_an_unreadable_or_wrong_version_file_is_moved_aside_and_a_fresh_one_starts(self):
        path = self.run_dir.parent / "approvals" / f"{host.socket_key({'dir': '/profiles/p4'})}.json"
        path.parent.mkdir(parents=True)
        mode = lambda p: stat.S_IMODE(os.lstat(p).st_mode)
        bads = ('{"version": 1, "approvals": [', '{"version": 2, "approvals": []}', '[]',
                json.dumps({"version": 1, "approvals": [site_entry(), {**FN_ENTRY, "sha256": "short"}]}),
                json.dumps({"version": 1, "approvals": [{**site_entry(), "extra": 1}]}),
                json.dumps({"version": 1, "approvals": [{**site_entry(), "added": True}]}),
                json.dumps({"version": 1, "approvals": [site_entry(project="billing")]}))
        for bad in bads:
            path.write_text(bad)
            os.chmod(path, 0o644)
            ff, h, hello = self.start()
            self.assertNotIn("approvals", hello, bad)
            self.assertFalse(path.exists(), f"left in place for the next remember to overwrite: {bad}")
            [aside] = [p for p in path.parent.iterdir() if p.name.startswith(f"{path.name}.bad-") and p.read_text() == bad]
            self.assertEqual(mode(aside), 0o600)
            self.assertIn(aside.name, hello["approvalsError"])
            self.change(ff, "remember", site_entry())
            self.assertEqual(self.on_disk(h), {"version": 1, "approvals": [site_entry()]})
            self.assertEqual(aside.read_text(), bad)
            ff.quit()
            path.unlink()
        self.assertEqual(len([p for p in path.parent.iterdir() if ".bad-" in p.name]), len(bads), "one file moved aside over another")

    def test_a_file_that_cannot_be_moved_aside_refuses_every_write(self):
        path = self.run_dir.parent / "approvals" / f"{host.socket_key({'dir': '/profiles/p4'})}.json"
        path.parent.mkdir(parents=True)
        path.write_text("not json")
        os.chmod(path.parent, 0o500)
        try:
            ff, h, hello = self.start()
            self.assertIn("could not", hello["approvalsError"])
            reply = self.change(ff, "remember", site_entry())
            self.assertIn("error", reply)
            self.assertEqual(reply["approvals"], [])
        finally:
            os.chmod(path.parent, 0o700)
        self.assertEqual(path.read_text(), "not json")

    # Firefox drops a host message over 1 MB, and the hello and every answer carry the whole list.
    def test_remember_stops_at_the_cap_and_a_file_past_it_is_moved_aside(self):
        path = self.run_dir.parent / "approvals" / f"{host.socket_key({'dir': '/profiles/p4'})}.json"
        path.parent.mkdir(parents=True)
        full = [site_entry(f"s{i}.example") for i in range(host.MAX_APPROVALS)]
        path.write_text(json.dumps({"version": 1, "approvals": full}))
        ff, h, hello = self.start()
        self.assertEqual(len(hello["approvals"]), host.MAX_APPROVALS)
        before = path.read_bytes()
        reply = self.change(ff, "remember", FN_ENTRY)
        self.assertIn(str(host.MAX_APPROVALS), reply["error"])
        self.assertEqual(len(reply["approvals"]), host.MAX_APPROVALS)
        self.assertEqual(path.read_bytes(), before)
        self.assertNotIn("error", self.change(ff, "forget", full[0]))
        self.assertNotIn("error", self.change(ff, "remember", FN_ENTRY), "a forget did not make room")
        ff.quit()
        # Long projects reach the size cap first, well under what Firefox takes.
        wide = "/Users/" + "é" * 390
        long = lambda site: {**site_entry(site, wide), "label": "éé · aaaa"}
        big = []
        while len(json.dumps(big + [long(f"w{len(big)}.example")]).encode()) <= host.MAX_APPROVALS_BYTES:
            big.append(long(f"w{len(big)}.example"))
        self.assertLess(len(big), host.MAX_APPROVALS)
        self.assertLess(host.MAX_APPROVALS_BYTES, 600_000)
        path.write_text(json.dumps({"version": 1, "approvals": big}))
        ff, h, hello = self.start()
        self.assertEqual(len(hello["approvals"]), len(big))
        reply = self.change(ff, "remember", long("one-more.example"))
        self.assertIn("error", reply)
        self.assertEqual(len(reply["approvals"]), len(big))
        ff.quit()
        # A file past either cap is one this host never wrote: moved aside.
        for over in (full + [FN_ENTRY], big + [long("one-more.example")]):
            path.write_text(json.dumps({"version": 1, "approvals": over}))
            ff, h, hello = self.start()
            self.assertNotIn("approvals", hello)
            self.assertIn("approvalsError", hello)
            self.assertFalse(path.exists())
            ff.quit()


class ProfileTest(unittest.TestCase):
    def test_names_come_from_profiles_ini_then_profile_groups_then_the_directory(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for sub in ["Profiles/s05tgCMm.Profile 4", "Profiles/Ab12Cd34.Work", "elsewhere", "Profiles/4kvaja97.default-release"]:
                (root / sub).mkdir(parents=True)
            (root / "profiles.ini").write_text(
                "[Profile1]\nName=Profile 4\nIsRelative=1\nPath=Profiles/s05tgCMm.Profile 4\n\n"
                f"[Profile0]\nName=Personal\nIsRelative=0\nPath={root / 'elsewhere'}\n\n[General]\nVersion=2\n"
            )
            (root / "Profile Groups").mkdir()
            with sqlite3.connect(root / "Profile Groups" / "abc.sqlite") as db:
                db.execute("CREATE TABLE Profiles (id INTEGER PRIMARY KEY, path TEXT, name TEXT)")
                db.execute("INSERT INTO Profiles (path, name) VALUES ('Profiles/Ab12Cd34.Work', 'Acme work')")
            self.assertEqual(host.profile_name(root / "Profiles" / "s05tgCMm.Profile 4", root), "Profile 4")
            self.assertEqual(host.profile_name(root / "elsewhere", root), "Personal")
            self.assertEqual(host.profile_name(root / "Profiles" / "Ab12Cd34.Work", root), "Acme work")
            self.assertEqual(host.profile_name(root / "Profiles" / "4kvaja97.default-release", root), "default-release")
            self.assertEqual(host.profile_name(Path("/x/plain"), root / "missing"), "plain")

    def test_an_unidentifiable_profile_is_labelled_as_such(self):
        os.environ.pop("FOXLATCH_PROFILE", None)
        p = host.resolve_profile(999999)  # no such process
        self.assertIn("unidentified profile", p["name"])

    def test_profile_dir_is_read_from_the_lock_firefox_holds(self):
        with tempfile.TemporaryDirectory() as d:
            lock = Path(d) / ".parentlock"
            with open(lock, "w"):
                self.assertEqual(host.profile_dir_of(os.getpid()).resolve(), Path(d).resolve())


class SocketPlace(unittest.TestCase):
    """AF_UNIX paths are limited (104 bytes with the NUL on macOS, 108 on
    Linux), so a long home directory made the run directory's socket
    unbindable. Such a socket goes to a short directory of this user's under
    /tmp, which must be private; the registry stays in run/ and names it."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.root = Path(self.tmp.name)
        self.short = self.root / "t"  # stands in for /tmp
        self.short.mkdir()
        self.running = []

    def tearDown(self):
        for ff, thread in self.running:
            try:
                ff.quit()
            except OSError:
                pass
            thread.join(5)
        self.tmp.cleanup()

    def long_run_dir(self):
        d = self.root / ("very-long-home-directory-name-" * 3) / "Library" / "Application Support" / "foxlatch" / "run"
        self.assertGreaterEqual(len(str(d / "0123456789abcdef.sock")), 104)
        return d

    def start(self, run_dir):
        ff = FakeFirefox()
        h = host.Host(ff.host_side, {"name": "Profile 4", "dir": "/profiles/p4"}, [], run_dir, socket_root=self.short)
        thread = threading.Thread(target=h.run, daemon=True)
        thread.start()
        self.running.append((ff, thread))
        self.assertEqual(ff.read()["type"], "hello")
        return ff, h

    def test_a_socket_path_that_fits_stays_in_the_run_directory(self):
        _, h = self.start(self.root / "state" / "run")
        self.assertEqual(h.sock_path.parent, self.root / "state" / "run")
        self.assertFalse((self.short / f"foxlatch-{os.geteuid()}").exists())

    def test_a_long_run_directory_binds_in_a_private_short_directory_the_registry_names(self):
        run_dir = self.long_run_dir()
        _, h = self.start(run_dir)
        place = self.short / f"foxlatch-{os.geteuid()}"
        self.assertEqual(h.sock_path, place / f"{host.socket_key({'dir': '/profiles/p4'})}.sock")
        self.assertEqual(stat.S_IMODE(os.lstat(place).st_mode), 0o700)
        reg = json.loads(h.registry_path.read_text())
        self.assertEqual(h.registry_path.parent, run_dir)
        self.assertEqual(reg["socket"], str(h.sock_path))
        [info] = server.discover(run_dir)
        conn = server.Connection(info, "c" * 32)  # the server checks the socket and connects
        self.assertEqual(conn.profile["name"], "Profile 4")
        conn.close()

    def test_a_short_directory_that_is_not_private_is_refused(self):
        place = self.short / f"foxlatch-{os.geteuid()}"
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir(mode=0o700)
        for make, why in [(lambda: place.symlink_to(elsewhere), "is a symlink"), (lambda: place.write_text(""), "is not a directory"),
                          (lambda: place.mkdir(mode=0o755) or os.chmod(place, 0o755), "has mode 0755"),
                          (lambda: place.mkdir(mode=0o700), "belongs to uid")]:
            make()
            ff = FakeFirefox()
            h = host.Host(ff.host_side, {"name": "Profile 4", "dir": "/profiles/p4"}, [], self.long_run_dir(), socket_root=self.short)
            with mock.patch.object(host.paths.os, "geteuid", return_value=os.geteuid() + 1) if why == "belongs to uid" else mock.patch.dict({}):
                with self.assertRaisesRegex(host.paths.NotPrivate, why):
                    h.listen()
            self.assertFalse(h.registry_path.exists(), why)
            ff.quit()
            if place.is_dir() and not place.is_symlink():
                place.rmdir()
            else:
                place.unlink()

    def test_the_server_refuses_a_socket_this_users_host_did_not_make(self):
        _, h = self.start(self.root / "state" / "run")
        [info] = server.discover(h.run_dir)
        os.chmod(h.run_dir, 0o755)
        with self.assertRaisesRegex(server.HostError, "has mode 0755, not 0700"):
            server.Connection(info, "c" * 32)
        os.chmod(h.run_dir, 0o700)
        fake = h.run_dir / "fake.sock"
        fake.write_text("")
        with self.assertRaisesRegex(server.HostError, "is not a socket"):
            server.Connection({**info, "socket": str(fake)}, "c" * 32)
        with mock.patch.object(server.paths.os, "geteuid", return_value=os.geteuid() + 1):
            with self.assertRaisesRegex(server.HostError, "belongs to uid"):
                server.Connection(info, "c" * 32)


class AddonBuild(HostTest):
    """The add-on says its build in its own hello; the registry carries it so
    a session can tell, before it connects, whether scripts exist there."""

    def test_the_add_ons_build_reaches_the_registry_and_nothing_else_does(self):
        self.assertNotIn("build", json.loads(self.host.registry_path.read_text()))
        for bad in [{"build": "Personal", "scripts": True}, {"build": "personal", "scripts": "yes"}, {"build": "x" * 40, "scripts": False}, {}]:
            self.ff.send({"type": "hello", **bad})
        self.ff.send({"type": "hello", "build": "personal", "scripts": True, "extra": "dropped"})
        self.assertTrue(_wait(lambda: json.loads(self.host.registry_path.read_text()).get("build") == "personal"))
        reg = json.loads(self.host.registry_path.read_text())
        self.assertEqual((reg["build"], reg["scripts"], reg["pid"]), ("personal", True, os.getpid()))
        self.assertNotIn("extra", reg)

    # Only HostTest's own fixture is wanted here, not its tests again.
    for _name in [n for n in vars(HostTest) if n.startswith("test_")]:
        locals()[_name] = None


def _wait(check, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if check():
            return True
        time.sleep(0.02)
    return False


class ProfileLookup(unittest.TestCase):
    """Which profile started the host: lsof hard-coded at /usr/sbin, absent
    on Linux. Linux reads /proc; macOS finds lsof or says why it cannot."""

    def test_linux_reads_the_lock_from_proc(self):
        with tempfile.TemporaryDirectory() as d:
            fd = Path(d) / "proc" / "4242" / "fd"
            fd.mkdir(parents=True)
            (fd / "3").symlink_to("/dev/null")
            (fd / "7").symlink_to("/home/u/.mozilla/firefox/ab12cd34.default/.parentlock")
            self.assertEqual(host.profile_dir_of(4242, "linux", Path(d) / "proc"), Path("/home/u/.mozilla/firefox/ab12cd34.default"))
            self.assertIsNone(host.profile_dir_of(4243, "linux", Path(d) / "proc"))  # no such process: unidentified

    def test_only_firefoxs_own_lock_name_counts(self):
        # parent.lock is Windows Firefox's name; any open file so named on
        # macOS or Linux is something else and must not name the profile.
        with tempfile.TemporaryDirectory() as d:
            fd = Path(d) / "proc" / "4242" / "fd"
            fd.mkdir(parents=True)
            (fd / "5").symlink_to("/home/u/Downloads/parent.lock")
            self.assertIsNone(host.profile_dir_of(4242, "linux", Path(d) / "proc"))

    def test_macos_runs_the_system_lsof_before_any_on_path(self):
        ran = []
        def run(argv, **kw):
            ran.append(argv[0])
            return mock.Mock(stdout="")
        with mock.patch.object(host.shutil, "which", return_value="/tmp/elsewhere/lsof"), \
                mock.patch.object(host.os, "access", lambda p, m: p == "/usr/sbin/lsof"), \
                mock.patch.object(host.subprocess, "run", run):
            host.profile_dir_of(4242, "darwin")
        self.assertEqual(ran, ["/usr/sbin/lsof"])

    def test_without_lsof_the_profile_is_unidentified_with_a_reason(self):
        with mock.patch.object(host.shutil, "which", return_value=None), mock.patch.object(host.os, "access", return_value=False), \
                mock.patch.object(host, "log") as logged:
            self.assertIsNone(host.profile_dir_of(os.getpid(), "darwin"))
        self.assertIn("lsof is not in /usr/sbin", logged.call_args[0][0])


if __name__ == "__main__":
    unittest.main()
