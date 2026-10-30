import io
import json
import sys
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server  # noqa: E402


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def ev(n, etype="pointermove", **kw):
    base = {"type": etype, "n": n}
    if etype in ("keydown", "keyup"):
        base.update(key="a", code="KeyA")
    else:
        base.update(x=10, y=20)
    base.update(kw)
    return base


class RelayLogicTests(unittest.TestCase):
    def setUp(self):
        self.clk = Clock()
        self.r = server.Relay(clock=self.clk, token="tok")

    def pair(self, c="c1", k="k1"):
        self.r.heartbeat("controller", c)
        self.r.heartbeat("client", k)

    def go_remote(self):
        self.pair()
        code, body = self.r.set_focus("samsung")
        self.assertEqual(code, 200)
        return body["focus_revision"]

    def test_safe_defaults_after_restart(self):
        st = self.r.status()
        self.assertEqual((st["input_target"], st["focus_revision"], st["latest_seq"]), ("local", 0, 0))
        self.assertFalse(st["controller_online"] or st["client_online"])

    def test_heartbeats_are_independent(self):
        self.r.heartbeat("client", "k1")
        st = self.r.status()
        self.assertTrue(st["client_online"])
        self.assertFalse(st["controller_online"])
        self.r.heartbeat("controller", "c1")
        self.clk.now += 5
        self.r.heartbeat("controller", "c1")
        self.clk.now += 4          # client now 9s old, controller 4s
        st = self.r.status()
        self.assertFalse(st["client_online"])
        self.assertTrue(st["controller_online"])

    def test_focus_requires_both_online(self):
        self.r.heartbeat("client", "k1")
        code, body = self.r.set_focus("samsung")
        self.assertEqual((code, body["error"]), (409, "controller_offline"))
        self.r.heartbeat("controller", "c1")
        self.clk.now += 8
        self.r.heartbeat("controller", "c1")
        code, body = self.r.set_focus("samsung")
        self.assertEqual((code, body["error"]), (409, "client_offline"))

    def test_focus_switch_increments_revision_once(self):
        self.pair()
        _, a = self.r.set_focus("samsung")
        _, b = self.r.set_focus("samsung")
        self.assertEqual(a["focus_revision"], b["focus_revision"])
        _, c = self.r.set_focus("local")
        self.assertEqual(c["focus_revision"], a["focus_revision"] + 1)
        self.assertEqual(self.r.set_focus("bogus")[0], 400)

    def test_events_rejected_when_local_or_offline(self):
        self.pair()
        code, body = self.r.submit([ev(1)], 0)
        self.assertEqual((code, body["reason"]), (409, "local_focus"))
        rev = self.go_remote()
        self.clk.now += 4
        self.r.heartbeat("controller", "c1")        # client now 4s old: still ok
        self.assertEqual(self.r.submit([ev(1)], rev)[0], 200)
        self.clk.now += 4
        self.r.heartbeat("controller", "c1")        # client 8s old -> offline
        code, body = self.r.submit([ev(2)], rev)
        self.assertEqual(code, 409)
        self.assertEqual(body["input_target"], "local")

    def test_controller_offline_rejects_and_reverts(self):
        rev = self.go_remote()
        self.clk.now += 8
        self.r.heartbeat("client", "k1")
        code, body = self.r.submit([ev(1)], rev)
        self.assertEqual(code, 409)
        self.assertEqual(self.r.status()["focus_reason"], "controller_offline")

    def test_stale_revision_rejected(self):
        rev = self.go_remote()
        self.r.set_focus("local")
        self.r.set_focus("samsung")
        code, body = self.r.submit([ev(1)], rev)
        self.assertEqual((code, body["reason"]), (409, "focus_revision_changed"))
        self.assertEqual(self.r.submit([ev(1)], "1")[0], 409)
        self.assertEqual(self.r.submit([ev(1)], True)[0], 409)

    def test_validation(self):
        rev = self.go_remote()
        bad = [{"type": "shell", "n": 1}, "x", ev(1, x="a"), ev(1, x=float("nan")),
               ev(1, "keydown", key=""), ev(1, "keydown", key="k" * 40), ev(1, button=9),
               ev(1, ctrlKey="yes"), {"type": "click", "x": 1, "y": 1}, ev(0)]
        code, body = self.r.submit(bad, rev)
        self.assertEqual((body["accepted"], body["invalid"]), (0, len(bad)))
        code, body = self.r.submit([ev(1, x=5000, y=-9)], rev)
        self.assertEqual(body["accepted"], 1)
        got = self.r.poll(0, rev, 0)["events"][0]
        self.assertEqual((got["x"], got["y"]), (1280.0, 0.0))
        self.assertNotIn("evil", json.dumps(got))

    def test_ordering_and_duplicates(self):
        rev = self.go_remote()
        _, b1 = self.r.submit([ev(1), ev(2), ev(3)], rev)
        self.assertEqual(b1["accepted"], 3)
        _, b2 = self.r.submit([ev(2), ev(3), ev(4)], rev)     # retry overlap
        self.assertEqual((b2["accepted"], b2["duplicate"]), (1, 2))
        _, b3 = self.r.submit([ev(6), ev(5)], rev)            # out of order inside batch
        self.assertEqual((b3["accepted"], b3["duplicate"]), (1, 1))
        seqs = [e["seq"] for e in self.r.poll(0, rev, 0)["events"]]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(self.r.poll(3, rev, 0)["events"][0]["seq"], 4)

    def test_focus_change_discards_queue(self):
        rev = self.go_remote()
        self.r.submit([ev(1, "keydown")], rev)
        self.r.set_focus("local")
        self.r.set_focus("samsung")
        new = self.r.status()["focus_revision"]
        self.assertEqual(self.r.poll(0, new, 0)["events"], [])
        self.assertTrue(self.r.poll(0, rev, 0)["reset"])

    def test_reconnect_never_replays_or_resumes(self):
        rev = self.go_remote()
        self.r.submit([ev(1, "keydown")], rev)
        self.clk.now += 20                                    # both drop offline
        self.pair("c1", "k1")
        st = self.r.status()
        self.assertEqual(st["input_target"], "local")
        self.assertGreater(st["focus_revision"], rev)
        self.assertEqual(self.r.poll(0, None, 0)["events"], [])
        code, _ = self.r.submit([ev(2, "keydown")], rev)
        self.assertEqual(code, 409)

    def test_page_reload_while_remote_returns_local(self):
        self.go_remote()
        self.r.heartbeat("client", "k2-new-page")
        st = self.r.status()
        self.assertEqual((st["input_target"], st["focus_reason"]), ("local", "client_reconnected"))

    def test_longpoll_wakes_on_event(self):
        import time as _t
        real = server.Relay(token="t")
        real.heartbeat("controller", "c")
        real.heartbeat("client", "k")
        _, f = real.set_focus("samsung")
        out = {}
        th = threading.Thread(target=lambda: out.update(real.poll(0, f["focus_revision"], 5)))
        th.start()
        _t.sleep(0.2)
        real.submit([ev(1)], f["focus_revision"])
        th.join(3)
        self.assertEqual(len(out["events"]), 1)

    def test_allowed_ip(self):
        for ok in ("127.0.0.1", "192.168.1.5", "10.0.0.2", "::1", "::ffff:192.168.0.9"):
            self.assertTrue(server.allowed_ip(ok), ok)
        for bad in ("8.8.8.8", "93.184.216.34", "garbage"):
            self.assertFalse(server.allowed_ip(bad), bad)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.clk = Clock()
        cls.relay = server.Relay(clock=cls.clk, token="secret-token")
        cls.httpd = server.make_server(cls.relay)
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def call(self, path, payload=None, token="secret-token", raw=None):
        body = raw if raw is not None else (None if payload is None else json.dumps(payload).encode())
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Keal-Token"] = token
        req = Request(self.base + path, data=body, headers=headers, method="POST" if body is not None else "GET")
        try:
            with urlopen(req, timeout=5) as r:
                data = r.read()
                return r.status, (json.loads(data) if r.headers["Content-Type"].startswith("application/json") else data.decode())
        except HTTPError as e:
            return e.code, json.loads(e.read())

    def test_pages_and_token_injection(self):
        for path in ("/", "/client", "/workspace?mode=control", "/style.css"):
            code, body = self.call(path, token=None)
            self.assertEqual(code, 200, path)
        _, html = self.call("/", token=None)
        self.assertIn('name="keal-token" content="secret-token"', html)
        self.assertNotIn("__KEAL_V__", html)

    def test_api_requires_token(self):
        self.assertEqual(self.call("/api/status", token=None)[0], 401)
        self.assertEqual(self.call("/api/status", token="nope")[0], 401)
        self.assertEqual(self.call("/api/heartbeat", {"role": "client", "instance": "a"}, token="nope")[0], 401)
        self.assertEqual(self.call("/api/status")[0], 200)

    def test_malformed_requests(self):
        self.assertEqual(self.call("/api/heartbeat", raw=b"{not json")[0], 400)
        self.assertEqual(self.call("/api/heartbeat", raw=b"[1,2]")[0], 400)
        self.assertEqual(self.call("/api/heartbeat", {"role": "admin", "instance": "a"})[0], 400)
        self.assertEqual(self.call("/api/heartbeat", {"role": "client"})[0], 400)
        self.assertEqual(self.call("/api/events", {"events": "x", "focus_revision": 0})[0], 400)
        self.assertEqual(self.call("/api/events", {"events": [ev(i) for i in range(1, 102)], "focus_revision": 0})[0], 400)
        self.assertEqual(self.call("/api/events", raw=b"x" * 70000)[0], 400)
        self.assertEqual(self.call("/api/status")[0], 200)     # server still alive
        self.assertIn(self.call("/../server.py", token=None)[0], (403, 404))
        self.assertIn(self.call("/web/../../etc/passwd", token=None)[0], (403, 404))

    def test_full_pipeline_and_no_typed_text_in_logs(self):
        self.call("/api/heartbeat", {"role": "controller", "instance": "c"})
        self.call("/api/heartbeat", {"role": "client", "instance": "k"})
        code, f = self.call("/api/focus", {"target": "samsung"})
        self.assertEqual(code, 200)
        rev = f["focus_revision"]
        buf = io.StringIO()
        with redirect_stdout(buf):
            code, r = self.call("/api/events", {"events": [ev(1, "keydown", key="SUPERSECRETPW")], "focus_revision": rev})
            _, polled = self.call("/api/events?since=0&rev=%d&wait=0&t=secret-token" % rev)
            self.call("/api/focus", {"target": "bogus"})
        self.assertEqual(r["accepted"], 1)
        self.assertEqual(polled["events"][0]["key"], "SUPERSECRETPW")
        self.assertNotIn("SUPERSECRETPW", buf.getvalue())
        self.assertNotIn("secret-token", buf.getvalue())
        self.call("/api/focus", {"target": "local"})


if __name__ == "__main__":
    unittest.main()
