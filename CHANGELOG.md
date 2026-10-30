# KEAL OS — Changelog

## 6.1.0 — Initial unified Home + Web release

- Preserved the Termux/Home Edition and the existing application/window system, App Store, Files, Notes, Code Lab, Settings, Music, and local dual-workspace relay.
- Added a static Web Edition build for GitHub Pages and Cloudflare Pages with repository-subpath-safe routes.
- Added optional Supabase Google sign-in, invite-only first registration, stable per-account KEAL IDs, generated/editable unique nicknames, private per-user data, Friends Chat, and same-account hosted device relay.
- Added `version.json` release checks with a manual update notice; no automatic reload.
- Added Python execution through the pinned Pyodide 314.0.7 WebAssembly runtime in a dedicated module Worker.
- Added a JavaScript Worker runner and retained a safe virtual shell; none executes Android shell commands.
- Added automated checks for the Home Edition API, files, mini-apps, static output, runtime assets, Python syntax, and browser JavaScript syntax.

### Configuration still required for hosted accounts and Chat

A Supabase project, the SQL schema, Google OAuth settings, invitation hashes, and the public project URL/publishable key in `web/config.js` must be configured before real accounts, Friends Chat, cloud files, or hosted pairing become active. Never publish a service-role key or OAuth client secret.
