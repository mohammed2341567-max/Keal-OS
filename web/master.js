(() => {
  'use strict';
  const { api, token, boot } = window.KealRelay;
  const layer = document.getElementById('windowLayer');
  const toast = document.getElementById('toast');
  const appStatus = document.getElementById('clientStatus');
  const statusText = document.getElementById('clientStatusText');
  const deviceBadge = document.getElementById('deviceClientBadge');
  const lineText = document.getElementById('connectionLineText');
  const relayState = document.getElementById('relayState');
  const dockText = document.getElementById('dockSessionText');
  let zCounter = 10;
  let lastTouchTap = { app: '', time: 0 };
  let toastTimer = null;
  let dragging = null;
  const appWindows = new Map();

  const apps = {
    workspace: { title: 'Samsung Workspace', mark: '▣', width: 760, height: 470, className: 'workspace-window' },
    monitor: { title: 'System Monitor', mark: '⌁', width: 480, height: 390 },
    files: { title: 'File Explorer', mark: '▱', width: 540, height: 430 },
    notes: { title: 'Quick Notes', mark: '▤', width: 560, height: 430 },
    settings: { title: 'Settings', mark: '⚙', width: 560, height: 470 },
    diagnostics: { title: 'Diagnostics', mark: '◎', width: 560, height: 420 },
    store: { title: 'App Store', mark: '⊞', width: 600, height: 470 },
    account: { title: 'KEAL Account', mark: '◎', width: 520, height: 420 },
    chat: { title: 'Friends Chat', mark: '✉', width: 620, height: 500 },
  };

  function notify(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function appContents(app) {
    if (apps[app] && apps[app].ext) return Keal.appFrameHtml(apps[app].ext);
    if (app === 'store') return `<div class="kd-mount kd-mount-store"></div>`;
    if (app === 'account') return `<div class="kd-mount ki-account-mount"></div>`;
    if (app === 'chat') return `<div class="kd-mount ki-chat-mount"></div>`;
    if (app === 'workspace') {
      return `<iframe class="workspace-frame" title="Samsung virtual workspace controller" src="${KealRelay.pageUrl(KealRelay.isWeb ? 'client/index.html?mode=control' : '/workspace?mode=control&t=' + encodeURIComponent(token))}" tabindex="0" allow="clipboard-read; clipboard-write"></iframe>`;
    }
    if (app === 'diagnostics') {
      return `<div class="simple-panel"><pre id="diagText" class="diag-text">Waiting for relay status…</pre></div>`;
    }
    if (app === 'monitor') {
      return `<div class="simple-panel"><h3>Connection Monitor</h3><p>Local event relay between the Redmi controller and the Samsung browser workspace.</p><div class="metric-grid"><div class="metric-card"><small>SAMSUNG CLIENT</small><b id="monitorClientState">WAITING</b></div><div class="metric-card"><small>RELAY MODE</small><b>HTTP POLL</b></div><div class="metric-card"><small>INPUT TARGET</small><b>KEAL UI</b></div><div class="metric-card"><small>ANDROID ACCESS</small><b>NONE</b></div></div><p class="panel-foot">The monitor cannot read Android CPU or memory values. Input events are processed only inside this virtual workspace.</p></div>`;
    }
    if (app === 'files') {
      return `<div class="kd-mount kd-mount-files"></div>`;
    }
    if (app === 'notes') {
      return `<div class="kd-mount kd-mount-notes"></div>`;
    }
    return `<div class="kd-mount kd-mount-settings"></div>`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function openApp(app) {
    if (!apps[app]) return;
    if (appWindows.has(app)) {
      const win = appWindows.get(app);
      win.classList.remove('minimized');
      win.style.display = 'flex';
      bringToFront(win);
      reclampWindow(win);
      if (app === 'workspace') notify('Samsung Workspace opened · use the virtual screen inside the window');
      return;
    }
    const def = apps[app];
    const win = document.createElement('section');
    win.className = `app-window ${def.className || ''}`;
    win.dataset.app = app;
    const narrow = layer.clientWidth < 900;
    const isWs = app === 'workspace';
    // The launcher column (icons) lives on the left of wide screens; the controller window gets the space to its right.
    const reserved = isWs && !narrow ? 410 : 0;
    const width = Math.min(def.width, Math.max(300, layer.clientWidth - reserved - 24));
    const height = Math.min(def.height, Math.max(230, layer.clientHeight - 16));
    const offset = (appWindows.size % 4) * 26;
    win.style.width = width + 'px';
    win.style.height = height + 'px';
    let left = Math.round((layer.clientWidth - width) / 2 + offset - 35);
    let top = Math.round((layer.clientHeight - height) / 2 + offset - 28);
    if (isWs) { left = layer.clientWidth - width - 12; top = layer.clientHeight - height - 4; }
    win.style.left = Math.max(6, Math.min(left, layer.clientWidth - width - 6)) + 'px';
    win.style.top = Math.max(6, Math.min(top, layer.clientHeight - height - 6)) + 'px';
    win.style.zIndex = String(++zCounter);
    win.innerHTML = `<header class="window-titlebar"><span class="window-app-mark">${escapeHtml(def.mark)}</span><span class="window-title">${escapeHtml(def.title)}</span><span class="window-subtitle">${app === 'workspace' ? 'REMOTE INPUT WINDOW' : 'KEAL SYSTEM APP'}</span><div class="window-actions"><button type="button" data-minimize title="Minimize">−</button><button type="button" data-maximize title="Maximize">□</button><button type="button" class="close-window" data-close title="Close">×</button></div></header><div class="window-content">${appContents(app)}</div>`;
    layer.appendChild(win);
    appWindows.set(app, win);
    bringToFront(win);
    setupWindow(win, app);
    syncDock();
    if (app === 'workspace') notify('Controller ready · choose SAMSUNG in the top bar to route input');
  }

  // Installed store apps become desktop icons + windows (key 'x-<id>' never collides with built-ins).
  function syncExternalApps() {
    const wanted = new Map(Keal.installedFor('master').map(a => ['x-' + a.id, a]));
    Object.keys(apps).filter(k => k.startsWith('x-') && !wanted.has(k)).forEach(k => {
      const win = appWindows.get(k);
      if (win) { win.remove(); appWindows.delete(k); }
      delete apps[k];
    });
    wanted.forEach((manifest, key) => { apps[key] = { title: manifest.name, mark: manifest.icon, width: manifest.width, height: manifest.height, ext: manifest }; });
    const grid = document.querySelector('.desktop-icons');
    grid.querySelectorAll('.ext-icon').forEach(node => node.remove());
    wanted.forEach((manifest, key) => {
      const button = document.createElement('button');
      button.className = 'desktop-icon ext-icon';
      button.dataset.app = key;
      button.setAttribute('aria-label', manifest.name + ', double click to open');
      button.innerHTML = '<span class="app-icon app-icon-blue"><b class="ext-glyph">' + Keal.esc(manifest.icon) + '</b></span><span class="desktop-icon-label">' + Keal.esc(manifest.name) + '</span><span class="desktop-icon-hint">APP</span>';
      grid.appendChild(button);
    });
    syncDock();
  }
  window.addEventListener('keal-apps', syncExternalApps);
  document.querySelector('.desktop-icons').addEventListener('click', event => {
    const button = event.target.closest('.ext-icon');
    if (button) document.querySelectorAll('.desktop-icon').forEach(item => item.classList.toggle('was-selected', item === button));
  });
  document.querySelector('.desktop-icons').addEventListener('dblclick', event => {
    const button = event.target.closest('.ext-icon');
    if (button) { event.preventDefault(); openApp(button.dataset.app); }
  });

  let pendingEditorPath = null;
  // Files opened from the explorer load into Quick Notes (the Redmi's text editor).
  function openInEditor(path) {
    const existing = appWindows.get('notes');
    if (existing && existing._editor) { existing._editor.open(path); openApp('notes'); return; }
    pendingEditorPath = path;
    openApp('notes');
  }

  const desktopEl = document.getElementById('masterDesktop');
  const applySettings = settings => { if (settings && window.Keal) Keal.applyWallpaper(desktopEl, settings.wallpaper_master); };
  window.addEventListener('keal-status', event => applySettings(event.detail && event.detail.settings));
  window.addEventListener('keal-settings', event => applySettings(event.detail));

  function bringToFront(win) {
    win.style.zIndex = String(++zCounter);
    layer.querySelectorAll('.app-window').forEach(item => item.classList.toggle('active', item === win));
    syncDock();
  }

  // Dock shows what is open (bar), minimised (short bar) and focused (bright bar).
  function syncDock() {
    document.querySelectorAll('.dock-app').forEach(button => {
      const win = appWindows.get(button.dataset.app);
      const minimized = !!win && win.classList.contains('minimized');
      button.classList.toggle('running', !!win);
      button.classList.toggle('is-minimized', minimized);
      button.classList.toggle('is-focused', !!win && !minimized && win.classList.contains('active'));
    });
  }

  // Keep a window inside the visible workspace (also after rotation / browser resize).
  function reclampWindow(win) {
    const W = layer.clientWidth, H = layer.clientHeight;
    if (win.dataset.maximized === 'true') {
      win.style.left = '5px'; win.style.top = '5px';
      win.style.width = Math.max(280, W - 10) + 'px';
      win.style.height = Math.max(190, H - 10) + 'px';
      return;
    }
    const width = Math.min(win.offsetWidth || 300, Math.max(260, W - 12));
    const height = Math.min(win.offsetHeight || 200, Math.max(180, H - 12));
    win.style.width = width + 'px';
    win.style.height = height + 'px';
    win.style.left = Math.max(0, Math.min(parseFloat(win.style.left) || 0, W - width)) + 'px';
    win.style.top = Math.max(0, Math.min(parseFloat(win.style.top) || 0, H - height)) + 'px';
  }
  window.addEventListener('resize', () => appWindows.forEach(reclampWindow));
  window.addEventListener('orientationchange', () => setTimeout(() => appWindows.forEach(reclampWindow), 250));

  function setupWindow(win, app) {
    win.querySelector('[data-close]').addEventListener('click', () => {
      appWindows.delete(app);
      win.remove();
      syncDock();
    });
    win.querySelector('[data-minimize]').addEventListener('click', () => { win.classList.add('minimized'); win.classList.remove('active'); syncDock(); });
    win.querySelector('.window-titlebar').addEventListener('dblclick', event => {
      if (!event.target.closest('.window-actions')) win.querySelector('[data-maximize]').click();
    });
    win.querySelector('[data-maximize]').addEventListener('click', () => {
      const maximized = win.dataset.maximized === 'true';
      if (maximized) {
        win.style.left = win.dataset.oldLeft || '30px';
        win.style.top = win.dataset.oldTop || '30px';
        win.style.width = win.dataset.oldWidth || '820px';
        win.style.height = win.dataset.oldHeight || '560px';
        win.dataset.maximized = 'false';
      } else {
        win.dataset.oldLeft = win.style.left;
        win.dataset.oldTop = win.style.top;
        win.dataset.oldWidth = win.style.width;
        win.dataset.oldHeight = win.style.height;
        win.dataset.maximized = 'true';
        reclampWindow(win);
      }
    });
    win.addEventListener('pointerdown', () => bringToFront(win));
    const accountMount = win.querySelector('.ki-account-mount');
    if (accountMount && window.KealIdentity) KealIdentity.mountAccount(accountMount);
    const chatMount = win.querySelector('.ki-chat-mount');
    if (chatMount && window.KealIdentity) KealIdentity.mountChat(chatMount);
    const storeMount = win.querySelector('.kd-mount-store');
    if (storeMount) Keal.mountStore(storeMount, { devices: [{ key: 'master', label: 'REDMI' }, { key: 'client', label: 'SAMSUNG' }], host: 'master', onOpen: id => openApp('x-' + id) });
    const extFrame = win.querySelector('.ext-app');
    if (extFrame && apps[app] && apps[app].ext) Keal.attachAppHost(extFrame, apps[app].ext, 'master');
    const filesMount = win.querySelector('.kd-mount-files');
    if (filesMount) Keal.mountFiles(filesMount, { onOpen: openInEditor });
    const notesMount = win.querySelector('.kd-mount-notes');
    if (notesMount) win._editor = Keal.mountEditor(notesMount, { path: pendingEditorPath || 'notes/quick-notes.md', kind: 'masterNotes' });
    pendingEditorPath = null;
    const settingsMount = win.querySelector('.kd-mount-settings');
    if (settingsMount) Keal.mountSettings(settingsMount, { devices: [{ key: 'wallpaper_master', label: 'REDMI WALLPAPER' }, { key: 'wallpaper_client', label: 'SAMSUNG WALLPAPER' }] });
    if (app === 'workspace') {
      const frame = win.querySelector('iframe');
      frame.addEventListener('load', () => {
        notify('Controller is running · choose SAMSUNG in the top bar to route input');
      });
    }
  }

  // Desktop icons deliberately require a double-click; touch devices use a double-tap fallback.
  document.querySelectorAll('.desktop-icon').forEach(button => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.desktop-icon').forEach(item => item.classList.toggle('was-selected', item === button));
    });
    button.addEventListener('dblclick', event => {
      event.preventDefault();
      openApp(button.dataset.app);
    });
    button.addEventListener('pointerup', event => {
      if (event.pointerType !== 'touch') return;
      const app = button.dataset.app;
      const now = Date.now();
      if (lastTouchTap.app === app && now - lastTouchTap.time < 430) openApp(app);
      lastTouchTap = { app, time: now };
    });
  });

  document.querySelectorAll('.dock-app').forEach(button => button.addEventListener('click', () => {
    const win = appWindows.get(button.dataset.app);
    if (win && !win.classList.contains('minimized') && win.classList.contains('active')) {
      win.classList.add('minimized'); win.classList.remove('active'); syncDock();   // taskbar-style toggle
    } else openApp(button.dataset.app);
  }));
  document.getElementById('dockLauncher').addEventListener('click', () => notify('Double-click Samsung Workspace on the desktop, or launch an app from the dock.'));
  document.getElementById('aboutButton').addEventListener('click', () => notify('KEAL OS V6 · Dual Edition Workspace'));

  // Drag app windows by their title bars; pointer events keep this usable on touchscreens.
  layer.addEventListener('pointerdown', event => {
    const bar = event.target.closest('.window-titlebar');
    if (!bar || event.target.closest('.window-actions')) return;
    const win = bar.closest('.app-window');
    if (!win) return;
    bringToFront(win);
    dragging = { win, x: event.clientX, y: event.clientY, left: parseFloat(win.style.left) || 0, top: parseFloat(win.style.top) || 0 };
    try { bar.setPointerCapture(event.pointerId); } catch (_) {}
    event.preventDefault();
  });
  document.addEventListener('pointermove', event => {
    if (!dragging) return;
    if (dragging.win.dataset.maximized === 'true') return;
    dragging.win.style.left = Math.max(-dragging.win.offsetWidth + 140, Math.min(layer.clientWidth - 140, dragging.left + event.clientX - dragging.x)) + 'px';
    dragging.win.style.top = Math.max(0, Math.min(layer.clientHeight - 44, dragging.top + event.clientY - dragging.y)) + 'px';
  });
  document.addEventListener('pointerup', () => { dragging = null; });

  function updateClock() {
    const now = new Date();
    document.getElementById('clockTime').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    document.getElementById('clockDate').textContent = now.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }).toUpperCase();
  }
  updateClock();
  setInterval(updateClock, 10000);

  let lastStatus = null;
  function setChip(id, on, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('chip-on', !!on);
    el.classList.toggle('chip-off', !on);
    el.textContent = text;
  }

  function renderStatus(data, serverUp) {
    const online = !!(data && data.client_online);
    const controllerOnline = !!(data && data.controller_online);
    const target = data ? data.input_target : 'local';
    appStatus.classList.toggle('status-online', online && controllerOnline);
    appStatus.classList.toggle('status-offline', !(online && controllerOnline));
    statusText.textContent = !serverUp ? 'SERVER UNAVAILABLE' : !online ? 'SAMSUNG OFFLINE' : (controllerOnline ? 'SAMSUNG CONNECTED' : 'SAMSUNG ONLINE · CONTROLLER OFF');
    deviceBadge.classList.toggle('online', online);
    deviceBadge.textContent = online ? 'ONLINE' : 'OFFLINE';
    lineText.textContent = !serverUp ? 'CHECK LOCAL SERVER' : !online ? 'WAITING FOR CLIENT' : (controllerOnline ? 'CLIENT LINK ACTIVE' : 'CONTROLLER NOT RUNNING');
    relayState.textContent = !serverUp ? 'OFFLINE' : !online ? 'STANDBY' : (controllerOnline ? (target === 'samsung' ? 'REMOTE ACTIVE' : 'LOCAL READY') : 'NO CONTROLLER');
    dockText.textContent = !serverUp ? 'SERVER UNAVAILABLE' : (target === 'samsung' ? 'INPUT → SAMSUNG' : (online ? 'INPUT → REDMI' : 'LOCAL SESSION READY'));
    setChip('chipServer', serverUp, serverUp ? 'SERVER OK' : 'SERVER DOWN');
    setChip('chipClient', online, online ? 'SAMSUNG ON' : 'SAMSUNG OFF');
    setChip('chipController', controllerOnline, controllerOnline ? 'CONTROLLER ON' : 'CONTROLLER OFF');
    const focusLocal = document.getElementById('mFocusLocal');
    const focusRemote = document.getElementById('mFocusSamsung');
    focusLocal.classList.toggle('is-active', target !== 'samsung');
    focusRemote.classList.toggle('is-active', target === 'samsung');
    focusRemote.disabled = !(online && controllerOnline) && target !== 'samsung';
    const monitorState = document.getElementById('monitorClientState');
    if (monitorState) monitorState.textContent = online ? 'ONLINE' : 'WAITING';
    renderDiagnostics(data, serverUp);
  }

  function renderDiagnostics(data, serverUp) {
    const out = document.getElementById('diagText');
    if (!out) return;
    const frame = document.querySelector('.workspace-frame');
    const ctl = frame && frame.contentWindow && frame.contentWindow.__kealDebug;
    const age = v => (v === null || v === undefined ? '—' : v.toFixed(1) + 's');
    const d = data || {};
    out.textContent = [
      'SERVER        ' + (serverUp ? 'running · v' + (d.version || '?') + ' · uptime ' + (d.uptime_s ?? '—') + 's' : 'UNREACHABLE'),
      'INPUT TARGET  ' + (d.input_target || '—').toUpperCase() + ' · revision ' + (d.focus_revision ?? '—') + ' · reason ' + (d.focus_reason || '—'),
      'CONTROLLER    ' + (d.controller_online ? 'ONLINE' : 'offline') + ' · heartbeat ' + age(d.controller_age) + ' · tab visible ' + d.controller_visible,
      'SAMSUNG       ' + (d.client_online ? 'ONLINE' : 'offline') + ' · heartbeat ' + age(d.client_age) + ' · poll ' + age(d.client_poll_age),
      'EVENTS        accepted ' + (d.accepted_events ?? '—') + ' · latest seq ' + (d.latest_seq ?? '—') + ' · rejected batches ' + (d.rejected_batches ?? '—'),
      'LAST POINTER  ' + (d.last_pointer ? d.last_pointer.x + ', ' + d.last_pointer.y + ' (' + age(d.last_pointer.age) + ' ago)' : '—'),
      'LAST EVENT    ' + (d.last_event ? d.last_event.type + ' #' + d.last_event.seq + ' (' + age(d.last_event.age) + ' ago)' : '—'),
      'SERVER ERROR  ' + (d.last_error ? d.last_error.reason + ' (' + age(d.last_error.age) + ' ago)' : 'none'),
      '',
      'CONTROLLER IFRAME ' + (ctl ? (ctl.ready ? 'ready' : 'loading') : 'NOT OPEN / NOT LOADED'),
      ctl ? '  captured ' + ctl.captured + ' · queued ' + ctl.queued + ' · sent ' + ctl.sent + ' · dropped ' + ctl.dropped : '',
      ctl ? '  last captured pointer ' + (ctl.lastPointer ? ctl.lastPointer.x + ', ' + ctl.lastPointer.y : '—') : '',
      ctl ? '  relay error ' + (ctl.lastRelayError || 'none') + ' · rtt ' + (ctl.rtt ?? '—') + 'ms · hb ok/fail ' + ctl.hbOk + '/' + ctl.hbFail : '',
    ].filter(line => line !== '').join('\n');
  }

  async function refreshStatus() {
    const res = await api('/api/status');
    if (res.ok) {
      lastStatus = res.data;
      window.dispatchEvent(new CustomEvent('keal-status', { detail: res.data }));
      if (boot && res.data.boot_id && res.data.boot_id !== boot && !sessionStorage.getItem('keal.master.reloaded')) {
        sessionStorage.setItem('keal.master.reloaded', '1');
        notify('Server restarted · reloading page');
        setTimeout(() => location.reload(), 900);
      }
      renderStatus(res.data, true);
    } else {
      renderStatus(res.status === 401 ? lastStatus : null, res.status === 401);
      if (res.status === 401) { statusText.textContent = 'TOKEN REJECTED · RELOAD PAGE'; }
    }
  }

  // Keyboard capture lives in the controller iframe, so remote focus must move browser focus there.
  function focusControlSurface() {
    const frame = document.querySelector('.workspace-frame');
    if (!frame) { notify('Open Samsung Workspace first: keyboard relay needs the controller window'); return; }
    try { document.activeElement && document.activeElement.blur(); frame.focus(); frame.contentWindow.focus(); } catch (_) {}
  }

  async function setFocus(target) {
    const res = await api('/api/focus', { method: 'POST', body: { target } });
    if (!res.ok) notify('Focus not changed: ' + ((res.data && res.data.error) || 'relay unreachable'));
    else {
      const frame = document.querySelector('.workspace-frame');
      try { if (frame && frame.contentWindow.__kealApplyStatus) frame.contentWindow.__kealApplyStatus(res.data); } catch (_) {}
      if (target === 'samsung') focusControlSurface();
    }
    refreshStatus();
  }
  document.getElementById('mFocusLocal').addEventListener('click', () => setFocus('local'));
  document.getElementById('mFocusSamsung').addEventListener('click', () => setFocus('samsung'));
  document.getElementById('diagButton').addEventListener('click', () => openApp('diagnostics'));
  // Safety net on the master page itself: Ctrl+Alt+L always returns input to the Redmi.
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.altKey && event.key.toLowerCase() === 'l') { event.preventDefault(); setFocus('local'); }
  });
  // The embedded workspace controller owns the controller heartbeat. Keeping
  // a root-page heartbeat here would hide the fact that the input relay iframe closed.
  refreshStatus();
  setInterval(refreshStatus, 1000);

  // The control iframe owns the controller heartbeat and input capture. Start it
  // on launch so Samsung does not remain stuck at WAITING FOR MASTER after a reload.
  // Add ?manual=1 to the URL if a developer explicitly wants a bare desktop.
  const launchParams = new URLSearchParams(window.location.search);
  if (!launchParams.has('manual')) {
    window.setTimeout(() => {
      if (!appWindows.has('workspace')) openApp('workspace');
    }, 350);
  }
})();
