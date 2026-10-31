"""relay.js URL helper: Home must stay server-rooted, Web must stay base-relative (regression: 6.1.0 Music 404)."""
import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = r"""
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(process.argv[1], 'utf8');
function run(mode, rootRel, href) {
  const metas = { 'keal-mode': mode, 'keal-root': rootRel };
  const ctx = { window: {}, location: { href, search: '' }, URL, URLSearchParams, performance: { now: () => 0 }, AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error('no net'); },
    document: { querySelector: sel => { const m = /keal-([a-z]+)/.exec(sel); return m && metas['keal-' + m[1]] !== undefined ? { content: metas['keal-' + m[1]] } : null; } } };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  const r = ctx.window.KealRelay;
  return ['media/Album/a.mp3?m=x', '/media/a.mp3', 'apps/music/index.html'].map(p => r.pageUrl(p));
}
console.log(JSON.stringify({
  home: run('', '', 'http://192.168.1.5:8765/'),
  web: run('web', './', 'https://user.github.io/Keal-OS/'),
  webClient: run('web', '../', 'https://user.github.io/Keal-OS/client/'),
}));
"""


@unittest.skipUnless(shutil.which("node"), "node not installed")
class PageUrlTests(unittest.TestCase):
    def test_pageurl_modes(self):
        out = subprocess.run(["node", "-e", SCRIPT, str(ROOT / "web" / "relay.js")], capture_output=True, text=True, timeout=20)
        self.assertEqual(out.returncode, 0, out.stderr)
        got = json.loads(out.stdout)
        self.assertEqual(got["home"], ["/media/Album/a.mp3?m=x", "/media/a.mp3", "/apps/music/index.html"])
        base = "https://user.github.io/Keal-OS/"
        self.assertEqual(got["web"], [base + "media/Album/a.mp3?m=x", base + "media/a.mp3", base + "apps/music/index.html"])
        self.assertEqual(got["webClient"], got["web"])


if __name__ == "__main__":
    unittest.main()
