# Roadmap 6.2

| Stage | Scope | Status |
|---|---|---|
| 0 | Repository audit (`docs/AUDIT_6.2.md`) | **Done** |
| 1 | Dev branch + baseline tests + Music regression fix | **Done** (see `PROGRESS.md`) |
| 2 | Public edition independence (2a extract built-in apps, 2b public shell; Sidecar optional) | Awaiting owner approval of the 2a/2b approach |
| 3 | Desktop: icon drag-and-drop (Pointer Events), window resize/focus polish | Not started |
| 4 | Settings modernisation (8 sections, every control real) | Not started |
| 5 | Independent device storage (IndexedDB, migrations, export/import) | Not started |
| 6 | App Store architecture (categories, compatibility, permissions) | Not started |
| 7 | Code Lab projects + sandboxed preview; virtual console limits | Not started |
| 8 | KEAL Notch + notification API | Not started |
| 9 | Original games (block puzzle, flappy-style) | Not started |
| 10 | Update Center, single version source, Termux workflow doc | Not started |
| 11 | Security and performance review | Not started |
| 12 | Full regression and release candidate | Not started |

Expected files per stage: 2 → `web/workspace.js`, `web/master.js`, `web/index.html`, `web/workspace.html`, `scripts/build_web.py`, new `web/builtin-apps.js`, tests; 3 → `web/master.js`, `web/style.css`; 4 → `web/shared.js` (settings), `web/cloud.js`; 5 → `web/cloud.js`, new `web/storage.js`; 6 → `web/shared.js`, `apps/*/manifest.json`, `server.py`; 7 → `web/workspace.js`, `web/runtime.js`; 8 → new `web/notch.js`, `web/style.css`; 9 → new `apps/*`; 10 → `web/version-check.js`, `scripts/build_web.py`, `README.md`; 11–12 → tests and docs.
