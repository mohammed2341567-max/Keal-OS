# KEAL OS 6.2 — Stage 0 Technical Audit

Audited tree: `Keal-OS-main.zip` (6.1.0, no `.git` directory in the archive, so commit history could not be inspected).
Method: every statement below was checked against the files or by running the code. "Unverified" marks things read but not executed.
No real-device testing was performed; all browser results are Chromium (Playwright) on a desktop Linux sandbox.

## 1. Baseline results (before any change)

| Check | Command | Result |
|---|---|---|
| Unit tests | `python -m unittest discover -s tests` | **52 passed** |
| Python syntax | `python -m compileall -q server.py scripts tests` | OK |
| Browser JS syntax | `node --check web/*.js` | 11/11 OK |
| Static build | `python scripts/build_web.py` | OK, 1 catalog app (`music`) |
| Browser: relay/windows | `tests/browser_check.py` | 23/23 passed |
| Browser: files/sync | `tests/browser_files.py` | 18/18 passed |
| Browser: app platform | `tests/browser_apps.py` | **FAILED** (3 checks: track playback, duration, seeking) |

CI (`.github/workflows/pages.yml`) runs only the unit tests, compile check and JS syntax check. It never runs the three browser suites, which is why the 6.1.0 Music regression below reached `main` unnoticed.

## 2. Architecture

Two editions share one front end in `web/`:

* **Home Edition** — `server.py` (stdlib only): static files, token-protected JSON API, `FileStore` (one authorized folder, text files only), `SettingsStore`, `AppRegistry`, `MediaLibrary`, and the focus-manager input relay between a "master" page and a "client" workspace. LAN-only by design (private-IP gate, plain HTTP).
* **Web Edition** — `scripts/build_web.py` renders the same two pages into `public/` with `<base href>` and relative URLs (`index.html` and `client/index.html`). `KealRelay.api` routes to `KealCloud.api` (`web/cloud.js`), a browser re-implementation of the server's `/api/*` contract: files and settings in `localStorage`, optional Supabase (Google sign-in, invite-only, per-user files/settings/app installs, Friends Chat, paired-device relay over Realtime).

Front-end modules: `master.js` (desktop, window manager, dock; 402 lines), `workspace.js` (fixed 1280×720 virtual desktop with Terminal, Code Lab, Files, Notes, Settings, Store; 739 lines), `shared.js` (synced editor, file explorer, wallpapers/settings, Store UI, sandboxed-app host bridge), `relay.js` (fetch wrapper + URL helper), `cloud.js`, `identity.js` (account and chat UI), `runtime.js` + `python-worker.js` (Pyodide 314.0.7 and JavaScript workers), `version-check.js`, `keal-sdk.js`.

Apps are manifest-driven (`apps/<id>/manifest.json`), run in `sandbox="allow-scripts"` iframes, and reach privileged functions only through a permission-checked `postMessage` bridge. Only one app exists: `music`.

Deployment: push to `main` → Actions → unit tests → build → GitHub Pages.

## 3. Feature status

| Area | Status |
|---|---|
| Desktop icons, windows (move/minimise/maximise/close, dock) | Implemented and tested (Home) |
| Window **resize** | Not implemented |
| Desktop icon drag-and-drop, persisted layout | **Not implemented** |
| Settings | Wallpaper only (2 keys). No theme/accent/animation/notification/storage/privacy/update panels |
| Files + Notes + Code Lab (Home, real folder) | Implemented and tested |
| Code Lab as a **project** environment (index.html/style.css/script.js, preview, diagnostics) | Not implemented — it is a single-file text editor |
| Terminal | Safe virtual shell + Python (Pyodide worker) + JavaScript worker. Python/JS runners **untested** (no test touches `runtime.js`/`python-worker.js`) |
| Store/app catalog | Implemented and tested (Home); Web catalog from `apps-catalog.json` (static-build test only) |
| Music | Home: **broken in 6.1.0** (fixed in Stage 1). Web: browser file picker (ADD FILES), untested |
| Notifications | Only a transient toast (`notify()` in `master.js`) and the update banner. No notch, no API |
| Update Center | Banner after a `version.json` mismatch; `confirm()` before reload. No release notes, no panel |
| Backup/restore (export/import) | **Not in the repository** |
| Independent device storage | Web files live in `localStorage` (≈5 MB, synchronous, no migrations); no IndexedDB |
| Accounts / chat | Implemented, **not configured** (`config.js` has empty Supabase values); untested |
| Games | None |
| Sidecar / hosted device relay | Implemented in `cloud.js` over Supabase Realtime; untested |

## 4. Bugs found

| ID | Severity | Finding | State |
|---|---|---|---|
| B1 | High | **Home Music broken (6.1.0).** `shared.js` builds `KealRelay.pageUrl('media/…')`, but in Home mode `pageUrl` returned the path unchanged, so inside the sandboxed app it resolved to `/apps/music/media/…` (404). Caught by `browser_apps.py`. | **Fixed in Stage 1**, regression test `tests/test_relay_js.py` fails on the old code and passes on the new |
| B2 | Medium | Version string `6.1.0` is hard-coded in 9 places (`server.py`, `build_web.py`, `config.js`, `cloud.js`, `version-check.js`, `relay.js`, 3 tests). Drift is likely. | Open (Stage 10) |
| B3 | Medium | Web `files_rev`/`apps_rev` are in-memory per page (`state.filesRev`); two tabs of the same browser do not see each other's edits. *Unverified by browser test.* | Open (Stage 5) |
| B4 | Low | Web local file "version" is a counter while the Supabase RPC uses `md5(content)`; the two stores have different conflict tokens. | Open (Stage 5) |
| B5 | Low | `crypto.subtle` (used for web file versions) exists only in secure contexts; plain `http://<LAN-IP>` pages would fail. HTTPS and `localhost` are fine. | Document |

## 5. Security review (first pass; full review is Stage 11)

| ID | Risk | Detail | Recommendation |
|---|---|---|---|
| S1 | **High if accounts are enabled** | `cloud.js` does `import('https://esm.sh/@supabase/supabase-js@2')`: unpinned major version from a third-party CDN, no integrity check, executing in the origin that holds the Supabase session. | Vendor a pinned copy in the repo (or pin an exact version) |
| S2 | Medium | The JavaScript runner is a same-origin Blob Worker; the Python runner is Pyodide in a module Worker. User code cannot touch the DOM or `localStorage`, but can call `fetch`, open IndexedDB and import scripts. Only code the user chooses to run is affected. | Best-effort global shadowing, execution limits, clear labelling; do not claim a hard sandbox |
| S3 | Medium | GitHub Pages cannot send a CSP `sandbox` header. Apps are isolated only by the iframe attribute. Opening `/apps/<id>/index.html` top-level would run on the site origin. Safe only while the catalog is curated by the owner. | No user-uploaded apps; document |
| S4 | Medium | Chat/RLS: `select … using (true)` for any `authenticated` user. Safe only because sign-up is invite-gated; **Supabase anonymous sign-ins must stay disabled** (the invite trigger lets anonymous users through). No admin moderation tooling. | Document in SETUP; add moderation later |
| S5 | Low | Chat body and nicknames are escaped (`esc(m.body)`); 28 `innerHTML` sites exist across `shared.js`, `identity.js`, `master.js`, `workspace.js`. Spot-checks found escaping; full review pending. | Stage 11 |
| S6 | Info | Home server: plain HTTP, token, private-IP gate, path containment, extension allow-list, no shell endpoint. Verified by tests. | Keep |
| S7 | Info | Pyodide URL is pinned (`v314.0.7`) but loaded from jsDelivr without integrity metadata. | Accept, document |
| S8 | Info | No secrets in the repository; `.gitignore` excludes `.env*`, `public/`, user folders. Supabase anon key is browser-safe by design. | Keep |

## 6. Technical debt

* `workspace.js` and `master.js` each carry their own app markup/mount logic; Terminal and Code Lab exist only in the Samsung-style workspace, not in the master desktop. This is the main coupling between Phase One (public edition) and everything after it.
* Samsung/Redmi wording is embedded in UI text, CSS, tests and docs (Samsung/Redmi mentions: `workspace.js` 31, `master.js` 24, `index.html` 10, `README.md` 12, `server.py` 12, `cloud.js` 9, tests ≈ 49).
* No test coverage for `cloud.js`, `identity.js`, `runtime.js`, `version-check.js`, the Web edition in a real browser, or the Supabase schema.
* Browser suites are not run in CI.

## 7. Compatibility limits

* Web Edition requires HTTPS or localhost (secure context).
* Python runtime needs internet on first use (Pyodide ≈10 MB) and module Workers (modern Chrome).
* The workspace is a fixed 1280×720 virtual screen scaled to fit; it is not truly responsive in portrait.
* A static site cannot update Android, Termux or push notifications by itself.

## 8. Module dependencies (important ones)

`relay.js` → (web) `cloud.js`; `shared.js` → `relay.js`, `keal-sdk.js` contract; `master.js`/`workspace.js` → `shared.js`, `relay.js`, `identity.js`, `runtime.js`; `runtime.js` → `python-worker.js`; `build_web.py` → `web/*`, `apps/*`, version constant; CI → tests + build.

## 9. Proposed sequence and one proposed deviation

Stages follow the assignment (0 → 12). **One deviation is proposed and needs owner approval before Stage 2:**

The public edition is currently the Home *master* desktop plus a hidden-behind-a-window Samsung workspace; Terminal, Code Lab, Files, Notes exist only inside `workspace.js`. Removing Samsung wording alone would leave a public desktop without those apps. Proposal: **Stage 2a** extracts the built-in apps (Files, Notes, Code Lab, Terminal, Settings, Store, Chat, Account) from `workspace.js` into a shared built-in-app module; **Stage 2b** makes the public build a single desktop shell using them, with Sidecar as an optional app. Home Edition keeps its master/workspace pair unchanged. Alternative (not recommended): promote `workspace.js` to the public shell as-is, which keeps its fixed 1280×720 limitation.

Files expected per stage are listed in `ROADMAP.md`.
