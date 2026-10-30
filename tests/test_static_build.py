from __future__ import annotations
import json
import subprocess
import sys
import unittest
from pathlib import Path
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "public"


class StaticWebBuildTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        subprocess.run([sys.executable, str(ROOT / "scripts" / "build_web.py")], cwd=ROOT, check=True, capture_output=True, text=True)

    def test_master_page_uses_relative_assets_and_web_mode(self):
        html = (PUBLIC / "index.html").read_text(encoding="utf-8")
        self.assertIn('<base href="./">', html)
        self.assertIn('name="keal-mode" content="web"', html)
        self.assertIn('src="cloud.js?v=6.1.0"', html)
        self.assertNotIn('src="/cloud.js', html)
        self.assertNotIn('href="/style.css', html)

    def test_client_page_base_resolves_assets_to_site_root(self):
        html = (PUBLIC / "client" / "index.html").read_text(encoding="utf-8")
        self.assertIn('<base href="../">', html)
        self.assertIn('name="keal-mode" content="web"', html)
        client_url = "https://example.github.io/project/client/index.html"
        base_url = urljoin(client_url, "../")
        resolved = urljoin(base_url, "config.js")
        self.assertEqual(urlparse(resolved).path, "/project/config.js")
        self.assertIn('src="workspace.js?v=6.1.0"', html)

    def test_client_mode_detection_supports_project_pages_subpath(self):
        source = (ROOT / "web" / "workspace.js").read_text(encoding="utf-8")
        self.assertIn("/\\/client\\/index\\.html$/", source)
        self.assertIn("const inferredClient", source)

    def test_app_catalog_and_music_app_are_packaged(self):
        catalog = json.loads((PUBLIC / "apps-catalog.json").read_text(encoding="utf-8"))
        ids = {app["id"] for app in catalog["catalog"]}
        self.assertIn("music", ids)
        self.assertTrue((PUBLIC / "apps" / "music" / "index.html").is_file())
        self.assertTrue((PUBLIC / "keal-sdk.js").is_file())

    def test_version_file_and_browser_config_match(self):
        version = json.loads((PUBLIC / "version.json").read_text(encoding="utf-8"))["version"]
        config = (PUBLIC / "config.js").read_text(encoding="utf-8")
        self.assertEqual(version, "6.1.0")
        self.assertIn(f'appVersion: "{version}"', config)


    def test_python_and_javascript_runtime_are_included_in_web_build(self):
        master = (PUBLIC / "index.html").read_text(encoding="utf-8")
        client = (PUBLIC / "client" / "index.html").read_text(encoding="utf-8")
        workspace_js = (ROOT / "web" / "workspace.js").read_text(encoding="utf-8")
        runtime_js = (PUBLIC / "runtime.js").read_text(encoding="utf-8")
        worker_js = (PUBLIC / "python-worker.js").read_text(encoding="utf-8")
        self.assertIn('src="runtime.js?v=6.1.0"', client)
        self.assertNotIn('runtime.js', master)
        self.assertIn('data-runtime-tab="python"', workspace_js)
        self.assertIn('data-runtime-tab="javascript"', workspace_js)
        self.assertIn("PYODIDE_VERSION = '314.0.7'", worker_js)
        self.assertIn("new Worker", runtime_js)
        self.assertIn("python-worker.js", runtime_js)

    def test_pages_workflow_builds_public_directory(self):
        workflow = (ROOT / ".github" / "workflows" / "pages.yml").read_text(encoding="utf-8")
        self.assertIn("python scripts/build_web.py", workflow)
        self.assertIn("path: public", workflow)
        self.assertIn("python -m unittest discover -s tests -v", workflow)
        self.assertIn("python -m compileall -q server.py scripts tests", workflow)
        self.assertIn("node --check", workflow)


if __name__ == "__main__":
    unittest.main()
