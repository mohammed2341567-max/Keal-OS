"""Browser integration for the app platform: store, install sync, sandbox, music playback."""
import json, math, shutil, struct, subprocess, sys, tempfile, time, urllib.request, wave
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT, TOKEN = 8793, "apptoken7"
TMP = Path(tempfile.mkdtemp())
results = []

def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + ((" -> " + str(detail)) if not ok else ""))

def api(path, body=None):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (PORT, path), data=None if body is None else json.dumps(body).encode(),
                                 headers={"X-Keal-Token": TOKEN, "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=3))

def wait(fn, secs=8):
    end = time.time() + secs
    while time.time() < end:
        try:
            v = fn()
            if v:
                return v
        except Exception:
            pass
        time.sleep(0.15)
    return None

# test catalog: the real Music app + a hostile "probe" app that tries to break out
apps = TMP / "apps"
shutil.copytree(ROOT / "apps" / "music", apps / "music")
(apps / "probe").mkdir(parents=True)
(apps / "probe/manifest.json").write_text(json.dumps({"id": "probe", "name": "Probe", "icon": "?", "targets": ["master", "client"], "permissions": []}))
(apps / "probe/index.html").write_text("""<!doctype html><body><pre id="out">running</pre><script src="/keal-sdk.js"></script><script>
(async () => {
  const r = {};
  try { r.parentDoc = String(window.parent.document.title); } catch (e) { r.parentDoc = 'blocked:' + e.name; }
  try { r.ls = String(localStorage.length); } catch (e) { r.ls = 'blocked:' + e.name; }
  try { const x = await fetch('/api/status'); r.fetchStatus = x.status; } catch (e) { r.fetchStatus = 'blocked:' + e.name; }
  for (const m of ['music.list', 'fs.read', 'bogus.method']) { try { await Keal.call(m, {path: 'README.txt'}); r[m] = 'ALLOWED'; } catch (e) { r[m] = e.message; } }
  try { await Keal.call('storage.set', {key: 'k', value: 'v1'}); r.storage = await Keal.call('storage.get', {key: 'k'}); } catch (e) { r.storage = 'err:' + e.message; }
  try { await Keal.call('storage.set', {key: '../escape', value: 'x'.repeat(10)}); r.badKey = 'ALLOWED'; } catch (e) { r.badKey = 'ok'; }
  document.getElementById('out').textContent = JSON.stringify(r);
})();
</script></body>""")
music = TMP / "music" / "Album"
music.mkdir(parents=True)
with wave.open(str(music / "tone.wav"), "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
    w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(8000 * 4)))

srv = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", str(PORT), "--token", TOKEN, "--files-dir", str(TMP / "f"),
                        "--data-dir", str(TMP / "d"), "--apps-dir", str(apps), "--music-dir", str(TMP / "music")], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
try:
    wait(lambda: api("/api/status"), 5)
    with sync_playwright() as p:
        b = p.chromium.launch()
        m = b.new_context(viewport={"width": 1280, "height": 800}).new_page()
        c = b.new_context(viewport={"width": 1100, "height": 700}).new_page()
        errors = []
        for pg in (m, c):
            pg.on("pageerror", lambda e: errors.append(str(e)))
        m.goto("http://127.0.0.1:%d/" % PORT)
        c.goto("http://127.0.0.1:%d/client?t=%s" % (PORT, TOKEN))
        wait(lambda: api("/api/status")["controller_online"] and api("/api/status")["client_online"])
        m.evaluate("document.querySelector('.desktop-icon[data-app=store]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
        m.wait_for_selector(".store-card")
        check("store lists both catalog apps", m.locator(".store-card").count() == 2, m.locator(".store-card").count())
        check("uninstalled apps have no desktop icon", m.locator(".ext-icon").count() == 0)

        m.click(".store-card:has-text('Music') [data-install]")
        check("installing Music adds a desktop icon on the Redmi", wait(lambda: m.locator(".ext-icon[data-app=x-music]").count() == 1))
        m.click("[data-tab=client]")
        card = m.locator(".store-card:has-text('Music')")
        check("Music is refused for Samsung (headphones: Redmi only)", card.locator("button:disabled").count() == 1 and "NOT FOR THIS DEVICE" in card.inner_text(), card.inner_text())
        check("Samsung has no Music icon", c.locator(".ext-icon").count() == 0)

        # --- install Probe for Samsung from the Redmi: Samsung desktop updates live
        m.click(".store-card:has-text('Probe') [data-install]")
        check("Samsung desktop gets the new icon live (no reload)", wait(lambda: c.locator(".ext-icon[data-ext=x-probe]").count() == 1))
        m.click("[data-tab=master]")
        m.click(".store-card:has-text('Probe') [data-install]")
        wait(lambda: m.locator(".ext-icon[data-app=x-probe]").count() == 1)

        # --- sandbox: hostile app on the Samsung and on the Redmi
        c.dblclick(".ext-icon[data-ext=x-probe]")
        c.wait_for_selector(".workspace-app-window[data-app=x-probe] iframe")
        fr = c.frame_locator(".workspace-app-window[data-app=x-probe] iframe")
        wait(lambda: fr.locator("#out").inner_text().startswith("{"))
        res = json.loads(fr.locator("#out").inner_text())
        check("app cannot read the host page", res["parentDoc"].startswith("blocked"), res)
        check("app has no localStorage", res["ls"].startswith("blocked"), res)
        check("app cannot call the API with the token (no credentials)", res["fetchStatus"] != 200, res)
        check("app without 'music' permission is refused", res["music.list"].startswith("permission_denied"), res)
        check("app without 'files' permission is refused", res["fs.read"].startswith("permission_denied"), res)
        check("unknown bridge method is refused", res["bogus.method"] == "unknown_method", res)
        check("app-private storage works", res["storage"] == "v1", res)
        keys = c.evaluate("Object.keys(localStorage).filter(k => k.startsWith('keal.app.'))")
        check("app storage keys stay inside the app's own namespace", keys and all(k.startswith("keal.app.client.probe.") for k in keys), keys)

        # --- music playback on the Redmi
        m.evaluate("document.querySelector('.ext-icon[data-app=x-music]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
        m.wait_for_selector(".app-window[data-app=x-music] iframe")
        mf = m.frame_locator(".app-window[data-app=x-music] iframe")
        check("Music app lists tracks from the music folder", wait(lambda: mf.locator(".track").count() == 1), mf.locator("#list").inner_text() if mf.locator("#list").count() else "")
        mf.locator(".track").first.click()
        check("track plays (audio served with range support)", wait(lambda: mf.locator("#audio").evaluate("a => !a.paused && a.currentTime > 0.3")), mf.locator("#err").inner_text())
        check("duration read from the stream", wait(lambda: abs(mf.locator("#audio").evaluate("a => a.duration") - 4) < 0.3))
        mf.locator("#seek").evaluate("el => { el.value = 750; el.dispatchEvent(new Event('change')); }")
        check("seeking works (range request)", wait(lambda: mf.locator("#audio").evaluate("a => a.currentTime > 2.5")))
        mf.locator("#play").click()
        check("pause works", wait(lambda: mf.locator("#audio").evaluate("a => a.paused")))
        m.click(".app-window[data-app=x-music] [data-minimize]")
        mf.locator("#audio").evaluate("a => a.play()")
        time.sleep(0.8)
        check("music keeps playing while its window is minimised", mf.locator("#audio").evaluate("a => !a.paused"))

        # --- uninstall removes icon and window; data untouched
        m.click(".app-window[data-app=store] [data-tab=master]") if m.locator(".app-window[data-app=store] [data-tab=master]").count() else None
        m.click(".store-card:has-text('Music') [data-remove]"); m.click(".store-card:has-text('Music') [data-remove]")
        check("removing Music deletes icon and closes its window", wait(lambda: m.locator(".ext-icon[data-app=x-music]").count() == 0 and m.locator(".app-window[data-app=x-music]").count() == 0))
        check("music files untouched after uninstall", (music / "tone.wav").is_file())
        check("no uncaught page errors", not errors, errors)
        b.close()
finally:
    srv.terminate()

failed = [n for n, ok in results if not ok]
print("\n%d/%d app-platform checks passed" % (len(results) - len(failed), len(results)))
sys.exit(1 if failed else 0)
