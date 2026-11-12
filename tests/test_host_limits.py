"""Host: input from a session that could end everyone's control, and is refused instead.

Run: python3 -m unittest discover -s tests
Reuses the real-pipe fixture from test_host.py.
"""

import json
import os
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

import test_host
from test_host import SID_A, SID_B, Client, host


class HostLimits(test_host.HostTest):
    def test_a_request_too_big_for_firefox_is_refused_before_it_reaches_the_port(self):
        # Firefox drops the native port on a host message over 1 MB, which ends
        # every session's control; the host answers with an error instead.
        self.answer(lambda m: {"ok": True, "result": "fine"})
        c = Client(self.host.sock_path)
        c.hello()
        c.send({"id": 1, "method": "eval", "params": {"tabId": 1, "code": "x" * 1_100_000}})
        reply = c.read()
        self.assertFalse(reply["ok"])
        self.assertIn("limit", reply["error"])
        c.send({"id": 2, "method": "status"})
        self.assertEqual(c.read()["result"], "fine")  # the port is still up
        c.close()

    def test_malformed_hellos_and_requests_get_an_answer(self):
        for first in (b"[1]\n", b'"x"\n', b"[" * 100_000 + b"\n"):
            c = Client(self.host.sock_path)
            c.f.write(first)
            c.f.flush()
            self.assertEqual(c.read(), {"ok": False, "error": "expected hello"}, first[:10])
            c.close()
        self.answer(lambda m: {"ok": True, "result": "fine"})
        c = Client(self.host.sock_path)
        self.assertTrue(c.hello(SID_A)["ok"])
        for line in (b"[1]\n", b'{"id": 1, "method": "status", "params": [1]}\n', b"[" * 100_000 + b"\n"):
            c.f.write(line)
            c.f.flush()
            self.assertIn("bad request", c.read()["error"])
        c.send({"id": 2, "method": "status"})
        self.assertEqual(c.read()["result"], "fine")
        c.close()


    # Phase 1 (2026-11-07 release review): a hello or request line was read
    # whole however long it was, a connection could wait forever before its
    # hello, and connections and requests in flight each took a thread without
    # limit, so one local process could exhaust the host every session shares.

    def test_an_oversized_hello_is_refused_before_the_rest_of_it_arrives(self):
        c = Client(self.host.sock_path)

        def flood():  # no end of line, ever; the host stops reading and hangs up partway
            try:
                c.s.sendall(b'{"hello": "' + b"x" * 300_000)
            except OSError:
                pass

        threading.Thread(target=flood, daemon=True).start()
        reply = c.read()
        self.assertFalse(reply["ok"])
        self.assertIn("expected hello: the first line is over", reply["error"])
        # And the connection is closed: macOS ends the stream, Linux resets it,
        # as the host hangs up with the rest of the flood unread.
        try:
            self.assertIsNone(c.read())
        except ConnectionResetError:
            pass
        c.close()

    def test_an_oversized_request_is_refused_before_the_rest_of_it_arrives_and_the_connection_goes_on(self):
        self.answer(lambda m: {"ok": True, "result": "fine"})
        c = Client(self.host.sock_path)
        c.hello()
        c.f.write(b'{"id": 7, "method": "eval", "params": {"code": "' + b"x" * 1_000_000)
        c.f.flush()
        reply = c.read()  # before the line ends
        self.assertEqual((reply["id"], reply["ok"]), (7, False))
        self.assertIn("the limit is", reply["error"])
        c.f.write(b"x" * 500_000 + b'"}}\n')
        c.f.flush()
        c.send({"id": 8, "method": "status"})
        self.assertEqual(c.read(), {"id": 8, "ok": True, "result": "fine"})
        c.close()

    def test_a_hello_must_arrive_within_the_deadline_however_slowly_it_trickles(self):
        self.host.hello_timeout_s = 0.5
        idle = Client(self.host.sock_path)
        slow = Client(self.host.sock_path)
        stop = threading.Event()

        def trickle():
            for ch in b'{"hello": {"protocol": 2, "sessionId": "' + b"a" * 32:
                if stop.wait(0.1):
                    return
                try:
                    slow.s.sendall(bytes([ch]))
                except OSError:
                    return

        threading.Thread(target=trickle, daemon=True).start()
        start = time.monotonic()
        for c in (idle, slow):
            reply = c.read()
            self.assertFalse(reply["ok"])
            self.assertIn("expected hello within 0.5 s", reply["error"])
        self.assertLess(time.monotonic() - start, 2)
        stop.set()
        for c in (idle, slow):
            c.close()

    def test_connections_past_the_cap_are_refused_and_a_closed_one_frees_its_place(self):
        self.host.max_connections = 2
        first = Client(self.host.sock_path)
        self.assertTrue(first.hello(SID_A)["ok"])
        second = Client(self.host.sock_path)
        self.assertTrue(second.hello(SID_B)["ok"])
        third = Client(self.host.sock_path)
        reply = third.read()
        self.assertFalse(reply["ok"])
        self.assertIn("too many connections to this profile's host (2)", reply["error"])
        third.close()
        first.close()
        deadline = time.monotonic() + 3
        while True:
            again = Client(self.host.sock_path)
            try:
                reply = again.hello("c" * 32)
            except OSError:  # still full: the host refused and hung up before the hello went out
                reply = None
            if reply and reply["ok"]:
                break
            try:
                again.close()
            except OSError:  # the unsent hello, flushed on close to a socket the host closed
                pass
            self.assertLess(time.monotonic(), deadline, "a closed connection never freed its place")
            time.sleep(0.05)
        again.close()
        second.close()

    def test_requests_in_flight_past_the_cap_are_refused_and_an_answer_frees_a_place(self):
        self.host.max_in_flight = 2
        go = threading.Event()
        self.answer(lambda m: (go.wait(5), {"ok": True, "result": m["params"].get("n")})[1])
        c = Client(self.host.sock_path)
        c.hello()
        for n in (1, 2, 3):
            c.send({"id": n, "method": "status", "params": {"n": n}})
        reply = c.read()
        self.assertEqual((reply["id"], reply["ok"]), (3, False))
        self.assertIn("too many requests in flight on this connection (2)", reply["error"])
        go.set()
        self.assertEqual(sorted(c.read()["result"] for _ in range(2)), [1, 2])
        c.send({"id": 4, "method": "status", "params": {"n": 4}})
        self.assertEqual(c.read(), {"id": 4, "ok": True, "result": 4})
        c.close()

    # The per-connection count ended with its connection while its workers
    # still waited on Firefox, so hanging up and reconnecting multiplied them.
    def test_workers_of_a_closed_connection_still_count_against_the_host_wide_cap_until_they_finish(self):
        self.host.max_in_flight = 2
        self.host.max_workers = 3
        go = threading.Event()
        self.answer(lambda m: (go.wait(5), {"ok": True, "result": m["params"].get("n")})[1])
        first = Client(self.host.sock_path)
        first.hello(SID_A)
        for n in (1, 2, 0):
            first.send({"id": n, "method": "status", "params": {"n": n}})
        self.assertEqual(first.read()["id"], 0)  # refused on this connection, so 1 and 2 hold workers
        first.close()  # its two workers wait on Firefox still
        c = Client(self.host.sock_path)
        self.assertTrue(c.hello(SID_B)["ok"])
        for n in (3, 4):
            c.send({"id": n, "method": "status", "params": {"n": n}})
        try:
            reply = c.read()
        except TimeoutError:
            self.fail("a fourth worker started past the host-wide cap of three")
        self.assertEqual((reply["id"], reply["ok"]), (4, False))
        self.assertIn("too many requests waiting on Firefox across this profile's sessions (3)", reply["error"])
        go.set()
        self.assertEqual(c.read(), {"id": 3, "ok": True, "result": 3})
        # The closed connection's workers finish too, and free their places.
        deadline = time.monotonic() + 3
        n = 5
        while True:
            c.send({"id": n, "method": "status", "params": {"n": n}})
            reply = c.read()
            if reply["ok"]:
                break
            self.assertLess(time.monotonic(), deadline, "a finished worker never freed its place")
            time.sleep(0.05)
            n += 1
        c.close()

# The fixture's own tests run from test_host.py; only the tests above run here.
for _name in [n for n in vars(test_host.HostTest) if n.startswith("test_")]:
    setattr(HostLimits, _name, None)

class BrokenConfig(unittest.TestCase):
    """config.json, missing or broken (Phase 1, 2026-11-07): a file that did
    not parse, or held a wrong type, became empty lists, dropping every
    deny, protect and exclusive rule without a word."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.path = Path(self.tmp.name) / "config.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_the_real_host_reports_a_broken_config_in_its_hello(self):
        self.path.write_text('{"deny": ["claims.example.org"],}')  # a trailing comma
        env = {**os.environ, "FOXLATCH_STATE_DIR": self.tmp.name, "FOXLATCH_PROFILE": "Profile 4\t/profiles/p4"}
        proc = subprocess.Popen([sys.executable, str(Path(host.__file__))], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, env=env)
        try:
            (length,) = struct.unpack("=I", proc.stdout.read(4))
            hello = json.loads(proc.stdout.read(length))
        finally:
            proc.stdin.close()
            proc.wait(5)
            log = proc.stderr.read().decode()
            proc.stdout.close()
            proc.stderr.close()
        self.assertEqual(hello["type"], "hello")
        self.assertIn("not valid JSON", hello.get("configError", ""), hello)
        self.assertEqual(hello["deny"], [])
        self.assertIn("broken", log)

    def test_missing_is_empty_and_anything_wrong_is_an_error_never_a_skipped_rule(self):
        empty = {"deny": [], "protect": [], "exclusive": []}
        self.assertEqual(host.load_config(self.path), (empty, None))
        for text, why in [
            (b"{", "not valid JSON"), (b"[]", "not a JSON object"), (b"\xff\xfe", "could not be read"),
            (b'{"deny": "claims.example.org"}', '"deny" is not a list'),
            (b'{"protected": ["portal.example.com"]}', 'the key "protected", which it does not know'),
            (b'{"deny": ["https://claims.example.org"]}', "has a scheme"), (b'{"deny": ["claims.example.org/login"]}', "has a path"),
            (b'{"protect": ["portal.example.com:8443"]}', "has a port"), (b'{"deny": ["*.example.org"]}', "has a wildcard"),
            (b'{"deny": [""]}', "is not a host name"), (b'{"deny": [42]}', "42 is not a host name"),
            (b'{"exclusive": [["portal.example.org", 3]]}', "3 is not a host name"), (b'{"exclusive": [[]]}', "group is empty"),
            (b'{"protect": ["login idp.test"]}', "is not a host name"),
        ]:
            self.path.write_bytes(text)
            lists, error = host.load_config(self.path)
            self.assertEqual(lists, empty, text)
            self.assertIn(why, error or "", text)
        self.path.write_text('{"deny": ["claims.example.org"], "protect": ["Bücher.example"], "exclusive": ["a.test", ["b.test", "idp.test"]]}')
        self.assertEqual(host.load_config(self.path), ({"deny": ["claims.example.org"], "protect": ["Bücher.example"],
                                                       "exclusive": ["a.test", ["b.test", "idp.test"]]}, None))


class ClosedPort(unittest.TestCase):
    """Seen 2026-11-07: after Firefox closed the host's stdout, a session
    thread telling it "closed" died with ValueError (write to closed file),
    which the callers of send, catching OSError, did not expect."""

    def test_a_send_after_firefox_closed_the_port_is_an_oserror(self):
        import io
        writer = io.BytesIO()
        port = host.Firefox(io.BytesIO(), writer)
        writer.close()
        with self.assertRaises(OSError):
            port.send({"type": "closed", "sessionId": "s"})


if __name__ == "__main__":
    unittest.main()
