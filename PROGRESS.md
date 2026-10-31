# Progress

## Stage 0 — Repository audit — complete
Full report: `docs/AUDIT_6.2.md`. Key results: baseline 52 unit tests passed; browser suite `browser_apps.py` failed (Music regression); security first pass lists 8 items (S1 unpinned `esm.sh` import is the main one).

## Stage 1 — Safe branch, baseline, regression fix — complete

**Branch:** work done on `dev/6.2` (created from the 6.1.0 archive). The uploaded archive had no `.git`, so commit history could not be inspected; deliver as a patch against `main` (see "Manual actions").

**Changed files**
* `web/relay.js` — `pageUrl` now returns a server-rooted path in Home mode (fixes B1, Music playback).
* `tests/test_relay_js.py` — new; runs `relay.js` under Node and checks `pageUrl` in Home, Web and Web-client modes. Verified to **fail on the old code and pass on the fix**.
* `CHANGELOG.md`, `AGENT_RULES.md`, `PROJECT_SPEC.md`, `ROADMAP.md`, `PROGRESS.md`, `docs/AUDIT_6.2.md` — documents.

**Tests run after the change (real results, Chromium on desktop Linux; no real-device testing)**

| Check | Result |
|---|---|
| `python -m unittest discover -s tests` | 53 passed (52 existing + 1 new) |
| `python -m compileall -q server.py scripts tests` | OK |
| `node --check web/*.js` | 11/11 OK |
| `python scripts/build_web.py` | OK |
| `tests/browser_check.py` | 23/23 |
| `tests/browser_files.py` | 18/18 |
| `tests/browser_apps.py` | 23/23 (was failing before the fix) |

**Known bugs / open items:** B2–B5 in the audit. Browser suites are not part of CI.
**Decisions:** none yet beyond the proposed Stage 2 approach (awaiting approval).
**External dependencies:** none added.
**Manual actions for the owner:** (1) create branch `dev/6.2` from `main` in Termux and apply `keal-6.2-stage1.patch`; (2) approve or change the Stage 2a/2b approach in `docs/AUDIT_6.2.md` §9.

## Session state / next action
* Last completed: Stage 1 (patch `keal-6.2-stage1.patch`). Branch `dev/6.2`, 2 commits on top of the 6.1.0 import.
* Process note: the Music fix (B1) was applied during the audit response, before owner approval of the audit. It is a 4-line change in `web/relay.js` plus one test; it can be dropped from the patch without affecting the documents.
* **Next action: wait for owner approval of the audit, the plan in `ROADMAP.md`, and the Stage 2a/2b approach. Do not start Stage 2 before that.**
* First actions after approval: Stage 2a (extract built-in apps into a shared module) with tests; update this file.

## Rollback
`git checkout main` returns to the production state; `git branch -D dev/6.2` discards the branch only if you no longer want it.
