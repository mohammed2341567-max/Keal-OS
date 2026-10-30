# KEAL OS 6.1 — Home Edition + Web Edition

**KEAL OS** is a browser-based personal workspace with a JARVIS-inspired desktop, installable mini-apps, a sandboxed App Store, a virtual Samsung workspace, a master/client input relay, Notes, Code Lab, Files, Settings, System Monitor, and Music.

Version 6.1 keeps the existing Termux/Home Edition and adds a separate static Web Edition designed for GitHub Pages or Cloudflare Pages. Optional Google sign-in, stable KEAL IDs, unique nicknames, invited-member Friends Chat, and per-account cloud storage use Supabase. The hosted edition does not need a Python server running on the Redmi.

> **Important boundaries:** KEAL is a virtual environment inside Chrome. It does not move Android's real system pointer, intercept all Android keyboard input, bypass Samsung school management, or run arbitrary shell commands. The Terminal's Python and JavaScript modes execute inside browser Workers; its command prompt is a safe virtual shell. The school-managed Samsung should use its existing Chrome browser and only features permitted by its administrator.

---

## What's included

### Home Edition — personal/local

- Runs from Python in Termux on the Redmi. No pip dependencies are required.
- Serves the master desktop and the `/client` virtual workspace over a trusted local network.
- Includes the focus manager, controller/client heartbeats, input-event relay, pointer and keyboard forwarding inside the KEAL browser surfaces, diagnostics, safe reconnect behavior, and a pairing token.
- Keeps the V5.2 local text-file workspace in `~/keal_files`, the Music library in `~/keal_music`, and settings/app-install state under `~/.keal`.
- Includes App Store, install/remove state, sandboxed app iframes, Quick Notes, Code Lab, File Explorer, Settings/wallpapers, System Monitor, and Music.
- Home Edition remains local-first. Its existing Python endpoints continue to handle local files and local device relay.

### Web Edition — friends / hosted

- Static HTML, CSS, and JavaScript output. It can be deployed without a long-running Python host.
- Includes the same desktop shell and built-in applications, plus the existing installable app catalog (including Music's browser file picker fallback).
- Browser-local guest storage works without a cloud project. It is local to that browser profile and is not a globally verified account.
- Optional Supabase integration provides Google OAuth, invite-only membership, per-account KEAL IDs, unique editable nicknames, private files/settings/app-install records, private paired-device relay, and invited-members Friends Chat.
- Sign in on both devices with the **same invited Google account** to pair those two browser sessions in the hosted Web Edition. Each friend signs in with their own invited account and receives a different KEAL ID.
- Email is not displayed in KEAL profiles or Chat. Supabase Auth still stores the provider email for authentication; KEAL application tables store the stable Supabase user UUID, public KEAL ID, nickname, and app data.

### Application catalog

Apps live in `apps/<app-id>/` with `manifest.json` and an HTML entry point. The App Store reads the manifest catalog and stores install state per device. Apps run in sandboxed iframes and use `web/keal-sdk.js` for the limited host bridge. Existing permissions such as `music` and `files` are checked by the host. Do not add a permission that exposes unrestricted filesystem access or shell execution.

---

## A. Run Home Edition on the Redmi (Termux)

1. Extract the project folder on the Redmi.
2. Open Termux and run:

```sh
pkg install python
cd ~/keal_os_v6
python server.py
```

If you extracted it elsewhere, `cd` into that actual folder. The server prints the Redmi URL and the Samsung client URL including the pairing token. Open the first URL on Redmi and the complete `/client?t=...` URL on Samsung.

Useful options:

```sh
python server.py --port 8766
python server.py --files-dir ~/keal_files --music-dir ~/keal_music
```

The default folders are deliberately outside the project directory. Replacing the project folder therefore does not delete user files or settings. Keep the Home Edition relay on a trusted private network only; it uses plain HTTP and a LAN pairing token.

### Music library (Home Edition)

```sh
termux-setup-storage
mkdir -p ~/keal_music
cp ~/storage/music/*.mp3 ~/keal_music/
```

Supported formats are defined by the Music app. Music files are read-only to KEAL.

---

## B. Build the hosted Web Edition

Python 3 is used only to generate the static `public/` directory. The generated site has relative paths and supports a project subpath such as `https://USERNAME.github.io/REPOSITORY/`.

```sh
python scripts/build_web.py
```

The output is:

```text
public/
  index.html
  client/index.html
  config.js
  cloud.js
  identity.js
  relay.js
  shared.js
  master.js
  workspace.js
  runtime.js
  python-worker.js
  style.css
  apps-catalog.json
  version.json
  apps/
  keal-sdk.js
```

### GitHub Pages

1. Push the repository to GitHub on the `main` branch.
2. In **Settings → Pages**, choose **GitHub Actions** as the deployment source.
3. The included `.github/workflows/pages.yml` runs `scripts/build_web.py` and deploys `public/` on each push to `main`.
4. The Web Edition is served from the repository Pages URL.

### Cloudflare Pages

Create a Pages project connected to the repository and set:

- **Build command:** `python3 scripts/build_web.py`
- **Build output directory:** `public`
- **Root directory:** `/`

Use HTTPS. The Web Edition does not require a Python server after deployment.

### Release updates

The builder creates `version.json`. To publish a new release, update `VERSION` in `scripts/build_web.py` and `appVersion` in `web/config.js` to the same new semantic version, then build/deploy. The Web Edition checks `version.json` periodically and displays a manual update notice; it never reloads a page automatically. Notes and Code Lab save as you work, but the user should wait until a visible save state says `SAVED` before reloading.

---

## C. Browser coding runtimes

The Samsung virtual workspace Terminal has three tabs:

- **Safe Shell:** a small set of virtual commands (`help`, `clear`, `whoami`, `pwd`, `ls`, `date`, `system`, and `echo`). It is not a real Android or Linux shell.
- **Python:** on first use, KEAL loads the pinned **Pyodide 314.0.7** WebAssembly runtime from the official jsDelivr CDN inside a module-type Web Worker. Python execution happens off the UI thread. The standard library is available, and compatible Pyodide packages can be loaded from the runtime package index. The browser needs internet access for the first load and for package downloads; cached assets may make later launches faster.
- **JavaScript:** code runs in a dedicated Web Worker. It cannot directly manipulate the page DOM, but worker web APIs such as `fetch` remain available.

These are browser execution environments, not remote execution on Redmi or Samsung Android. They do not expose the device shell or Android file system. The Python virtual filesystem belongs to the runtime session and is not the same as KEAL Files; save project files through the KEAL Files/Code Lab features. Only run code you understand, especially code copied from untrusted sources.

---

## D. Google accounts, KEAL IDs, invites, and Chat (optional)

The static site can be used in guest mode without Supabase. For real accounts and friends chat, follow **[`supabase/SETUP.md`](supabase/SETUP.md)** exactly.

The design is:

- Google OAuth handled by Supabase Auth.
- The stable identity is the Supabase Auth user UUID (`auth.users.id`). The database generates a separate human-readable, unique `KEAL-...` public ID and a generated nickname.
- Nicknames are unique (case-insensitive), editable, and limited to 3–20 ASCII letters, digits, underscores, or hyphens.
- Registration is invite-only. The database stores a SHA-256 digest of each invited email, checks it during first account creation, and consumes the invitation atomically. The plaintext email is not stored in the KEAL invitation table. **Email hashes are pseudonymous, not anonymous**: someone with access to the hashes could guess common addresses, so protect the table and only manage it through the Supabase SQL/admin interface.
- RLS policies isolate private files, settings, and installed apps by `auth.uid()`.
- Friends Chat is available only to authenticated invited members. It displays nickname and KEAL ID, not email; messages are capped at 800 characters and have a server-side per-account rate limit.
- Every user can read the invited-members lobby and delete their own messages. This initial release does not include moderation tools, private DMs, blocking, or report workflows; only invite people you know and avoid posting personal information.

**A guest ID is only local to one browser profile.** A global account ID is created after successful Google sign-in and invite validation. This is intentional: generating IDs in JavaScript alone cannot establish a secure, globally unique identity across devices.

---

## E. Local data vs cloud data

| Data | Home Edition | Web Edition without Supabase | Web Edition with Supabase |
|---|---|---|---|
| Notes / Code Lab | `~/keal_files` | Browser localStorage | Per-user cloud files |
| File Explorer | Restricted text-only folder | Browser-local virtual files | Per-user cloud files |
| Wallpaper settings | `~/.keal/settings.json` | Browser localStorage | Per-user cloud settings |
| App install state | `~/.keal/apps.json` | Browser localStorage | Per-user cloud records |
| Music | `~/keal_music` on Redmi | Choose audio files in browser | Choose audio files in browser (no upload) |
| Account / Chat | Not required for local relay | Guest mode only | Supabase Auth + invited chat |
| Paired browser relay | Local Python server + token | Not enabled | Supabase private Realtime channel |

Browser-local data stays in the same browser profile and origin. Clearing site data or changing browsers may remove it. Supabase cloud files are private to the signed-in account through RLS. No file is shared with friends unless a future feature explicitly implements sharing.

---

## F. Tests and quality checks

Run from the project root:

```sh
python -m unittest discover -s tests -v
python scripts/build_web.py
```

The current unit suite contains **52 passing tests** (45 relay/files/apps/HTTP-security tests plus 7 static-build/runtime packaging tests) covering generated paths, version metadata, the app catalog, runtime assets, and both entry points. Browser JavaScript syntax and Python compilation checks are also run before deployment in GitHub Actions.

Optional browser suites (requires Playwright and a supported browser installation):

```sh
python tests/browser_check.py
python tests/browser_files.py
python tests/browser_apps.py
```

Automated unit tests do not replace a real two-tablet test. For hosted pairing, sign into the same account on Redmi and Samsung, open the controller on Redmi and `/client/` on Samsung, wait until both heartbeats are online, select Samsung focus, and test pointer/key events only within the virtual workspace.

---

## G. Project structure

```text
keal_os_v6/
  server.py                 # Home Edition Termux server
  web/                      # shared frontend source, cloud adapter, identity and runtime lab
  web/python-worker.js      # Pyodide WebAssembly worker
  web/runtime.js            # browser Python/JavaScript runner UI
  apps/                     # installable sandboxed mini-apps
  scripts/build_web.py      # static Web Edition builder
  public/                   # generated GitHub Pages / Cloudflare Pages output
  supabase/schema.sql       # database schema, RLS, Auth invite guard, chat
  supabase/SETUP.md         # Supabase + Google OAuth setup
  scripts/invite_hash.py    # generate invite hashes locally
  tests/                    # Home Edition and static build tests
  .github/workflows/        # GitHub Pages deployment workflow
```

## Important limitations

- No browser-only implementation can move Android's actual system cursor between tablets or globally reroute Android input. KEAL's pointer and input relay work only inside KEAL browser surfaces.
- The Samsung device remains under its school management. No MDM/Knox bypass, unauthorized installation, or system modification is part of this project.
- Terminal has three modes: a safe virtual command prompt, Python through the pinned Pyodide 314.0.7 WebAssembly runtime in a dedicated Worker, and JavaScript in a dedicated Worker. The first Python launch requires internet access to download the runtime; the browser may cache it for later sessions. Python runs are stopped after 45 seconds and JavaScript runs after 8 seconds to keep the interface responsive to keep the interface responsive.
- These runtimes are browser execution environments, not Termux or operating-system shells. They do not provide Android filesystem or shell access. Python packages must be compatible with Pyodide/WebAssembly; not every desktop Python package is available. Worker isolation keeps code off the UI thread but is not a full security sandbox for untrusted code: JavaScript still has worker web APIs such as `fetch`. Run only code you understand.
- The Web Edition's Google Auth, database, Chat, cloud files, and cloud relay are implemented as optional integrations but are **not live until a Supabase project, Google OAuth provider, invite hashes, and public project config are set up**.
