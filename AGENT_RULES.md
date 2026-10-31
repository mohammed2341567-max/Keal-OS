# Agent rules (KEAL OS 6.2)

* Work only on branch `dev/6.2`. Never push to or merge into `main`; no deploy without owner approval.
* Never use `git reset --hard`, `git clean -fd`, force-push, or anything that discards user work.
* Preserve existing features, files and user data. Extend rather than replace; justify any architectural change in `PROGRESS.md` first.
* No new frameworks or dependencies without a documented reason.
* Public edition = ordinary browser app. No attempt to bypass Android permissions, school device management, browser security or OS boundaries. No arbitrary OS command execution.
* No secrets in frontend code (service-role keys, OAuth secrets, tokens).
* A feature is "complete" only when implemented **and** tested. Report states exactly: *implemented and tested / implemented but not fully tested / partially implemented / not implemented / blocked*. Never fabricate test results or real-device testing.
* Work in small verifiable stages; update `PROGRESS.md` after each stage.
* First response of a mission is an audit only (understanding, architecture, feature inventory, baseline tests, debt/risks, prioritised plan, expected files, blockers). **Wait for owner approval before starting Stage 2 or any major feature.**
* Session handling: at the end of every session write the exact progress and the next action in `PROGRESS.md`. Never claim to keep working after the session ends. After an interruption, resume from the repository documents and the real Git state, not from memory.
