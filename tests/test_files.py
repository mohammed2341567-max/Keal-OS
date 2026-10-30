import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


class FileStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "files"
        self.fs = server.FileStore(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def err(self, fn, *a, **k):
        with self.assertRaises(server.FsError) as ctx:
            fn(*a, **k)
        return ctx.exception

    def test_seeded_on_first_run_only(self):
        self.assertTrue((self.root / "notes/quick-notes.md").is_file())
        (self.root / "notes/quick-notes.md").write_text("mine", encoding="utf-8")
        server.FileStore(self.root)
        self.assertEqual((self.root / "notes/quick-notes.md").read_text(), "mine")

    def test_path_escapes_rejected(self):
        for bad in ("../x.txt", "a/../../x.txt", "/etc/passwd", "a\\b.txt", ".hidden.txt", "a/.git/x.txt", "x\x00.txt", "a:b.txt", "q" * 300):
            self.assertEqual(self.err(self.fs.read, bad).status, 400, bad)
            self.assertEqual(self.err(self.fs.write, bad, "x").status, 400, bad)

    def test_symlink_escape_rejected(self):
        outside = Path(self.tmp.name) / "secret.txt"
        outside.write_text("top secret")
        (self.root / "link.txt").symlink_to(outside)
        (self.root / "dirlink").symlink_to(Path(self.tmp.name))
        self.assertEqual(self.err(self.fs.read, "link.txt").code, "symlink_not_allowed")
        self.assertEqual(self.err(self.fs.read, "dirlink/secret.txt").code, "symlink_not_allowed")
        self.assertEqual(self.err(self.fs.write, "dirlink/new.txt", "x").code, "symlink_not_allowed")
        names = [e["name"] for e in self.fs.list("")["entries"]]
        self.assertNotIn("link.txt", names)
        self.assertNotIn("dirlink", names)

    def test_only_text_types_and_sizes(self):
        self.assertEqual(self.err(self.fs.write, "run.sh", "rm -rf").status, 415)
        self.assertEqual(self.err(self.fs.write, "song.mp3", "x").status, 415)
        self.assertEqual(self.err(self.fs.write, "big.txt", "a" * (server.MAX_WRITE + 1)).status, 413)
        (self.root / "bin.txt").write_bytes(b"\xff\xfe\x00bad")
        self.assertEqual(self.err(self.fs.read, "bin.txt").code, "not_utf8_text")
        (self.root / "photo.png").write_bytes(b"x")
        self.assertNotIn("photo.png", [e["name"] for e in self.fs.list("")["entries"]])

    def test_versions_conflicts_and_force(self):
        w1 = self.fs.write("code/a.py", "one")                       # create: base None
        self.assertEqual(self.err(self.fs.write, "code/a.py", "dup").code, "conflict")   # already exists
        w2 = self.fs.write("code/a.py", "two", base=w1["version"])
        e = self.err(self.fs.write, "code/a.py", "stale", base=w1["version"])
        self.assertEqual((e.status, e.extra["current"]["content"], e.extra["current"]["version"]), (409, "two", w2["version"]))
        self.assertEqual(self.fs.read("code/a.py")["content"], "two")      # stale write did not land
        self.fs.write("code/a.py", "mine", base="nope", force=True)
        self.assertEqual(self.fs.read("code/a.py")["content"], "mine")

    def test_rev_increments_and_no_temp_files(self):
        before = self.fs.rev
        self.fs.write("n.md", "x")
        self.fs.mkdir("d")
        self.fs.delete("n.md")
        self.assertEqual(self.fs.rev, before + 3)
        self.assertEqual([p for p in self.root.rglob(".*tmp")], [])

    def test_delete_rules(self):
        self.fs.write("d/x.txt", "x")
        self.assertEqual(self.err(self.fs.delete, "d").code, "folder_not_empty")
        self.fs.delete("d/x.txt")
        self.fs.delete("d")
        self.assertEqual(self.err(self.fs.delete, "d").status, 404)
        self.assertEqual(self.err(self.fs.delete, "").status, 400)

    def test_unicode_content_roundtrip(self):
        text = "مرحبا Keal ✓\nline2"
        v = self.fs.write("notes/ar.md", text)["version"]
        got = self.fs.read("notes/ar.md")
        self.assertEqual((got["content"], got["version"]), (text, v))


class SettingsTests(unittest.TestCase):
    def test_validation_and_persistence(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "s" / "settings.json"
            st = server.SettingsStore(path)
            self.assertEqual(st.get()["wallpaper_master"], "midnight")
            st.update("wallpaper_master", "aurora")
            for key, val in (("wallpaper_master", "<script>"), ("nope", "aurora"), ("wallpaper_client", 5)):
                with self.assertRaises(server.FsError):
                    st.update(key, val)
            self.assertEqual(server.SettingsStore(path).get()["wallpaper_master"], "aurora")   # survives restart
            path.write_text("{garbage", encoding="utf-8")
            self.assertEqual(server.SettingsStore(path).get()["wallpaper_master"], "midnight")  # corrupt file -> safe default


class HttpFsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        fs = server.FileStore(Path(cls.tmp.name) / "f")
        st = server.SettingsStore(Path(cls.tmp.name) / "s.json")
        cls.relay = server.Relay(token="tok", files=fs, settings=st)
        cls.httpd = server.make_server(cls.relay)
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def call(self, path, payload=None, token="tok"):
        data = None if payload is None else json.dumps(payload).encode()
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-Keal-Token"] = token
        try:
            with urlopen(Request(self.base + path, data=data, headers=headers), timeout=5) as r:
                return r.status, json.loads(r.read())
        except HTTPError as e:
            return e.code, json.loads(e.read())

    def test_requires_token(self):
        for path, body in (("/api/fs/list?path=", None), ("/api/fs/read?path=README.txt", None), ("/api/settings", None),
                           ("/api/fs/write", {"path": "a.txt", "content": "x"}), ("/api/settings", {"key": "wallpaper_master", "value": "aurora"})):
            self.assertEqual(self.call(path, body, token=None)[0], 401, path)

    def test_roundtrip_conflict_and_status_rev(self):
        _, s0 = self.call("/api/status")
        code, w = self.call("/api/fs/write", {"path": "notes/t.md", "content": "hello"})
        self.assertEqual(code, 200)
        _, s1 = self.call("/api/status")
        self.assertEqual(s1["files_rev"], s0["files_rev"] + 1)
        code, r = self.call("/api/fs/read?path=notes/t.md")
        self.assertEqual((code, r["content"]), (200, "hello"))
        code, c = self.call("/api/fs/write", {"path": "notes/t.md", "content": "other", "base": "stale"})
        self.assertEqual((code, c["error"], c["current"]["content"]), (409, "conflict", "hello"))
        code, b = self.call("/api/fs/read?path=../server.py")
        self.assertEqual((code, b["error"]), (400, "bad_path"))
        self.assertEqual(self.call("/api/fs/write", {"path": "x.sh", "content": "x"})[0], 415)
        self.assertEqual(self.call("/api/fs/write", {"path": "x.txt", "content": 5})[0], 400)

    def test_settings_over_http_and_in_status(self):
        code, r = self.call("/api/settings", {"key": "wallpaper_client", "value": "nebula"})
        self.assertEqual((code, r["settings"]["wallpaper_client"]), (200, "nebula"))
        self.assertEqual(self.call("/api/status")[1]["settings"]["wallpaper_client"], "nebula")
        self.assertEqual(self.call("/api/settings", {"key": "wallpaper_client", "value": "red;}"})[0], 400)


if __name__ == "__main__":
    unittest.main()
