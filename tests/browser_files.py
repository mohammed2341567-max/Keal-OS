"""Browser integration for real files / sync / wallpapers (Redmi master + Samsung client contexts)."""
import json, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT, TOKEN = 8792, "filetoken9"
TMP = tempfile.mkdtemp()
FILES = Path(TMP) / "f"
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

srv = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", str(PORT), "--token", TOKEN,
                        "--files-dir", str(FILES), "--data-dir", TMP + "/d"], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
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

        check("seed files exist in the authorized folder", (FILES / "notes/quick-notes.md").is_file() and (FILES / "code/main.py").is_file())

        # --- Quick Notes on Redmi saves to the real file, Samsung sees it
        m.click(".dock-app[data-app=notes]")
        m.wait_for_selector("#masterNotesText")
        wait(lambda: "SAVED" in m.inner_text(".kd-state"))
        m.fill("#masterNotesText", "idea from redmi 🚀")
        check("Redmi note is written to disk", wait(lambda: (FILES / "notes/quick-notes.md").read_text(encoding="utf-8") == "idea from redmi 🚀"))
        c.dblclick(".workspace-icon-grid [data-open=notes]")
        c.wait_for_selector("#workspaceNotesText")
        check("Samsung Notes shows the Redmi note", wait(lambda: c.input_value("#workspaceNotesText") == "idea from redmi 🚀"), c.input_value("#workspaceNotesText"))
        c.fill("#workspaceNotesText", "edited on samsung")
        check("edit on Samsung appears on Redmi without reload", wait(lambda: m.input_value("#masterNotesText") == "edited on samsung", 10), m.input_value("#masterNotesText"))
        check("Redmi shows 'updated from other device'", "OTHER DEVICE" in m.inner_text(".kd-state"), m.inner_text(".kd-state"))

        # --- conflict: stale write must never overwrite newer data silently
        m.fill("#masterNotesText", "redmi stale edit")
        api("/api/fs/write", {"path": "notes/quick-notes.md", "content": "newer from elsewhere", "force": True})
        check("conflict banner appears instead of overwriting", wait(lambda: m.is_visible(".kd-conflict")))
        check("newer content still on disk", (FILES / "notes/quick-notes.md").read_text() == "newer from elsewhere")
        m.click("[data-act=theirs]")
        check("LOAD THEIRS adopts the other version", wait(lambda: m.input_value("#masterNotesText") == "newer from elsewhere"))

        # --- real file explorer on Redmi opens a file
        m.click(".dock-app[data-app=notes]")  # minimise notes
        m.evaluate("document.querySelector('.desktop-icon[data-app=files]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
        m.wait_for_selector(".kf-item")
        check("explorer lists real folders", m.locator(".kf-item[data-name=code]").count() == 1)
        m.click(".kf-item[data-name=code]")
        m.wait_for_selector(".kf-item[data-name='main.py']")
        m.click(".kf-item[data-name='main.py']")
        check("clicking a file loads it in the editor", wait(lambda: "Hello, Keal" in m.input_value("#masterNotesText")), m.input_value("#masterNotesText"))

        # --- wallpapers
        m.evaluate("document.querySelector('.desktop-icon[data-app=settings]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))")
        m.wait_for_selector(".wp-swatch")
        m.click(".wp-swatch[data-wp=aurora]")
        check("Redmi wallpaper changes", wait(lambda: m.get_attribute("#masterDesktop", "data-wallpaper") == "aurora"))
        m.click("[data-tab=wallpaper_client]")
        m.click(".wp-swatch[data-wp=nebula]")
        check("Samsung wallpaper changes live", wait(lambda: c.get_attribute("#virtualScreen", "data-wallpaper") == "nebula"), c.get_attribute("#virtualScreen", "data-wallpaper"))
        saved = json.loads((Path(TMP) / "d/settings.json").read_text())
        check("wallpapers are persisted to settings.json", saved == {"wallpaper_master": "aurora", "wallpaper_client": "nebula"}, saved)
        check("6 wallpapers offered", m.locator(".wp-swatch").count() == 6)

        # --- end to end: type on Samsung through the relay into a real file
        m.evaluate("document.querySelectorAll('.app-window:not(.workspace-window) [data-close]').forEach(b => b.click())")  # nothing may cover the controller
        m.click("#mFocusSamsung")
        wait(lambda: api("/api/status")["input_target"] == "samsung")
        c.evaluate("document.activeElement && document.activeElement.blur()")       # prove focus comes from the relayed click
        vs = m.frame_locator(".workspace-frame").locator("#virtualScreen").bounding_box()
        cv = c.locator("#virtualScreen").bounding_box()
        def to_master(box):
            lx = (box["x"] + box["width"] / 2 - cv["x"]) * 1280 / cv["width"]
            ly = (box["y"] + box["height"] / 2 - cv["y"]) * 720 / cv["height"]
            return vs["x"] + lx * vs["width"] / 1280, vs["y"] + ly * vs["height"] / 720
        ta = c.locator("#workspaceNotesText").bounding_box()
        # click near the top-left of the textarea (empty area is fine)
        tx, ty = to_master({"x": ta["x"], "y": ta["y"], "width": 20, "height": 20})
        m.mouse.move(tx, ty, steps=4); m.mouse.click(tx, ty)
        check("remote click focuses the Samsung textarea", wait(lambda: c.evaluate("document.activeElement && document.activeElement.id") == "workspaceNotesText"), c.evaluate("document.activeElement && document.activeElement.id"))
        m.keyboard.press("Control+a")
        m.keyboard.type("typed remotely\nline two")
        check("remote typing lands in the real file on disk", wait(lambda: (FILES / "notes/quick-notes.md").read_text(encoding="utf-8") == "typed remotely\nline two", 10), (FILES / "notes/quick-notes.md").read_text())
        m.keyboard.press("ArrowUp")
        m.keyboard.type("X")
        check("ArrowUp moves the caret to the same column on the previous line", wait(lambda: (FILES / "notes/quick-notes.md").read_text(encoding="utf-8") == "typed reXmotely\nline two"), (FILES / "notes/quick-notes.md").read_text())

        check("no uncaught page errors", not errors, errors)
        b.close()
finally:
    srv.terminate()

failed = [n for n, ok in results if not ok]
print("\n%d/%d file/sync checks passed" % (len(results) - len(failed), len(results)))
sys.exit(1 if failed else 0)
