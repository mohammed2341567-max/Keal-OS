"""Two-browser-context integration check (needs: pip install playwright && playwright install chromium).
Simulates Redmi (master + controller iframe) and Samsung (/client) against a real server process.
Not a substitute for the two-device manual checklist in README."""
import subprocess, sys, time, json, urllib.request, tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PORT, TOKEN = 8791, "testtoken123"
results = []

def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (("  -> " + str(detail)) if detail or not ok else ""))

def status():
    req = urllib.request.Request("http://127.0.0.1:%d/api/status" % PORT, headers={"X-Keal-Token": TOKEN})
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

TMP = tempfile.mkdtemp()
srv = subprocess.Popen([sys.executable, str(ROOT / "server.py"), "--host", "127.0.0.1", "--port", str(PORT), "--token", TOKEN, "--files-dir", TMP + "/f", "--data-dir", TMP + "/d"],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
try:
    wait(lambda: status(), 5)
    with sync_playwright() as p:
        browser = p.chromium.launch()
        master = browser.new_context(viewport={"width": 1280, "height": 800}).new_page()
        client = browser.new_context(viewport={"width": 1100, "height": 700}).new_page()
        errors = []
        for pg in (master, client):
            pg.on("pageerror", lambda e: errors.append(str(e)))
        master.goto("http://127.0.0.1:%d/" % PORT)
        client.goto("http://127.0.0.1:%d/client?t=%s" % (PORT, TOKEN))

        ok = wait(lambda: status()["controller_online"] and status()["client_online"])
        check("controller iframe auto-opens and both heartbeats arrive independently", ok, status())
        check("default target is local", status()["input_target"] == "local")
        check("remote cursor hidden while local", not client.is_visible("#remoteCursor"))

        master.click("#mFocusSamsung")
        check("focus switches to samsung with revision bump", wait(lambda: status()["input_target"] == "samsung") and status()["focus_revision"] >= 1, status()["focus_revision"])
        check("client shows remote cursor", wait(lambda: client.is_visible("#remoteCursor")))

        frame = master.frame_locator(".workspace-frame")
        box = master.locator(".workspace-frame").bounding_box()
        vs = frame.locator("#virtualScreen").bounding_box()
        def master_xy(lx, ly):
            return (vs["x"] + lx * vs["width"] / 1280, vs["y"] + ly * vs["height"] / 720)  # Playwright boxes are already page-relative

        mx, my = master_xy(640, 360)
        master.mouse.move(mx - 30, my - 20)
        master.mouse.move(mx, my, steps=6)
        pos = wait(lambda: (lambda c: c if abs(c[0] - 640) < 6 and abs(c[1] - 360) < 6 else None)(
            client.evaluate("(() => { const c = document.getElementById('remoteCursor'); return [parseFloat(c.style.left), parseFloat(c.style.top)]; })()")))
        check("pointer maps to 1280x720 logical coords (centre)", pos, pos)

        # double-click Terminal icon on the Samsung screen, via master pointer
        cvs = client.locator("#virtualScreen").bounding_box()
        ib = client.locator(".workspace-icon-grid [data-open=terminal]").bounding_box()
        lx = (ib["x"] + ib["width"] / 2 - cvs["x"]) * 1280 / cvs["width"]
        ly = (ib["y"] + ib["height"] / 2 - cvs["y"]) * 720 / cvs["height"]
        tx, ty = master_xy(lx, ly)
        master.mouse.move(tx, ty, steps=4)
        master.mouse.dblclick(tx, ty)
        check("double-click on remote icon opens Terminal on Samsung", wait(lambda: client.locator(".workspace-app-window[data-app=terminal]").count() == 1))

        master.keyboard.type("echo hi")
        typed = wait(lambda: client.input_value("#terminalInput") == "echo hi")
        check("keyboard text arrives exactly once (no duplicates/drops)", typed, client.input_value("#terminalInput"))
        master.keyboard.press("Enter")
        check("Enter runs the sandboxed command", wait(lambda: "hi" in client.inner_text("#terminalOutput").split("echo hi")[-1]))

        # drag a window by its titlebar through the relay
        tb = client.locator(".workspace-app-window[data-app=terminal] .workspace-app-titlebar").bounding_box()
        before = client.locator(".workspace-app-window[data-app=terminal]").bounding_box()
        sx = (tb["x"] + 80 - cvs["x"]) * 1280 / cvs["width"]; sy = (tb["y"] + tb["height"] / 2 - cvs["y"]) * 720 / cvs["height"]
        a = master_xy(sx, sy); b = master_xy(sx + 100, sy + 60)
        master.mouse.move(*a); master.mouse.down(); master.mouse.move(*b, steps=8); master.mouse.up()
        moved = wait(lambda: abs(client.locator(".workspace-app-window[data-app=terminal]").bounding_box()["x"] - before["x"]) > 20)
        check("dragging a window moves it on Samsung", moved)

        def settle():  # wait until the dragged window stops moving (relay events are still draining)
            last, stable = None, 0
            end = time.time() + 6
            while time.time() < end and stable < 4:
                cur = client.locator(".workspace-app-window[data-app=terminal]").bounding_box()
                stable = stable + 1 if cur == last else 0
                last = cur
                time.sleep(0.15)
        settle()

        # close button needs a relayed click (regression: Chrome click has isPrimary=false)
        cb = client.locator(".workspace-app-window[data-app=terminal] [data-close]").bounding_box()
        cx = (cb["x"] + cb["width"] / 2 - cvs["x"]) * 1280 / cvs["width"]; cy = (cb["y"] + cb["height"] / 2 - cvs["y"]) * 720 / cvs["height"]
        qx, qy = master_xy(cx, cy)
        master.mouse.move(qx, qy, steps=4); master.mouse.click(qx, qy)
        check("clicking the window close button closes it on Samsung", wait(lambda: client.locator(".workspace-app-window[data-app=terminal]").count() == 0))

        # minimise controller window: heartbeat must survive
        master.click("[data-minimize]")
        time.sleep(3)
        check("controller stays online while its window is minimised", status()["controller_online"] and status()["input_target"] == "samsung", status()["focus_reason"])
        master.click(".dock-app[data-app=workspace]")

        # window manager: dock indicators, maximize/restore, clamping
        dock = '.dock-app[data-app=workspace]'
        check("dock marks open window as running+focused", wait(lambda: "is-focused" in (master.get_attribute(dock, "class") or "")), master.get_attribute(dock, "class"))
        master.click(dock)
        check("dock click minimises the focused window (taskbar behaviour)", wait(lambda: "is-minimized" in (master.get_attribute(dock, "class") or "")))
        master.click(dock)
        check("dock click restores it", wait(lambda: master.locator(".workspace-window.minimized").count() == 0))
        master.dblclick(".workspace-window .window-titlebar .window-title")
        lay = master.evaluate("(() => { const l = document.getElementById('windowLayer'), w = document.querySelector('.workspace-window'); return [w.offsetWidth, w.offsetHeight, l.clientWidth, l.clientHeight]; })()")
        check("title-bar double-click maximises inside the workspace layer", lay[0] >= lay[2] - 12 and lay[1] >= lay[3] - 12 and lay[1] <= lay[3], lay)
        master.set_viewport_size({"width": 800, "height": 1100})
        time.sleep(0.5)
        lay = master.evaluate("(() => { const l = document.getElementById('windowLayer'), w = document.querySelector('.workspace-window'); return [w.offsetWidth, w.offsetHeight, l.clientWidth, l.clientHeight]; })()")
        check("maximised window refits after rotation", lay[0] >= lay[2] - 12 and lay[1] <= lay[3], lay)
        master.dblclick(".workspace-window .window-titlebar .window-title")
        master.set_viewport_size({"width": 1280, "height": 800})
        time.sleep(0.5)
        inside = master.evaluate("(() => { const l = document.getElementById('windowLayer').getBoundingClientRect(), r = document.querySelector('.workspace-window').getBoundingClientRect(); return r.left >= l.left - 1 && r.right <= l.right + 1 && r.bottom <= l.bottom + 1; })()")
        check("restored window stays inside the workspace after resize", inside)
        check("controller still online after window-manager actions", status()["controller_online"])
        master.click("#mFocusSamsung"); wait(lambda: status()["input_target"] == "samsung")

        # back to local: no more delivery, cursor hidden
        master.click("#mFocusLocal")
        check("switching to REDMI hides remote cursor", wait(lambda: not client.is_visible("#remoteCursor")))
        sent_before = status()["accepted_events"]
        master.mouse.move(mx + 20, my + 10, steps=4)
        time.sleep(0.5)
        check("no events accepted after returning to local", status()["accepted_events"] == sent_before)

        # client reload while remote -> must come back local, never auto-resume
        master.click("#mFocusSamsung")
        wait(lambda: status()["input_target"] == "samsung")
        client.reload()
        wait(lambda: status()["client_online"])
        time.sleep(0.5)
        check("client reload returns input to local (no auto-resume)", status()["input_target"] == "local", status()["focus_reason"])

        # token enforcement from a page without token (non-loopback only; loopback gets injected token)
        check("no uncaught page errors", not errors, errors)
        browser.close()
finally:
    srv.terminate()

failed = [n for n, ok in results if not ok]
print("\n%d/%d browser checks passed" % (len(results) - len(failed), len(results)))
sys.exit(1 if failed else 0)
