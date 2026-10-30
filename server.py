#!/usr/bin/env python3
"""KEAL OS Home Edition relay server (v6) - static files + focus manager + input-event relay.

Standard library only (Termux: `pkg install python`). It never executes shell
commands and never touches the Android system. Keep it on a trusted private
network: it speaks plain HTTP, and only private/loopback client addresses are
accepted. API calls need the pairing token printed at startup.
"""
import argparse
import hashlib
import ipaddress
import json
import os
import re
import secrets
import socket
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

VERSION = "6.1.0"
ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"

ROLES = ("controller", "client")
HEARTBEAT_TIMEOUT = 7.0      # seconds without heartbeat -> role is offline
MAX_EVENTS = 2000            # ring buffer size
MAX_BATCH = 100              # events per POST
MAX_BODY = 64 * 1024
MAX_POLL_EVENTS = 200
MAX_WAIT = 25.0              # long-poll ceiling (seconds)
SCREEN_W, SCREEN_H = 1280, 720

POINTER_TYPES = {"pointermove", "mousedown", "mouseup", "click", "dblclick"}
KEY_TYPES = {"keydown", "keyup"}
EVENT_TYPES = POINTER_TYPES | KEY_TYPES | {"wheel"}
MODIFIERS = ("ctrlKey", "shiftKey", "altKey", "metaKey")

MIME = {
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
}


def json_bytes(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def allowed_ip(addr):
    """Trusted-LAN gate: loopback, private and link-local addresses only."""
    try:
        ip = ipaddress.ip_address(str(addr).split("%")[0])
    except ValueError:
        return False
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped
    return ip.is_loopback or ip.is_private or ip.is_link_local


def is_loopback(addr):
    try:
        ip = ipaddress.ip_address(str(addr).split("%")[0])
    except ValueError:
        return False
    return (getattr(ip, "ipv4_mapped", None) or ip).is_loopback


def _num(value, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    if value != value or value in (float("inf"), float("-inf")):
        return None
    return max(lo, min(hi, value))


def validate_event(item):
    """Return (clean_event, None) or (None, reason). Unknown fields are dropped."""
    if not isinstance(item, dict):
        return None, "not_an_object"
    etype = item.get("type")
    if etype not in EVENT_TYPES:
        return None, "bad_type"
    n = item.get("n")
    if isinstance(n, bool) or not isinstance(n, int) or n < 1:
        return None, "bad_sequence"
    clean = {"type": etype, "n": n}
    if etype in POINTER_TYPES or etype == "wheel":
        x, y = _num(item.get("x"), 0, SCREEN_W), _num(item.get("y"), 0, SCREEN_H)
        if x is None or y is None:
            return None, "bad_coordinates"
        clean["x"], clean["y"] = round(x, 1), round(y, 1)
        if etype == "wheel":
            dy = _num(item.get("deltaY", 0), -2000, 2000)
            if dy is None:
                return None, "bad_delta"
            clean["deltaY"] = dy
        else:
            button = item.get("button", 0)
            if isinstance(button, bool) or not isinstance(button, int) or not 0 <= button <= 4:
                return None, "bad_button"
            clean["button"] = button
    else:
        key, code = item.get("key"), item.get("code", "")
        if not isinstance(key, str) or not 1 <= len(key) <= 32:
            return None, "bad_key"
        if not isinstance(code, str) or len(code) > 32:
            return None, "bad_code"
        repeat = item.get("repeat", False)
        if not isinstance(repeat, bool):
            return None, "bad_repeat"
        clean.update(key=key, code=code, repeat=repeat)
    for mod in MODIFIERS:
        value = item.get(mod, False)
        if not isinstance(value, bool):
            return None, "bad_modifier"
        clean[mod] = value
    return clean, None



# ---------------------------------------------------------------------------
# Authorized files folder + shared settings
# ---------------------------------------------------------------------------
TEXT_EXT = {".txt", ".md", ".py", ".js", ".html", ".css", ".json", ".csv", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".log"}
MAX_READ = 1024 * 1024
MAX_WRITE = 512 * 1024
MAX_LIST = 500
MAX_DEPTH = 8
NAME_RE = re.compile(r'^[^\x00-\x1f<>:"|?*\\/]{1,80}$')
WALLPAPERS = ("midnight", "aurora", "ember", "ocean", "nebula", "graphite")
SETTING_KEYS = {"wallpaper_master": WALLPAPERS, "wallpaper_client": WALLPAPERS}

SEED_FILES = {
    "notes/quick-notes.md": "# Quick Notes\n\nShared between Redmi and Samsung. Edit on either device.\n",
    "code/main.py": "# Keal Code Lab - this is a real file in your keal_files folder.\nprint(\"Hello, Keal!\")\n",
    "projects/hello-site/index.html": "<!doctype html>\n<title>Hello</title>\n<h1>My first Keal site</h1>\n",
    "README.txt": "This folder is the only part of the Redmi that KEAL OS can read or write.\nText files only (.txt .md .py .js .html .css .json ...).\n",
}


class FsError(Exception):
    def __init__(self, status, code, **extra):
        super().__init__(code)
        self.status, self.code, self.extra = status, code, extra


def file_version(data):
    return hashlib.sha1(data).hexdigest()[:12]


class FileStore:
    """Text files inside ONE authorized root. No symlinks, no hidden names, no escapes."""

    def __init__(self, root, seed=True):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        self.rev = 0
        if seed and not any(self.root.iterdir()):
            for rel, text in SEED_FILES.items():
                target = self.root / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")

    def label(self):
        home = Path.home()
        try:
            return "~/" + str(self.root.relative_to(home))
        except ValueError:
            return str(self.root)

    def _resolve(self, rel):
        if not isinstance(rel, str) or len(rel) > 240 or "\x00" in rel or "\\" in rel or rel.startswith("/"):
            raise FsError(400, "bad_path")
        parts = [p for p in rel.split("/") if p not in ("", ".")]
        if len(parts) > MAX_DEPTH or any(p == ".." or p.startswith(".") or not NAME_RE.match(p) for p in parts):
            raise FsError(400, "bad_path")
        cur = self.root
        for part in parts:
            cur = cur / part
            if cur.is_symlink():
                raise FsError(400, "symlink_not_allowed")
        resolved = cur.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise FsError(400, "bad_path")
        return cur, "/".join(parts)

    def _check_ext(self, path):
        if path.suffix.lower() not in TEXT_EXT:
            raise FsError(415, "unsupported_file_type")

    def list(self, rel=""):
        path, clean = self._resolve(rel)
        if not path.is_dir():
            raise FsError(404, "not_a_folder")
        entries = []
        for child in sorted(path.iterdir(), key=lambda c: (not c.is_dir(), c.name.lower())):
            if child.name.startswith(".") or child.is_symlink():
                continue
            if child.is_dir():
                entries.append({"name": child.name, "type": "dir"})
            elif child.suffix.lower() in TEXT_EXT:
                entries.append({"name": child.name, "type": "file", "size": child.stat().st_size})
            if len(entries) >= MAX_LIST:
                break
        return {"path": clean, "entries": entries, "root": self.label()}

    def read(self, rel):
        path, clean = self._resolve(rel)
        self._check_ext(path)
        if not path.is_file():
            raise FsError(404, "not_found")
        if path.stat().st_size > MAX_READ:
            raise FsError(413, "file_too_large")
        data = path.read_bytes()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            raise FsError(415, "not_utf8_text")
        return {"path": clean, "content": text, "version": file_version(data)}

    def write(self, rel, content, base=None, force=False):
        path, clean = self._resolve(rel)
        if not clean:
            raise FsError(400, "bad_path")
        self._check_ext(path)
        if not isinstance(content, str):
            raise FsError(400, "content_must_be_text")
        data = content.encode("utf-8")
        if len(data) > MAX_WRITE:
            raise FsError(413, "file_too_large")
        with self.lock:
            if path.is_dir():
                raise FsError(400, "is_a_folder")
            current = file_version(path.read_bytes()) if path.is_file() else None
            if not force and current != base:
                existing = None
                if current is not None and path.stat().st_size <= MAX_READ:
                    try:
                        existing = {"content": path.read_text(encoding="utf-8"), "version": current}
                    except UnicodeDecodeError:
                        existing = None
                raise FsError(409, "conflict", current=existing)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_name("." + path.name + ".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, path)
            self.rev += 1
        return {"path": clean, "version": file_version(data)}

    def mkdir(self, rel):
        path, clean = self._resolve(rel)
        if not clean:
            raise FsError(400, "bad_path")
        with self.lock:
            path.mkdir(parents=True, exist_ok=True)
            self.rev += 1
        return {"path": clean}

    def delete(self, rel):
        path, clean = self._resolve(rel)
        if not clean:
            raise FsError(400, "bad_path")
        with self.lock:
            if path.is_file():
                self._check_ext(path)
                path.unlink()
            elif path.is_dir():
                try:
                    path.rmdir()            # empty folders only
                except OSError:
                    raise FsError(409, "folder_not_empty")
            else:
                raise FsError(404, "not_found")
            self.rev += 1
        return {"path": clean}


class SettingsStore:
    def __init__(self, path):
        self.path = Path(path).expanduser()
        self.lock = threading.Lock()
        self.values = {key: options[0] for key, options in SETTING_KEYS.items()}
        try:
            saved = json.loads(self.path.read_text(encoding="utf-8"))
            for key, value in saved.items():
                if key in SETTING_KEYS and value in SETTING_KEYS[key]:
                    self.values[key] = value
        except (OSError, ValueError, AttributeError):
            pass

    def get(self):
        with self.lock:
            return dict(self.values)

    def update(self, key, value):
        if key not in SETTING_KEYS or value not in SETTING_KEYS[key]:
            raise FsError(400, "bad_setting")
        with self.lock:
            self.values[key] = value
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                tmp = self.path.with_suffix(".tmp")
                tmp.write_text(json.dumps(self.values), encoding="utf-8")
                os.replace(tmp, self.path)
            except OSError:
                pass                       # keep working in memory if the disk is read-only
            return dict(self.values)



# ---------------------------------------------------------------------------
# App registry (apps/<id>/manifest.json) and music library
# ---------------------------------------------------------------------------
APPS_DIR = ROOT / "apps"
APP_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
APP_PERMISSIONS = {"music", "files"}
APP_TARGETS = ("master", "client")
MEDIA_EXT = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac"}
MAX_TRACKS = 1000
APP_MIME = dict(MIME, **{".txt": "text/plain; charset=utf-8", ".webp": "image/webp", ".jpg": "image/jpeg", ".gif": "image/gif"})


def load_manifest(folder):
    """Validate apps/<id>/manifest.json. Returns (manifest, None) or (None, reason)."""
    mf = folder / "manifest.json"
    try:
        if mf.stat().st_size > 16 * 1024:
            return None, "manifest too large"
        raw = json.loads(mf.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None, "manifest unreadable"
    if not isinstance(raw, dict):
        return None, "manifest must be an object"
    app_id = raw.get("id")
    if not isinstance(app_id, str) or not APP_ID_RE.match(app_id) or app_id != folder.name:
        return None, "id must match the folder name (a-z, 0-9, -)"
    name, desc = raw.get("name"), raw.get("description", "")
    icon, version = raw.get("icon", "▣"), str(raw.get("version", "1.0"))[:16]
    if not isinstance(name, str) or not 1 <= len(name) <= 40:
        return None, "name required (max 40 chars)"
    if not isinstance(desc, str) or len(desc) > 200 or not isinstance(icon, str) or not 1 <= len(icon) <= 4:
        return None, "bad description or icon"
    targets, perms = raw.get("targets"), raw.get("permissions", [])
    if not isinstance(targets, list) or not targets or any(t not in APP_TARGETS for t in targets):
        return None, "targets must be a non-empty subset of master/client"
    if not isinstance(perms, list) or any(p not in APP_PERMISSIONS for p in perms):
        return None, "unknown permission"
    entry = raw.get("entry", "index.html")
    if not isinstance(entry, str) or "/" in entry or "\\" in entry or entry.startswith(".") or not entry.endswith(".html") or not (folder / entry).is_file():
        return None, "entry must be an existing .html file in the app folder"
    dims = []
    for key, default, lo, hi in (("width", 560, 280, 1200), ("height", 420, 200, 800)):
        value = raw.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
            return None, "bad " + key
        dims.append(value)
    return {"id": app_id, "name": name, "version": version, "description": desc, "icon": icon, "targets": sorted(set(targets)),
            "permissions": sorted(set(perms)), "entry": entry, "width": dims[0], "height": dims[1]}, None


class AppRegistry:
    def __init__(self, apps_dir, state_path):
        self.apps_dir, self.state_path = Path(apps_dir), Path(state_path).expanduser()
        self.lock = threading.Lock()
        self.rev = 0
        self.installed = {"master": [], "client": []}
        try:
            saved = json.loads(self.state_path.read_text(encoding="utf-8"))
            for device in self.installed:
                ids = saved.get(device, [])
                if isinstance(ids, list):
                    self.installed[device] = [i for i in ids if isinstance(i, str) and APP_ID_RE.match(i)][:50]
        except (OSError, ValueError, AttributeError):
            pass

    def catalog(self):
        apps, problems = {}, []
        if self.apps_dir.is_dir():
            for folder in sorted(self.apps_dir.iterdir()):
                if folder.is_dir() and not folder.is_symlink() and not folder.name.startswith("."):
                    manifest, why = load_manifest(folder)
                    if manifest:
                        apps[manifest["id"]] = manifest
                    else:
                        problems.append({"folder": folder.name, "problem": why})
        return apps, problems

    def snapshot(self):
        apps, problems = self.catalog()
        with self.lock:
            installed = {d: [i for i in ids if i in apps and d in apps[i]["targets"]] for d, ids in self.installed.items()}
        return {"catalog": list(apps.values()), "installed": installed, "problems": problems}

    def _save(self):
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.installed), encoding="utf-8")
            os.replace(tmp, self.state_path)
        except OSError:
            pass

    def change(self, device, app_id, install):
        if device not in self.installed or not isinstance(app_id, str):
            raise FsError(400, "bad_request")
        apps, _ = self.catalog()
        with self.lock:
            if install:
                if app_id not in apps:
                    raise FsError(404, "unknown_app")
                if device not in apps[app_id]["targets"]:
                    raise FsError(409, "app_not_available_for_device")
                if app_id not in self.installed[device]:
                    self.installed[device].append(app_id)
            elif app_id in self.installed[device]:
                self.installed[device].remove(app_id)
            self.rev += 1
            self._save()
        return self.snapshot()


class MediaLibrary:
    """Read-only music folder, separate from keal_files. Own token so the API token never appears in <audio> URLs."""

    def __init__(self, root):
        self.root = Path(root).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.token = secrets.token_urlsafe(9)

    def label(self):
        try:
            return "~/" + str(self.root.relative_to(Path.home()))
        except ValueError:
            return str(self.root)

    def list(self):
        tracks = []
        for dirpath, dirs, files in os.walk(self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not d.startswith(".") and not Path(dirpath, d).is_symlink())
            if len(Path(dirpath).relative_to(self.root).parts) > 3:
                dirs[:] = []
            for name in sorted(files, key=str.lower):
                path = Path(dirpath) / name
                if name.startswith(".") or path.is_symlink() or path.suffix.lower() not in MEDIA_EXT:
                    continue
                tracks.append({"path": path.relative_to(self.root).as_posix(), "name": path.stem, "size": path.stat().st_size})
                if len(tracks) >= MAX_TRACKS:
                    return tracks
        return tracks

    def resolve(self, rel):
        parts = [p for p in str(rel).split("/") if p not in ("", ".")]
        if not parts or len(parts) > 6 or any(p == ".." or p.startswith(".") or "\\" in p or "\x00" in p for p in parts):
            return None
        cur = self.root
        for part in parts:
            cur = cur / part
            if cur.is_symlink():
                return None
        try:
            real = cur.resolve()
        except OSError:
            return None
        if self.root not in real.parents or not real.is_file() or real.suffix.lower() not in MEDIA_EXT:
            return None
        return real


class Relay:
    """Single source of truth for the session. All state changes hold self.cond."""

    def __init__(self, clock=time.time, token=None, files=None, settings=None, apps=None, media=None):
        self.clock = clock
        self.apps = apps
        self.media = media
        self.files = files
        self.settings = settings
        self.token = token or secrets.token_urlsafe(9)
        self.boot_id = secrets.token_hex(4)
        self.cond = threading.Condition()
        self.started = clock()
        self.hb = {r: {"last": 0.0, "instance": None, "visible": None} for r in ROLES}
        self.last_poll = 0.0
        self.target = "local"          # safe default after every restart
        self.revision = 0
        self.focus_reason = "startup"
        self.events = deque(maxlen=MAX_EVENTS)
        self.seq = 0
        self.last_n = 0
        self.accepted_total = 0
        self.rejected_total = 0
        self.last_event = None
        self.last_pointer = None
        self.last_error = None

    # -- helpers (call with lock held) ------------------------------------
    def _age(self, last):
        return None if not last else max(0.0, self.clock() - last)

    def _online(self, role):
        age = self._age(self.hb[role]["last"])
        return age is not None and age < HEARTBEAT_TIMEOUT

    def _set_target(self, target, reason):
        if self.target != target:
            self.target = target
            self.revision += 1
            self.events.clear()      # never replay input across a focus boundary
            self.last_n = 0
            self.focus_reason = reason
            self.cond.notify_all()

    def _enforce(self):
        if self.target == "samsung":
            if not self._online("controller"):
                self._set_target("local", "controller_offline")
            elif not self._online("client"):
                self._set_target("local", "client_offline")

    def _error(self, reason):
        self.last_error = {"reason": reason, "age_at": self.clock()}

    # -- public operations -------------------------------------------------
    def heartbeat(self, role, instance, visible=None):
        if role not in ROLES:
            return 400, {"ok": False, "error": "role must be controller or client"}
        if not isinstance(instance, str) or not 1 <= len(instance) <= 40 or not instance.isprintable():
            return 400, {"ok": False, "error": "instance id required (1-40 chars)"}
        with self.cond:
            self._enforce()
            entry = self.hb[role]
            if entry["instance"] not in (None, instance) and self.target == "samsung":
                # A reloaded page is a new session: remote input never resumes by itself.
                self._set_target("local", role + "_reconnected")
            entry["last"], entry["instance"] = self.clock(), instance
            entry["visible"] = visible if isinstance(visible, bool) else None
            return 200, {"ok": True, **self._status()}

    def set_focus(self, target):
        if target not in ("local", "samsung"):
            return 400, {"ok": False, "error": "target must be local or samsung"}
        with self.cond:
            self._enforce()
            if target == "samsung":
                for role in ("controller", "client"):
                    if not self._online(role):
                        reason = role + "_offline"
                        self._error(reason)
                        return 409, {"ok": False, "error": reason, **self._status()}
            self._set_target(target, "manual")
            return 200, {"ok": True, **self._status()}

    def submit(self, batch, revision):
        with self.cond:
            self._enforce()

            def reject(reason):
                self.rejected_total += 1
                self._error(reason)
                return 409, {"ok": False, "accepted": 0, "reason": reason, **self._status()}

            if isinstance(revision, bool) or not isinstance(revision, int) or revision != self.revision:
                return reject("focus_revision_changed")
            if self.target != "samsung":
                return reject("local_focus")
            for role in ("controller", "client"):
                if not self._online(role):
                    return reject(role + "_offline")
            accepted = invalid = duplicate = 0
            first_problem = None
            now = self.clock()
            for item in batch:
                clean, problem = validate_event(item)
                if clean is None:
                    invalid += 1
                    first_problem = first_problem or problem
                    continue
                if clean["n"] <= self.last_n:     # retry or out-of-order: drop, keep order strict
                    duplicate += 1
                    continue
                self.last_n = clean["n"]
                self.seq += 1
                clean["seq"], clean["ts"] = self.seq, int(now * 1000)
                self.events.append(clean)
                accepted += 1
                self.last_event = {"type": clean["type"], "seq": self.seq, "at": now}
                if "x" in clean:
                    self.last_pointer = {"x": clean["x"], "y": clean["y"], "at": now}
            self.accepted_total += accepted
            if invalid:
                self._error("invalid_event:" + first_problem)
            if accepted:
                self.cond.notify_all()
            return 200, {"ok": True, "accepted": accepted, "invalid": invalid,
                         "duplicate": duplicate, **self._status()}

    def poll(self, since, revision, wait):
        deadline = self.clock() + max(0.0, min(wait, MAX_WAIT))
        with self.cond:
            self.last_poll = self.clock()
            while True:
                self._enforce()
                stale = revision is not None and revision != self.revision
                if self.target != "samsung" or stale:
                    return {"events": [], "reset": True, **self._status()}
                events = [e for e in self.events if e["seq"] > since][:MAX_POLL_EVENTS]
                remaining = deadline - self.clock()
                if events or remaining <= 0:
                    return {"events": events, "reset": False, **self._status()}
                self.cond.wait(min(remaining, 1.0))
                self.last_poll = self.clock()

    def status(self):
        with self.cond:
            self._enforce()
            return self._status()

    def _status(self):
        now = self.clock()
        c, k = self.hb["controller"], self.hb["client"]
        err = self.last_error
        return {
            "version": VERSION, "boot_id": self.boot_id, "server_time": int(now),
            "uptime_s": int(now - self.started),
            "controller_online": self._online("controller"), "client_online": self._online("client"),
            "controller_age": self._age(c["last"]), "client_age": self._age(k["last"]),
            "client_poll_age": self._age(self.last_poll),
            "controller_visible": c["visible"], "client_visible": k["visible"],
            "input_target": self.target, "focus_revision": self.revision,
            "focus_reason": self.focus_reason, "latest_seq": self.seq,
            "accepted_events": self.accepted_total, "rejected_batches": self.rejected_total,
            "last_event": self.last_event and {**self.last_event, "age": self._age(self.last_event["at"])},
            "last_pointer": self.last_pointer and {**self.last_pointer, "age": self._age(self.last_pointer["at"])},
            "last_error": err and {"reason": err["reason"], "age": self._age(err["age_at"])},
            "heartbeat_timeout": HEARTBEAT_TIMEOUT,
            "files_rev": self.files.rev if self.files else 0,
            "files_root": self.files.label() if self.files else None,
            "settings": self.settings.get() if self.settings else {},
            "apps_rev": self.apps.rev if self.apps else 0,
        }


class Handler(BaseHTTPRequestHandler):
    server_version = "KealRelay/" + VERSION
    protocol_version = "HTTP/1.1"

    @property
    def relay(self):
        return self.server.relay

    def log_message(self, fmt, *args):
        pass

    def log_request(self, code="-", size="-"):
        # Method + path + status only: never query strings (token) or bodies (keystrokes).
        path = urlparse(self.path).path
        if path.startswith("/api/") and int(code) < 400:
            return
        print("[%s] %s %s %s" % (time.strftime("%H:%M:%S"), self.command, path, code), flush=True)

    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status, obj):
        self._send(status, json_bytes(obj))

    def _token_ok(self, query):
        supplied = self.headers.get("X-Keal-Token") or (query.get("t") or [""])[0]
        return bool(supplied) and secrets.compare_digest(str(supplied), self.relay.token)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            raise ValueError("bad Content-Length")
        if length < 0 or length > MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length) if length else b""
        data = json.loads(raw.decode("utf-8")) if raw else {}
        if not isinstance(data, dict):
            raise ValueError("JSON body must be an object")
        return data

    def _guard(self, handler):
        if not allowed_ip(self.client_address[0]):
            return self._json(403, {"error": "private network clients only"})
        try:
            handler()
        except Exception as exc:  # never crash the server on a bad request
            print("[server] handler error: %s" % type(exc).__name__, flush=True)
            self._json(500, {"error": "internal error"})

    def do_GET(self):
        self._guard(self._get)

    def do_POST(self):
        self._guard(self._post)

    def _get(self):
        parsed = urlparse(self.path)
        route, query = parsed.path, parse_qs(parsed.query)
        if route.startswith("/api/"):
            if not self._token_ok(query):
                return self._json(401, {"error": "missing or wrong token"})
            if route in ("/api/status", "/api/debug"):
                return self._json(200, {"ok": True, **self.relay.status()})
            if route == "/api/events":
                try:
                    since = max(0, int(query.get("since", ["0"])[0]))
                    rev = query.get("rev", [None])[0]
                    rev = None if rev is None else int(rev)
                    wait = float(query.get("wait", ["0"])[0])
                except ValueError:
                    return self._json(400, {"error": "bad query"})
                return self._json(200, {"ok": True, **self.relay.poll(since, rev, wait)})
            if route == "/api/fs/list":
                return self._fs(lambda: self.relay.files.list((query.get("path") or [""])[0]))
            if route == "/api/fs/read":
                return self._fs(lambda: self.relay.files.read((query.get("path") or [""])[0]))
            if route == "/api/settings":
                return self._json(200, {"ok": True, "settings": self.relay.settings.get()})
            if route == "/api/apps":
                return self._json(200, {"ok": True, **self.relay.apps.snapshot()})
            if route == "/api/media/list":
                media = self.relay.media
                return self._json(200, {"ok": True, "root": media.label(), "tracks": media.list(), "media_token": media.token})
            return self._json(404, {"error": "not found"})
        if route.startswith("/media/"):
            return self._media(route[len("/media/"):], query)
        return self._static(route, query)

    def _media(self, rel, query):
        from urllib.parse import unquote
        media = self.relay.media
        supplied = (query.get("m") or [""])[0]
        if not media or not supplied or not secrets.compare_digest(supplied, media.token):
            return self._json(401, {"error": "missing or wrong media token"})
        path = media.resolve(unquote(rel))
        if path is None:
            return self._json(404, {"error": "not found"})
        size = path.stat().st_size
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"^bytes=(\d*)-(\d*)$", rng.strip())
            if not m or (m.group(1) == "" and m.group(2) == ""):
                self.send_response(416); self.send_header("Content-Range", "bytes */%d" % size); self.send_header("Content-Length", "0"); self.end_headers(); return
            if m.group(1) == "":
                start = max(0, size - int(m.group(2)))
            else:
                start = int(m.group(1))
                end = min(size - 1, int(m.group(2))) if m.group(2) else size - 1
            if start > end or start >= size:
                self.send_response(416); self.send_header("Content-Range", "bytes */%d" % size); self.send_header("Content-Length", "0"); self.end_headers(); return
            status = 206
        try:
            self.send_response(status)
            self.send_header("Content-Type", MEDIA_EXT[path.suffix.lower()])
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "private, max-age=3600")
            self.send_header("X-Content-Type-Options", "nosniff")
            if status == 206:
                self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
            self.send_header("Content-Length", str(end - start + 1))
            self.end_headers()
            with open(path, "rb") as fh:
                fh.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = fh.read(min(65536, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

    def _fs(self, fn):
        try:
            return self._json(200, {"ok": True, **fn()})
        except FsError as err:
            return self._json(err.status, {"ok": False, "error": err.code, **err.extra})

    def _static(self, route, query):
        if route in ("/", "/master", "/index.html"):
            target = WEB / "index.html"
        elif route in ("/client", "/workspace", "/workspace.html"):
            target = WEB / "workspace.html"
        elif route.startswith("/apps/"):
            target = (APPS_DIR / route[len("/apps/"):]).resolve()
            if APPS_DIR.resolve() not in target.parents or any(p.startswith(".") for p in target.relative_to(APPS_DIR.resolve()).parts):
                return self._json(403, {"error": "forbidden"})
            if not target.is_file() or target.suffix.lower() not in APP_MIME:
                return self._json(404, {"error": "not found"})
            # Third-party app code runs in an opaque origin even if opened directly: no token, no storage, no parent access.
            return self._send(200, target.read_bytes(), APP_MIME[target.suffix.lower()], {"Content-Security-Policy": "sandbox allow-scripts; default-src 'self' 'unsafe-inline' data: blob:; media-src 'self' blob: data:"})
        else:
            target = (WEB / route.lstrip("/")).resolve()
            if WEB.resolve() not in target.parents:
                return self._json(403, {"error": "forbidden"})
        if not target.is_file() or target.suffix.lower() not in MIME:
            return self._json(404, {"error": "not found"})
        data = target.read_bytes()
        if target.suffix.lower() == ".html":
            loopback = is_loopback(self.client_address[0])
            if not loopback and not self._token_ok(query):
                page = ("<meta name=viewport content='width=device-width'><body style='font:16px sans-serif;"
                        "background:#07111e;color:#cde;padding:24px'><h2>KEAL: pairing token required</h2>"
                        "<p>Open the exact /client?t=... address printed by the server.</p>").encode()
                return self._send(401, page, MIME[".html"])
            meta = ('<meta name="keal-token" content="%s"><meta name="keal-boot" content="%s">'
                    '<meta name="keal-version" content="%s">' % (self.relay.token, self.relay.boot_id, VERSION))
            text = data.decode("utf-8").replace("<!--KEAL_META-->", meta)
            data = text.replace("__KEAL_V__", VERSION + "-" + self.relay.boot_id).encode("utf-8")
        return self._send(200, data, MIME[target.suffix.lower()])

    def _post(self):
        parsed = urlparse(self.path)
        route = parsed.path
        try:
            data = self._read_json()    # always consume the body first (keep-alive safety)
        except (ValueError, UnicodeDecodeError) as exc:
            self.close_connection = True
            return self._json(400, {"error": "invalid request: %s" % exc})
        if route not in ("/api/heartbeat", "/api/focus", "/api/events", "/api/fs/write", "/api/fs/mkdir", "/api/fs/delete", "/api/settings", "/api/apps/install", "/api/apps/uninstall"):
            return self._json(404, {"error": "not found"})
        if not self._token_ok(parse_qs(parsed.query)):
            return self._json(401, {"error": "missing or wrong token"})
        if route == "/api/fs/write":
            return self._fs(lambda: self.relay.files.write(data.get("path"), data.get("content"), data.get("base"), data.get("force") is True))
        if route == "/api/fs/mkdir":
            return self._fs(lambda: self.relay.files.mkdir(data.get("path")))
        if route == "/api/fs/delete":
            return self._fs(lambda: self.relay.files.delete(data.get("path")))
        if route in ("/api/apps/install", "/api/apps/uninstall"):
            return self._fs(lambda: self.relay.apps.change(data.get("device"), data.get("id"), route.endswith("/install")))
        if route == "/api/settings":
            return self._fs(lambda: {"settings": self.relay.settings.update(data.get("key"), data.get("value"))})
        if route == "/api/heartbeat":
            status, body = self.relay.heartbeat(data.get("role"), data.get("instance"), data.get("visible"))
        elif route == "/api/focus":
            status, body = self.relay.set_focus(data.get("target"))
        else:
            batch = data.get("events")
            if not isinstance(batch, list) or len(batch) > MAX_BATCH:
                return self._json(400, {"error": "events must be a list of at most %d items" % MAX_BATCH})
            status, body = self.relay.submit(batch, data.get("focus_revision"))
        return self._json(status, body)


def make_server(relay, host="127.0.0.1", port=0):
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    httpd.relay = relay
    return httpd


def probable_lan_ips():
    found = set()
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.connect(("10.255.255.255", 1))   # picks the preferred local route; sends nothing
        found.add(sock.getsockname()[0])
        sock.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            if not info[4][0].startswith("127."):
                found.add(info[4][0])
    except OSError:
        pass
    return sorted(found)


def main(argv=None):
    parser = argparse.ArgumentParser(description="KEAL OS relay server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--files-dir", default=os.environ.get("KEAL_FILES", str(Path.home() / "keal_files")),
                        help="the ONLY folder KEAL OS may read/write (default ~/keal_files)")
    parser.add_argument("--apps-dir", default=str(ROOT / "apps"), help="folder with apps/<id>/manifest.json (default ./apps)")
    parser.add_argument("--music-dir", default=os.environ.get("KEAL_MUSIC", str(Path.home() / "keal_music")),
                        help="read-only music folder for the Music app (default ~/keal_music)")
    parser.add_argument("--data-dir", default=os.environ.get("KEAL_DATA", str(Path.home() / ".keal")),
                        help="where settings.json lives (default ~/.keal)")
    parser.add_argument("--token", default=os.environ.get("KEAL_TOKEN"),
                        help="fixed pairing token (default: random each start; env KEAL_TOKEN)")
    args = parser.parse_args(argv)
    global APPS_DIR
    APPS_DIR = Path(args.apps_dir).resolve()
    relay = Relay(token=args.token, files=FileStore(args.files_dir), settings=SettingsStore(Path(args.data_dir) / "settings.json"),
                  apps=AppRegistry(APPS_DIR, Path(args.data_dir) / "apps.json"), media=MediaLibrary(args.music_dir))
    try:
        httpd = make_server(relay, args.host, args.port)
    except OSError as exc:
        print("Could not start on port %d: %s\nTry: pkill -f server.py   or   --port 8766" % (args.port, exc))
        return 1
    print("\nKEAL OS relay v%s  (boot %s)" % (VERSION, relay.boot_id))
    print("Redmi master : http://127.0.0.1:%d/" % args.port)
    ips = probable_lan_ips()
    for ip in ips:
        print("Samsung      : http://%s:%d/client?t=%s" % (ip, args.port, relay.token))
    if not ips:
        print("Samsung      : http://<Redmi-IP>:%d/client?t=%s" % (args.port, relay.token))
    print("Files folder : %s   (the only folder KEAL can touch)" % relay.files.label())
    print("Music folder : %s   (read-only, for the Music app)" % relay.media.label())
    print("Private-network clients only. Ctrl+C to stop.\n", flush=True)
    try:
        httpd.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
