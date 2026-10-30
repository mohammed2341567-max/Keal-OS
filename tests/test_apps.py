import json
import struct
import sys
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server  # noqa: E402


def make_app(root, app_id="demo", **over):
    folder = Path(root) / app_id
    folder.mkdir(parents=True, exist_ok=True)
    manifest = {"id": app_id, "name": "Demo", "targets": ["master", "client"], "permissions": ["files"]}
    manifest.update(over)
    (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (folder / "index.html").write_text("<h1>demo</h1>", encoding="utf-8")
    return folder


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.tmp.cleanup()

    def check(self, **over):
        folder = make_app(self.tmp.name, **over)
        return server.load_manifest(folder)

    def test_valid_manifest_defaults(self):
        m, why = self.check()
        self.assertIsNone(why)
        self.assertEqual((m["entry"], m["width"], m["height"], m["permissions"]), ("index.html", 560, 420, ["files"]))

    def test_rejects_bad_manifests(self):
        cases = {"id": "other", "name": "", "targets": [], "targets ": ["tablet"], "permissions": ["root"], "entry": "../x.html",
                 "entry ": "missing.html", "width": 99999, "height": True, "icon": "TOOLONGICON", "description": "x" * 300}
        for key, value in cases.items():
            m, why = self.check(**{key.strip(): value})
            self.assertIsNone(m, key)
            self.assertTrue(why, key)

    def test_folder_name_must_match_id(self):
        folder = make_app(self.tmp.name, "abc")
        data = json.loads((folder / "manifest.json").read_text())
        data["id"] = "evil"
        (folder / "manifest.json").write_text(json.dumps(data))
        self.assertIsNone(server.load_manifest(folder)[0])


class RegistryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.apps = Path(self.tmp.name) / "apps"
        make_app(self.apps, "both")
        make_app(self.apps, "redmi-only", targets=["master"])
        (self.apps / "broken").mkdir()
        (self.apps / "broken" / "manifest.json").write_text("{nope")
        self.state = Path(self.tmp.name) / "apps.json"
        self.reg = server.AppRegistry(self.apps, self.state)

    def tearDown(self):
        self.tmp.cleanup()

    def test_catalog_skips_broken_and_reports_problem(self):
        snap = self.reg.snapshot()
        self.assertEqual(sorted(a["id"] for a in snap["catalog"]), ["both", "redmi-only"])
        self.assertEqual(snap["problems"][0]["folder"], "broken")

    def test_install_rules(self):
        self.reg.change("master", "redmi-only", True)
        with self.assertRaises(server.FsError) as ctx:
            self.reg.change("client", "redmi-only", True)
        self.assertEqual(ctx.exception.code, "app_not_available_for_device")
        for device, app in (("client", "ghost"), ("tablet", "both"), ("master", 5)):
            with self.assertRaises(server.FsError):
                self.reg.change(device, app, True)
        self.assertEqual(self.reg.snapshot()["installed"], {"master": ["redmi-only"], "client": []})

    def test_persist_uninstall_and_rev(self):
        self.reg.change("client", "both", True)
        self.reg.change("client", "both", True)          # idempotent
        self.assertEqual(self.reg.snapshot()["installed"]["client"], ["both"])
        again = server.AppRegistry(self.apps, self.state)
        self.assertEqual(again.snapshot()["installed"]["client"], ["both"])
        before = self.reg.rev
        self.reg.change("client", "both", False)
        self.assertEqual((self.reg.snapshot()["installed"]["client"], self.reg.rev), ([], before + 1))

    def test_removed_app_disappears_from_installed(self):
        self.reg.change("master", "both", True)
        import shutil
        shutil.rmtree(self.apps / "both")
        self.assertEqual(self.reg.snapshot()["installed"]["master"], [])

    def test_corrupt_state_is_safe(self):
        self.state.write_text("[1,2")
        self.assertEqual(server.AppRegistry(self.apps, self.state).snapshot()["installed"], {"master": [], "client": []})


class MediaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "music"
        self.lib = server.MediaLibrary(self.root)
        (self.root / "album").mkdir()
        with wave.open(str(self.root / "album" / "beep.wav"), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
            w.writeframes(struct.pack("<h", 0) * 8000)
        (self.root / "notes.txt").write_text("not music")
        (self.root / ".hidden.mp3").write_bytes(b"x")

    def tearDown(self):
        self.tmp.cleanup()

    def test_list_only_audio_no_hidden(self):
        self.assertEqual([t["path"] for t in self.lib.list()], ["album/beep.wav"])

    def test_resolve_blocks_escape(self):
        self.assertIsNotNone(self.lib.resolve("album/beep.wav"))
        outside = Path(self.tmp.name) / "evil.mp3"
        outside.write_bytes(b"x")
        (self.root / "link.mp3").symlink_to(outside)
        for bad in ("../evil.mp3", "link.mp3", "notes.txt", ".hidden.mp3", "album", "", "a\\b.wav", "/etc/passwd"):
            self.assertIsNone(self.lib.resolve(bad), bad)


class HttpAppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        cls.apps_dir = root / "apps"
        make_app(cls.apps_dir, "demo", targets=["master"])
        media = server.MediaLibrary(root / "music")
        cls.wav = (root / "music" / "beep.wav")
        with wave.open(str(cls.wav), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
            w.writeframes(b"\x00\x00" * 4000)
        cls.size = cls.wav.stat().st_size
        reg = server.AppRegistry(cls.apps_dir, root / "apps.json")
        cls.relay = server.Relay(token="tok", files=server.FileStore(root / "f"), settings=server.SettingsStore(root / "s.json"), apps=reg, media=media)
        cls._old_apps_dir = server.APPS_DIR
        server.APPS_DIR = cls.apps_dir          # serve /apps/* from the temp catalog
        cls.httpd = server.make_server(cls.relay)
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        server.APPS_DIR = cls._old_apps_dir
        cls.httpd.shutdown(); cls.httpd.server_close(); cls.tmp.cleanup()

    def call(self, path, body=None, token="tok", headers=None, raw=False):
        h = dict(headers or {})
        if token:
            h["X-Keal-Token"] = token
        if body is not None:
            h["Content-Type"] = "application/json"
        try:
            with urlopen(Request(self.base + path, data=None if body is None else json.dumps(body).encode(), headers=h), timeout=5) as r:
                data = r.read()
                return r.status, (data if raw else json.loads(data)), r.headers
        except HTTPError as e:
            data = e.read()
            return e.code, (data if raw else (json.loads(data) if data else {})), e.headers

    def test_api_requires_token(self):
        for path, body in (("/api/apps", None), ("/api/media/list", None), ("/api/apps/install", {"device": "master", "id": "demo"})):
            self.assertEqual(self.call(path, body, token=None)[0], 401, path)

    def test_install_over_http_and_status_rev(self):
        rev0 = self.call("/api/status")[1]["apps_rev"]
        code, body, _ = self.call("/api/apps/install", {"device": "master", "id": "demo"})
        self.assertEqual((code, body["installed"]["master"]), (200, ["demo"]))
        self.assertEqual(self.call("/api/status")[1]["apps_rev"], rev0 + 1)
        self.assertEqual(self.call("/api/apps/install", {"device": "client", "id": "demo"})[0], 409)
        self.assertEqual(self.call("/api/apps/uninstall", {"device": "master", "id": "demo"})[0], 200)

    def test_app_files_are_sandboxed_and_traversal_safe(self):
        code, body, headers = self.call("/apps/demo/index.html", token=None, raw=True)
        self.assertEqual(code, 200)
        self.assertIn("sandbox allow-scripts", headers["Content-Security-Policy"])
        for bad in ("/apps/../server.py", "/apps/demo/../../server.py", "/apps/%2e%2e/server.py", "/apps/demo/.secret"):
            self.assertIn(self.call(bad, token=None)[0], (403, 404), bad)

    def test_media_needs_media_token_not_api_token(self):
        _, listing, _ = self.call("/api/media/list")
        mt = listing["media_token"]
        self.assertEqual([t["path"] for t in listing["tracks"]], ["beep.wav"])
        self.assertEqual(self.call("/media/beep.wav", token=None)[0], 401)
        self.assertEqual(self.call("/media/beep.wav?m=tok", token=None)[0], 401)            # API token is NOT a media token
        code, data, h = self.call("/media/beep.wav?m=" + mt, token=None, raw=True)
        self.assertEqual((code, len(data), h["Accept-Ranges"]), (200, self.size, "bytes"))
        self.assertEqual(self.call("/media/..%2Fapps.json?m=" + mt, token=None)[0], 404)
        self.assertEqual(self.call("/media/notes.txt?m=" + mt, token=None)[0], 404)

    def test_media_range_requests(self):
        mt = self.call("/api/media/list")[1]["media_token"]
        code, data, h = self.call("/media/beep.wav?m=" + mt, token=None, headers={"Range": "bytes=100-199"}, raw=True)
        self.assertEqual((code, len(data), h["Content-Range"]), (206, 100, "bytes 100-199/%d" % self.size))
        self.assertEqual(data, self.wav.read_bytes()[100:200])
        code, data, h = self.call("/media/beep.wav?m=" + mt, token=None, headers={"Range": "bytes=-50"}, raw=True)
        self.assertEqual((code, len(data)), (206, 50))
        code, data, h = self.call("/media/beep.wav?m=" + mt, token=None, headers={"Range": "bytes=%d-" % (self.size + 10)}, raw=True)
        self.assertEqual(code, 416)
        self.assertEqual(self.call("/media/beep.wav?m=" + mt, token=None, headers={"Range": "bytes=abc"}, raw=True)[0], 416)


if __name__ == "__main__":
    unittest.main()
