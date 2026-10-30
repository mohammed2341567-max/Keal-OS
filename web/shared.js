// Shared UI building blocks used by both the Redmi master and the Samsung workspace:
// real-file API wrapper, synced text editor, file explorer, wallpapers and settings.
(() => {
  'use strict';
  const { api } = window.KealRelay;
  const enc = encodeURIComponent;
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const FS = {
    list: p => api('/api/fs/list?path=' + enc(p || '')),
    read: p => api('/api/fs/read?path=' + enc(p)),
    write: (path, content, base, force) => api('/api/fs/write', { method: 'POST', body: { path, content, base: base || null, force: !!force } }),
    mkdir: path => api('/api/fs/mkdir', { method: 'POST', body: { path } }),
    remove: path => api('/api/fs/delete', { method: 'POST', body: { path } }),
  };

  const WALLPAPERS = [
    { id: 'midnight', name: 'Midnight Grid', mood: 'Default', css: '' },
    { id: 'aurora', name: 'Aurora', mood: 'Calm', css: 'radial-gradient(ellipse at 20% 15%,rgba(40,220,170,.28),transparent 55%),radial-gradient(ellipse at 80% 70%,rgba(60,130,255,.25),transparent 55%),linear-gradient(160deg,#04141a,#06202a 55%,#050f1c)' },
    { id: 'ember', name: 'Ember', mood: 'Energy', css: 'radial-gradient(ellipse at 75% 20%,rgba(255,140,60,.28),transparent 50%),radial-gradient(ellipse at 15% 85%,rgba(200,50,90,.22),transparent 55%),linear-gradient(160deg,#150a10,#1d0f14 55%,#0d0810)' },
    { id: 'ocean', name: 'Deep Ocean', mood: 'Focus', css: 'radial-gradient(ellipse at 50% 110%,rgba(30,140,220,.4),transparent 60%),radial-gradient(ellipse at 90% 0%,rgba(20,200,220,.18),transparent 50%),linear-gradient(180deg,#03101f,#04223a 70%,#03182c)' },
    { id: 'nebula', name: 'Nebula', mood: 'Creative', css: 'radial-gradient(ellipse at 25% 30%,rgba(150,90,255,.32),transparent 52%),radial-gradient(ellipse at 80% 75%,rgba(255,90,200,.18),transparent 50%),linear-gradient(150deg,#0c0820,#140d2e 55%,#080616)' },
    { id: 'graphite', name: 'Graphite', mood: 'Minimal', css: 'linear-gradient(145deg,#14171b,#0e1013 60%,#0b0c0f)' },
  ];
  function applyWallpaper(el, id) {
    if (!el) return;
    const wp = WALLPAPERS.find(w => w.id === id) || WALLPAPERS[0];
    el.style.background = wp.css;
    el.dataset.wallpaper = wp.id;
  }

  let latest = null;
  window.addEventListener('keal-status', event => { latest = event.detail; });

  async function setSetting(key, value) {
    const res = await api('/api/settings', { method: 'POST', body: { key, value } });
    if (res.ok && res.data.settings) window.dispatchEvent(new CustomEvent('keal-settings', { detail: res.data.settings }));
    return res;
  }

  // ---- synced text editor -----------------------------------------------------
  function mountEditor(root, { path, kind = 'text' }) {
    root.innerHTML = '<div class="kd"><div class="kd-head"><input class="kd-path" spellcheck="false" aria-label="File path"><button class="kd-btn" data-act="open" type="button">OPEN</button><span class="kd-state">LOADING…</span></div>' +
      '<div class="kd-conflict" hidden><span>Changed on another device.</span><button class="kd-btn" data-act="mine" type="button">KEEP MINE</button><button class="kd-btn" data-act="theirs" type="button">LOAD THEIRS</button></div>' +
      '<textarea class="kd-text" spellcheck="false" aria-label="Editor"></textarea></div>';
    const pathInput = root.querySelector('.kd-path');
    const stateEl = root.querySelector('.kd-state');
    const conflictEl = root.querySelector('.kd-conflict');
    const ta = root.querySelector('.kd-text');
    ta.id = kind + 'Text';
    let current = path, version = null, dirty = false, saving = false, conflict = null, timer = null, lastRev = latest ? latest.files_rev : null;
    const setState = text => { stateEl.textContent = text; };

    async function load(p) {
      current = p; pathInput.value = p; conflict = null; conflictEl.hidden = true; dirty = false;
      setState('LOADING…');
      const res = await FS.read(p);
      if (res.ok) { ta.value = res.data.content; version = res.data.version; setState('SAVED'); }
      else if (res.status === 404) { ta.value = ''; version = null; setState('NEW FILE · type to create'); }
      else setState('CANNOT OPEN: ' + ((res.data && res.data.error) || (res.status === 0 ? 'offline' : res.status)));
    }

    async function save(force) {
      if (!dirty || saving || (conflict && !force)) return;
      saving = true; setState('SAVING…');
      const content = ta.value, target = current;
      const res = await FS.write(target, content, version, force);
      saving = false;
      if (target !== current) return;
      if (res.ok) { version = res.data.version; if (ta.value === content) { dirty = false; setState('SAVED'); } }
      else if (res.status === 409) { conflict = res.data && res.data.current || { content: '', version: null }; conflictEl.hidden = false; setState('CONFLICT'); return; }
      else setState('SAVE FAILED: ' + ((res.data && res.data.error) || 'offline') + ' · retrying');
      if (dirty) { clearTimeout(timer); timer = setTimeout(() => save(false), res.ok ? 200 : 2000); }
    }

    ta.addEventListener('input', () => { dirty = true; setState('EDITING…'); clearTimeout(timer); timer = setTimeout(() => save(false), 700); });
    root.querySelector('[data-act="open"]').addEventListener('click', () => load(pathInput.value.trim()));
    pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); load(pathInput.value.trim()); } });
    root.querySelector('[data-act="mine"]').addEventListener('click', () => { conflict = null; conflictEl.hidden = true; save(true); });
    root.querySelector('[data-act="theirs"]').addEventListener('click', () => {
      if (conflict) { ta.value = conflict.content || ''; version = conflict.version; }
      conflict = null; conflictEl.hidden = true; dirty = false; setState('LOADED THE OTHER DEVICE\'S VERSION');
    });

    async function onStatus(event) {
      if (!root.isConnected) { window.removeEventListener('keal-status', onStatus); clearTimeout(timer); return; }
      const rev = event.detail && event.detail.files_rev;
      if (rev === undefined || rev === lastRev) return;
      lastRev = rev;
      if (dirty || saving || conflict) return;     // never overwrite what is being typed
      const res = await FS.read(current);
      if (res.ok && res.data.version !== version && !dirty) {
        const pos = ta.selectionStart;
        ta.value = res.data.content; version = res.data.version;
        try { ta.setSelectionRange(Math.min(pos, ta.value.length), Math.min(pos, ta.value.length)); } catch (_) { /* not focused */ }
        setState('UPDATED FROM OTHER DEVICE');
      } else if (!res.ok && res.status === 404 && version !== null) { version = null; setState('FILE DELETED ELSEWHERE · save to recreate'); }
    }
    window.addEventListener('keal-status', onStatus);
    load(path);
    return { open: load, get path() { return current; } };
  }

  // ---- real file explorer -----------------------------------------------------
  function mountFiles(root, { onOpen }) {
    root.innerHTML = '<div class="kf"><div class="kf-head"><b class="kf-title">REAL FILES</b><span class="kf-root"></span></div>' +
      '<div class="kf-bar"><button class="kd-btn" data-act="up" type="button">↑ UP</button><button class="kd-btn" data-act="newfile" type="button">+ FILE</button><button class="kd-btn" data-act="newdir" type="button">+ FOLDER</button><span class="kf-path"></span></div>' +
      '<div class="kf-new" hidden><input class="kd-path" spellcheck="false" placeholder="name.txt"><button class="kd-btn" data-act="create" type="button">CREATE</button></div>' +
      '<div class="kf-list"></div><div class="kf-msg"></div></div>';
    const list = root.querySelector('.kf-list'), msg = root.querySelector('.kf-msg'), newRow = root.querySelector('.kf-new');
    const nameInput = newRow.querySelector('input');
    let dir = '', creating = null, pendingDelete = null, lastRev = latest ? latest.files_rev : null;
    const join = (a, b) => (a ? a + '/' : '') + b;

    async function refresh() {
      const res = await FS.list(dir);
      if (!res.ok) { list.innerHTML = ''; msg.textContent = 'Cannot list folder: ' + ((res.data && res.data.error) || 'relay offline'); return; }
      root.querySelector('.kf-root').textContent = res.data.root + ' on Redmi';
      root.querySelector('.kf-path').textContent = '/' + res.data.path;
      msg.textContent = res.data.entries.length ? '' : 'Empty folder.';
      list.innerHTML = res.data.entries.map(e => '<div class="kf-row"><button class="kf-item" type="button" data-type="' + e.type + '" data-name="' + esc(e.name) + '"><span>' + (e.type === 'dir' ? '▰' : '▱') + '</span><b>' + esc(e.name) + '</b><small>' + (e.type === 'dir' ? 'folder' : Math.max(1, Math.round(e.size / 1024)) + ' KB') + '</small></button>' +
        '<button class="kd-btn kf-del" type="button" data-del="' + esc(e.name) + '">' + (pendingDelete === join(dir, e.name) ? 'CONFIRM?' : '✕') + '</button></div>').join('');
    }
    root.addEventListener('click', async event => {
      const item = event.target.closest('.kf-item'), del = event.target.closest('[data-del]'), act = event.target.closest('[data-act]');
      if (item) {
        const full = join(dir, item.dataset.name);
        if (item.dataset.type === 'dir') { dir = full; pendingDelete = null; refresh(); } else onOpen(full);
      } else if (del) {
        const full = join(dir, del.dataset.del);
        if (pendingDelete !== full) { pendingDelete = full; refresh(); return; }
        pendingDelete = null;
        const res = await FS.remove(full);
        msg.textContent = res.ok ? 'Deleted.' : 'Delete failed: ' + ((res.data && res.data.error) || 'offline');
        refresh();
      } else if (act) {
        const a = act.dataset.act;
        if (a === 'up') { dir = dir.split('/').slice(0, -1).join('/'); refresh(); }
        else if (a === 'newfile' || a === 'newdir') { creating = a; newRow.hidden = false; nameInput.value = ''; nameInput.placeholder = a === 'newfile' ? 'name.txt' : 'folder-name'; nameInput.focus(); }
        else if (a === 'create') create();
      }
    });
    async function create() {
      let name = nameInput.value.trim();
      if (!name) return;
      let res;
      if (creating === 'newdir') res = await FS.mkdir(join(dir, name));
      else { if (!/\.[A-Za-z0-9]+$/.test(name)) name += '.txt'; res = await FS.write(join(dir, name), '', null, false); }
      if (res.ok) { newRow.hidden = true; msg.textContent = 'Created ' + name; refresh(); if (creating === 'newfile') onOpen(join(dir, name)); }
      else msg.textContent = 'Could not create: ' + ((res.data && res.data.error) || 'offline');
    }
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
    function onStatus(event) {
      if (!root.isConnected) { window.removeEventListener('keal-status', onStatus); return; }
      const rev = event.detail && event.detail.files_rev;
      if (rev !== undefined && rev !== lastRev) { lastRev = rev; refresh(); }
    }
    window.addEventListener('keal-status', onStatus);
    refresh();
  }

  // ---- wallpapers + real settings ---------------------------------------------
  function mountSettings(root, { devices }) {
    root.innerHTML = '<div class="ks"><div class="ks-tabs"></div><div class="wp-grid"></div><div class="ks-info"></div></div>';
    const tabs = root.querySelector('.ks-tabs'), grid = root.querySelector('.wp-grid'), info = root.querySelector('.ks-info');
    let active = devices[0].key;
    const settings = () => (latest && latest.settings) || {};
    function render() {
      tabs.innerHTML = devices.length > 1 ? devices.map(d => '<button class="kd-btn' + (d.key === active ? ' is-active' : '') + '" type="button" data-tab="' + d.key + '">' + esc(d.label) + '</button>').join('') : '<b class="kf-title">WALLPAPER</b>';
      const chosen = settings()[active] || 'midnight';
      grid.innerHTML = WALLPAPERS.map(w => '<button type="button" class="wp-swatch' + (w.id === chosen ? ' is-active' : '') + '" data-wp="' + w.id + '" style="background:' + (w.css || 'linear-gradient(130deg,#07111d,#08111f 50%,#050b14)') + '"><span>' + esc(w.name) + '</span><small>' + esc(w.mood) + (w.id === chosen ? ' · ACTIVE' : '') + '</small></button>').join('');
      info.innerHTML = '<div><small>FILES FOLDER</small><b>' + esc((latest && latest.files_root) || '—') + '</b></div><div><small>SERVER</small><b>v' + esc((latest && latest.version) || '?') + ' · ' + ((latest && latest.client_online) ? 'Samsung online' : 'Samsung offline') + '</b></div>';
    }
    root.addEventListener('click', async event => {
      const tab = event.target.closest('[data-tab]'), wp = event.target.closest('[data-wp]');
      if (tab) { active = tab.dataset.tab; render(); }
      else if (wp) { const res = await setSetting(active, wp.dataset.wp); if (res.ok && latest) { latest.settings = res.data.settings; } render(); }
    });
    let signature = '';
    function onStatus() {
      if (!root.isConnected) { window.removeEventListener('keal-status', onStatus); return; }
      const sig = JSON.stringify([settings(), latest && latest.files_root, latest && latest.version, latest && latest.client_online]);
      if (sig !== signature) { signature = sig; render(); }   // re-render only on real change, never under the pointer
    }
    window.addEventListener('keal-status', onStatus);
    render();
  }

  // ---- apps: registry state, sandbox bridge, store ---------------------------
  const AppsState = { catalog: [], installed: { master: [], client: [] }, rev: null };
  async function refreshApps() {
    const res = await api('/api/apps');
    if (res.ok) {
      AppsState.catalog = res.data.catalog; AppsState.installed = res.data.installed;
      window.dispatchEvent(new CustomEvent('keal-apps', { detail: AppsState }));
    }
  }
  window.addEventListener('keal-status', event => {
    const rev = event.detail && event.detail.apps_rev;
    if (rev !== undefined && rev !== AppsState.rev) { AppsState.rev = rev; refreshApps(); }
  });
  const installedFor = device => (AppsState.installed[device] || []).map(id => AppsState.catalog.find(a => a.id === id)).filter(Boolean);
  async function changeApp(device, id, install) {
    const res = await api(install ? '/api/apps/install' : '/api/apps/uninstall', { method: 'POST', body: { device, id } });
    if (res.ok) { AppsState.catalog = res.data.catalog; AppsState.installed = res.data.installed; window.dispatchEvent(new CustomEvent('keal-apps', { detail: AppsState })); }
    return res;
  }

  // Host side of the app bridge. The app lives in a sandboxed iframe (no token, no storage); every privileged call is checked against its manifest.
  function attachAppHost(iframe, manifest, device) {
    const ns = 'keal.app.' + device + '.' + manifest.id + '.';
    const need = perm => { if (!manifest.permissions.includes(perm)) throw new Error('permission_denied:' + perm); };
    const keyOf = k => { if (typeof k !== 'string' || !k || k.length > 64) throw new Error('bad_key'); return ns + k; };
    const fsResult = res => { if (!res.ok) throw new Error((res.data && res.data.error) || 'fs_failed'); return res.data; };
    const handlers = {
      'app.info': async () => ({ app: manifest.id, device }),
      'storage.get': async ({ key }) => localStorage.getItem(keyOf(key)),
      'storage.set': async ({ key, value }) => { if (typeof value !== 'string' && typeof value !== 'number') throw new Error('bad_value'); const text = String(value); if (text.length > 65536) throw new Error('value_too_large'); localStorage.setItem(keyOf(key), text); return true; },
      'storage.remove': async ({ key }) => { localStorage.removeItem(keyOf(key)); return true; },
      'music.list': async () => {
        need('music');
        const res = await api('/api/media/list');
        if (!res.ok) throw new Error('music_unavailable');
        const tracks = res.data.tracks.map(t => ({ ...t, url: KealRelay.pageUrl('media/' + t.path.split('/').map(enc).join('/') + '?m=' + enc(res.data.media_token)) }));
        return { tracks, root: res.data.root };
      },
      'fs.list': async ({ path }) => { need('files'); return fsResult(await FS.list(String(path || ''))); },
      'fs.read': async ({ path }) => { need('files'); return fsResult(await FS.read(String(path))); },
      'fs.write': async ({ path, content, base }) => { need('files'); return fsResult(await FS.write(String(path), content, base || null, false)); },
    };
    async function onMessage(event) {
      if (!iframe.isConnected) { window.removeEventListener('message', onMessage); return; }
      if (event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!msg || msg.keal !== 1 || typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
      let reply;
      try {
        const handler = handlers[msg.method];
        if (!handler) throw new Error('unknown_method');
        reply = { keal: 1, id: msg.id, result: await handler(msg.params && typeof msg.params === 'object' ? msg.params : {}) };
      } catch (err) {
        reply = { keal: 1, id: msg.id, error: String(err && err.message || err).slice(0, 120) };
      }
      if (iframe.contentWindow) iframe.contentWindow.postMessage(reply, '*');
    }
    window.addEventListener('message', onMessage);
  }
  const appFrameHtml = m => '<iframe class="ext-app" sandbox="allow-scripts" title="' + esc(m.name) + '" src="' + esc(KealRelay.pageUrl('apps/' + enc(m.id) + '/' + enc(m.entry))) + '"></iframe>';

  function mountStore(root, { devices, host, onOpen }) {
    root.innerHTML = '<div class="ks"><div class="ks-tabs"></div><div class="store-list"></div><div class="kf-msg"></div></div>';
    const tabs = root.querySelector('.ks-tabs'), list = root.querySelector('.store-list'), msg = root.querySelector('.kf-msg');
    let active = devices[0].key, pending = null;
    function render() {
      tabs.innerHTML = devices.length > 1 ? devices.map(d => '<button class="kd-btn' + (d.key === active ? ' is-active' : '') + '" type="button" data-tab="' + d.key + '">' + esc(d.label) + '</button>').join('') : '<b class="kf-title">APPS FOR THIS DEVICE</b>';
      if (!AppsState.catalog.length) { list.innerHTML = '<div class="empty-note">No apps in the <code>apps/</code> folder yet.</div>'; return; }
      list.innerHTML = AppsState.catalog.map(a => {
        const supported = a.targets.includes(active), installed = (AppsState.installed[active] || []).includes(a.id);
        let actions;
        if (!supported) actions = '<button class="kd-btn" disabled>NOT FOR THIS DEVICE</button>';
        else if (installed) actions = (active === host ? '<button class="kd-btn is-active" data-open="' + a.id + '" type="button">OPEN</button>' : '') + '<button class="kd-btn kf-del" data-remove="' + a.id + '" type="button">' + (pending === a.id ? 'CONFIRM?' : 'REMOVE') + '</button>';
        else actions = '<button class="kd-btn is-active" data-install="' + a.id + '" type="button">INSTALL</button>';
        return '<div class="store-card"><span class="store-icon">' + esc(a.icon) + '</span><div class="store-info"><b>' + esc(a.name) + ' <small>v' + esc(a.version) + '</small></b><p>' + esc(a.description) + '</p><div class="store-chips">' + a.targets.map(t => '<i>' + (t === 'master' ? 'REDMI' : 'SAMSUNG') + '</i>').join('') + a.permissions.map(p => '<i class="perm">' + esc(p) + '</i>').join('') + '</div></div><div class="store-actions">' + actions + '</div></div>';
      }).join('');
    }
    root.addEventListener('click', async event => {
      const t = event.target.closest('button'); if (!t || t.disabled) return;
      if (t.dataset.tab) { active = t.dataset.tab; pending = null; render(); }
      else if (t.dataset.install) { const r = await changeApp(active, t.dataset.install, true); msg.textContent = r.ok ? 'Installed.' : 'Install failed: ' + ((r.data && r.data.error) || 'offline'); render(); }
      else if (t.dataset.remove) {
        if (pending !== t.dataset.remove) { pending = t.dataset.remove; render(); return; }
        pending = null; const r = await changeApp(active, t.dataset.remove, false); msg.textContent = r.ok ? 'Removed. Its files and data are untouched.' : 'Remove failed.'; render();
      } else if (t.dataset.open) onOpen(t.dataset.open);
    });
    function onApps() { if (!root.isConnected) { window.removeEventListener('keal-apps', onApps); return; } render(); }
    window.addEventListener('keal-apps', onApps);
    render(); refreshApps();
  }

  window.Keal = { FS, WALLPAPERS, applyWallpaper, setSetting, mountEditor, mountFiles, mountSettings, esc, installedFor, attachAppHost, appFrameHtml, mountStore, changeApp, refreshApps };
})();
