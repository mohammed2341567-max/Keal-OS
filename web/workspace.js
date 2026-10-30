(() => {
  'use strict';

  const WIDTH = 1280;
  const HEIGHT = 720;
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);
  // Home Edition serves /client; static project sites serve /repo/client/index.html.
  // Explicit mode always wins (the embedded Redmi controller uses mode=control).
  const inferredClient = path === '/client' || /\/client\/?$/.test(path) || /\/client\/index\.html$/.test(path);
  const mode = params.get('mode') || (inferredClient ? 'client' : 'control');
  const isClient = mode === 'client';
  document.body.classList.add(isClient ? 'mode-client' : 'mode-control');

  const screen = document.getElementById('virtualScreen');
  const frame = document.getElementById('screenFrame');
  const windowLayer = document.getElementById('workspaceWindowLayer');
  const cursor = document.getElementById('remoteCursor');
  const linkText = document.getElementById('workspaceLinkText');
  const sourceText = document.getElementById('inputSourceValue');
  const bottomStatus = document.getElementById('bottomStatusText');
  const timeLabel = document.getElementById('workspaceTime');
  const controlHint = document.getElementById('workspaceControlHint');
  const focusManager = document.getElementById('focusManager');
  const focusLocalButton = document.getElementById('focusLocalButton');
  const focusSamsungButton = document.getElementById('focusSamsungButton');
  const focusStateText = document.getElementById('focusStateText');
  const openWindows = new Map();
  let zCounter = 10;
  let openCounter = 0;
  let dragging = null;
  let pollSeq = 0;
  let pollInFlight = false;
  let pendingEvents = [];
  let lastMoveSent = 0;
  let lastTouchTap = { app: '', time: 0 };
  let relayOnline = false;
  let focusTarget = 'local';
  let focusRevision = 0;
  let focusRequestInFlight = false;

  function fitScreen() {
    if (!frame.clientWidth || !frame.clientHeight) return;
    const scale = Math.min(frame.clientWidth / WIDTH, frame.clientHeight / HEIGHT);
    screen.style.setProperty('--screen-scale', String(Math.max(0.12, scale)));
  }
  window.addEventListener('resize', fitScreen, { passive: true });
  fitScreen();
  if (window.ResizeObserver) new ResizeObserver(fitScreen).observe(frame);

  function updateClock() {
    const now = new Date();
    timeLabel.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  updateClock();
  setInterval(updateClock, 10000);

  function logicalFromClient(clientX, clientY, clamp = false) {
    const rect = screen.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0, inside: false };
    let x = (clientX - rect.left) * WIDTH / rect.width;
    let y = (clientY - rect.top) * HEIGHT / rect.height;
    if (clamp) {
      x = Math.max(0, Math.min(WIDTH, x));
      y = Math.max(0, Math.min(HEIGHT, y));
    }
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, inside: clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom };
  }

  // ---- relay plumbing -------------------------------------------------------
  const { api, instance, boot } = window.KealRelay;
  const dbg = window.__kealDebug = {
    role: isClient ? 'client' : 'controller', captured: 0, queued: 0, sent: 0, dropped: 0, applied: 0, polls: 0,
    hbOk: 0, hbFail: 0, rtt: null, lastPointer: null, lastEvent: null, lastRelayError: null, lastStatus: null,
    staleBuild: false, tokenBad: false, ready: false,
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const debugPanel = document.getElementById('debugPanel');
  let eventCounter = 0;
  let controllerOnline = false;
  let clientOnline = false;
  let flushing = false;

  function queueEvent(event) {
    dbg.captured++;
    if (isClient || focusTarget !== 'samsung' || !relayOnline) { dbg.dropped++; return; }
    event.n = ++eventCounter;
    const last = pendingEvents[pendingEvents.length - 1];
    if (last && last.type === 'pointermove' && event.type === 'pointermove') pendingEvents[pendingEvents.length - 1] = event;
    else pendingEvents.push(event);
    dbg.queued++;
    if (pendingEvents.length > 600) pendingEvents = pendingEvents.slice(-400);
  }

  function relayPointerEvent(event) {
    if (isClient) return;
    // Focus controls are local controls, never forwarded to the Samsung workspace.
    if (event.target && event.target.closest && event.target.closest('#focusManager')) return;
    if (focusTarget !== 'samsung' || !relayOnline) return;
    // Only ignore secondary touches on real pointer events; Chrome's click is a PointerEvent with isPrimary=false.
    if (event.type.startsWith('pointer') && event.isPrimary === false) return;
    const pt = logicalFromClient(event.clientX, event.clientY);
    if (!pt.inside) return;
    // Remote focus is exclusive inside the virtual screen (the Focus Manager is excluded above).
    if (event.type !== 'pointermove' && event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    dbg.lastPointer = { x: pt.x, y: pt.y, type: event.type, at: Date.now() };
    if (event.type === 'pointerdown') { try { window.focus(); screen.focus({ preventScroll: true }); } catch (_) {} }
    const mods = { ctrlKey: !!event.ctrlKey, shiftKey: !!event.shiftKey, altKey: !!event.altKey, metaKey: !!event.metaKey };
    if (event.type === 'pointermove') {
      // No capture-side throttle: queueEvent coalesces moves and the 20ms flush limits the rate, so the final position is never lost.
      queueEvent({ type: 'pointermove', x: pt.x, y: pt.y, button: 0, ...mods });
    } else if (event.type === 'wheel') {
      queueEvent({ type: 'wheel', x: pt.x, y: pt.y, deltaY: Math.max(-1600, Math.min(1600, event.deltaY || 0)) });
    } else {
      const type = event.type === 'pointerdown' ? 'mousedown' : (event.type === 'pointerup' ? 'mouseup' : event.type);
      queueEvent({ type, x: pt.x, y: pt.y, button: Math.max(0, Math.min(4, event.button || 0)), ...mods });
    }
  }

  function relayKey(event) {
    if (event.target && event.target.closest && event.target.closest('#focusManager')) return;
    if (focusTarget !== 'samsung' || !relayOnline) return;
    const key = String(event.key || '');
    // Escape hatch that is never forwarded: Ctrl+Alt+L returns input to the Redmi.
    if (event.type === 'keydown' && event.ctrlKey && event.altKey && key.toLowerCase() === 'l') {
      event.preventDefault(); event.stopImmediatePropagation(); setInputFocus('local'); return;
    }
    if (event.isComposing || !key || ['Process', 'Unidentified', 'Dead'].includes(key)) return;
    if ((event.ctrlKey || event.metaKey) && ['r', 'w', 'l', 't', 'n'].includes(key.toLowerCase()) || key === 'F5') {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    queueEvent({ type: event.type, key: key.slice(0, 32), code: String(event.code || '').slice(0, 32), repeat: !!event.repeat,
      ctrlKey: !!event.ctrlKey, shiftKey: !!event.shiftKey, altKey: !!event.altKey, metaKey: !!event.metaKey });
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  async function flushEvents() {
    if (flushing || !pendingEvents.length) return;
    flushing = true;
    const batch = pendingEvents.splice(0, 100);
    const revision = focusRevision;
    const queuedAt = Date.now();
    try {
      const res = await api('/api/events', { method: 'POST', body: { events: batch, focus_revision: revision }, timeout: 4000 });
      if (res.ok) {
        dbg.sent += res.data.accepted || 0;
        dbg.lastRelayError = res.data.invalid ? 'invalid events dropped: ' + res.data.invalid : null;
      } else if (res.status === 0) {
        dbg.lastRelayError = 'network: ' + (res.error || 'failed');
        // Retrying is safe (the server drops duplicate sequence numbers) but only inside the same focus epoch and briefly.
        if (focusTarget === 'samsung' && focusRevision === revision && Date.now() - queuedAt < 1500) pendingEvents = batch.concat(pendingEvents);
      } else {
        dbg.lastRelayError = (res.data && (res.data.reason || res.data.error)) || ('http ' + res.status);
        if (res.data && res.data.input_target) applyStatus(res.data);
        handleApiFailure(res);
        pendingEvents = [];
      }
    } finally {
      flushing = false;
    }
  }

  if (!isClient) {
    const opts = { passive: false, capture: true };
    ['pointermove', 'pointerdown', 'pointerup', 'click', 'dblclick', 'wheel'].forEach(name => document.addEventListener(name, relayPointerEvent, opts));
    document.addEventListener('keydown', relayKey, true);
    document.addEventListener('keyup', relayKey, true);
    setInterval(flushEvents, 20);
  }

  function handleApiFailure(res) {
    if (res.status === 401) { dbg.tokenBad = true; relayOnline = false; focusTarget = 'local'; pendingEvents = []; }
    if (res.status === 0) { relayOnline = false; pendingEvents = []; if (isClient) focusTarget = 'local'; }
    renderFocusState();
  }

  function applyStatus(d) {
    if (!d || typeof d !== 'object' || d.input_target === undefined) return;
    dbg.lastStatus = d;
    dbg.tokenBad = false;
    window.dispatchEvent(new CustomEvent('keal-status', { detail: d }));
    if (d.boot_id && boot && d.boot_id !== boot) dbg.staleBuild = true;
    controllerOnline = !!d.controller_online;
    clientOnline = !!d.client_online;
    relayOnline = isClient ? controllerOnline : clientOnline;
    const revision = Number(d.focus_revision) || 0;
    if (revision !== focusRevision) pendingEvents = [];
    focusRevision = revision;
    focusTarget = d.input_target === 'samsung' ? 'samsung' : 'local';
    if (isClient) {
      linkText.textContent = dbg.staleBuild ? 'SERVER RESTARTED · RELOADING' : (controllerOnline ? 'MASTER ONLINE' : 'WAITING FOR MASTER');
      sourceText.textContent = focusTarget === 'samsung' ? 'Remote input active' : 'Input target: Redmi';
      bottomStatus.textContent = !controllerOnline ? 'MASTER CONTROLLER NOT RUNNING' : (focusTarget === 'samsung' ? 'READY · RECEIVING REMOTE INPUT' : 'INPUT FOCUS IS ON REDMI');
    } else {
      linkText.textContent = clientOnline ? 'CLIENT CONNECTED' : 'WAITING FOR CLIENT';
      sourceText.textContent = clientOnline ? (focusTarget === 'samsung' ? 'Samsung · active target' : 'Samsung · standby') : 'Waiting for Samsung';
    }
    renderFocusState();
  }

  const applySettings = settings => { if (settings && window.Keal) Keal.applyWallpaper(screen, settings.wallpaper_client); };
  window.addEventListener('keal-status', event => applySettings(event.detail && event.detail.settings));
  window.addEventListener('keal-settings', event => applySettings(event.detail));

  async function heartbeat() {
    const res = await api('/api/heartbeat', { method: 'POST', body: { role: isClient ? 'client' : 'controller', instance, visible: document.visibilityState === 'visible' } });
    if (res.ok) { dbg.hbOk++; applyStatus(res.data); } else { dbg.hbFail++; handleApiFailure(res); }
  }

  async function refreshStatus() {
    const res = await api('/api/status');
    if (res.ok) { dbg.rtt = res.ms; applyStatus(res.data); }
    else {
      handleApiFailure(res);
      const signedOut = KealRelay.isWeb && res.status === 401 && res.data && res.data.error === 'sign_in_required';
      linkText.textContent = signedOut ? 'SIGN IN REQUIRED' : (res.status === 401 ? 'RE-PAIR · TOKEN REJECTED' : 'RELAY UNAVAILABLE');
      if (isClient) bottomStatus.textContent = signedOut ? 'OPEN KEAL ACCOUNT AND SIGN IN' : (res.status === 401 ? 'OPEN THE NEW /client?t=… LINK' : 'CHECK LOCAL NETWORK');
    }
    if (dbg.staleBuild && isClient && !sessionStorage.getItem('keal.reloaded')) {
      sessionStorage.setItem('keal.reloaded', '1');
      setTimeout(() => location.reload(), 1200);
    }
    renderDebug();
  }

  function renderDebug() {
    if (!debugPanel || debugPanel.hidden) return;
    const s = dbg.lastStatus || {};
    const age = v => (v === null || v === undefined ? '—' : v.toFixed(1) + 's');
    debugPanel.textContent = [
      'ROLE ' + dbg.role + ' · build ' + (window.KealRelay.version || '?') + ' · boot ' + (boot || '?') + (dbg.staleBuild ? ' (STALE)' : ''),
      'target ' + focusTarget + ' · revision ' + focusRevision + ' · reason ' + (s.focus_reason || '—'),
      'controller ' + (controllerOnline ? 'ONLINE' : 'offline') + ' (' + age(s.controller_age) + ') · client ' + (clientOnline ? 'ONLINE' : 'offline') + ' (' + age(s.client_age) + ')',
      'accepted ' + (s.accepted_events ?? '—') + ' · applied here ' + dbg.applied + ' · latest seq ' + (s.latest_seq ?? '—') + ' · polls ' + dbg.polls,
      'last pointer ' + (dbg.lastPointer ? dbg.lastPointer.x + ',' + dbg.lastPointer.y : '—') + ' · last event ' + (dbg.lastEvent || '—'),
      'rtt ' + (dbg.rtt ?? '—') + 'ms · hb ok/fail ' + dbg.hbOk + '/' + dbg.hbFail + ' · token ' + (dbg.tokenBad ? 'REJECTED' : 'ok'),
      'error ' + (dbg.lastRelayError || (s.last_error ? s.last_error.reason : 'none')),
    ].join('\n');
  }

  function renderFocusState() {
    const samsungActive = focusTarget === 'samsung';
    if (focusLocalButton) {
      focusLocalButton.classList.toggle('is-active', !samsungActive);
      focusLocalButton.setAttribute('aria-pressed', String(!samsungActive));
    }
    if (focusSamsungButton) {
      focusSamsungButton.classList.toggle('is-active', samsungActive);
      focusSamsungButton.setAttribute('aria-pressed', String(samsungActive));
      focusSamsungButton.disabled = !relayOnline && !samsungActive;
      focusSamsungButton.title = relayOnline ? 'Route Keal workspace input to Samsung' : 'Connect Samsung first';
    }
    if (focusStateText) {
      focusStateText.textContent = samsungActive ? (relayOnline ? 'REMOTE' : 'REMOTE · LINK LOST') : 'LOCAL';
      focusStateText.classList.toggle('remote', samsungActive);
      focusStateText.classList.toggle('offline', samsungActive && !relayOnline);
    }
    if (focusManager) focusManager.dataset.target = focusTarget;
    if (controlHint) controlHint.textContent = isClient ? 'VIRTUAL SCREEN 1280 × 720' : ('VIRTUAL SCREEN 1280 × 720 · INPUT TARGET: ' + (samsungActive ? 'SAMSUNG' : 'REDMI'));
    // The remote cursor shows only when the server says remote input is really active.
    if (cursor) cursor.style.display = isClient && samsungActive && controllerOnline ? 'block' : 'none';
    renderDebug();
  }

  async function setInputFocus(target) {
    if (isClient || focusRequestInFlight || !['local', 'samsung'].includes(target)) return;
    focusRequestInFlight = true;
    try {
      const res = await api('/api/focus', { method: 'POST', body: { target } });
      if (res.data && res.data.input_target) applyStatus(res.data);
      if (!res.ok) {
        dbg.lastRelayError = (res.data && res.data.error) || 'focus change failed';
        if (focusStateText) focusStateText.textContent = target === 'samsung' ? 'LINK REQUIRED' : 'RETRY FOCUS';
      } else {
        pendingEvents = [];
        if (screen && typeof screen.focus === 'function') screen.focus({ preventScroll: true });
      }
    } finally {
      focusRequestInFlight = false;
    }
  }
  window.__kealSetFocus = setInputFocus;
  window.__kealApplyStatus = applyStatus;   // lets the master page push a fresh status immediately after a focus change

  if (!isClient && focusLocalButton && focusSamsungButton) {
    focusLocalButton.addEventListener('click', () => setInputFocus('local'));
    focusSamsungButton.addEventListener('click', () => setInputFocus('samsung'));
  }
  const modeBadge = document.getElementById('clientModeBadge');
  if (debugPanel && (params.has('debug') || isClient)) {
    debugPanel.hidden = !params.has('debug');
    if (modeBadge) modeBadge.addEventListener('click', () => { debugPanel.hidden = !debugPanel.hidden; renderDebug(); });
  }

  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  const appInfo = {
    terminal: { title: 'Keal Terminal', mark: '>_', width: 690, height: 410, x: 282, y: 124 },
    editor: { title: 'Code Lab', mark: '{ }', width: 660, height: 430, x: 335, y: 112 },
    files: { title: 'File Explorer', mark: '▱', width: 575, height: 355, x: 370, y: 170 },
    notes: { title: 'Quick Notes', mark: '▤', width: 565, height: 360, x: 405, y: 150 },
    settings: { title: 'Workspace Settings', mark: '⚙', width: 550, height: 345, x: 390, y: 170 },
    store: { title: 'App Store', mark: '⊞', width: 640, height: 400, x: 320, y: 130 },
    account: { title: 'KEAL Account', mark: '◎', width: 520, height: 420, x: 360, y: 145 },
    chat: { title: 'Friends Chat', mark: '✉', width: 620, height: 500, x: 315, y: 105 },
  };

  function addTerminalLine(text, type = '') {
    const output = document.getElementById('terminalOutput');
    if (!output) return;
    const line = document.createElement('div');
    if (type) line.className = type;
    line.textContent = text;
    output.appendChild(line);
    output.scrollTop = output.scrollHeight;
  }

  function executeTerminalCommand() {
    const input = document.getElementById('terminalInput');
    if (!input) return;
    const command = input.value.trim();
    if (!command) return;
    addTerminalLine('keal@workspace:~$ ' + command, 'term-accent');
    input.value = '';
    const [head, ...rest] = command.split(/\s+/);
    const tail = rest.join(' ');
    const cmd = head.toLowerCase();
    if (cmd === 'clear') {
      const output = document.getElementById('terminalOutput');
      if (output) output.replaceChildren();
      return;
    }
    if (cmd === 'help') {
      addTerminalLine('Available demo commands: help, clear, whoami, pwd, ls, date, system, echo <text>', 'term-ok');
      addTerminalLine('This is a sandboxed demo console. It does not execute Android or shell commands.');
    } else if (cmd === 'whoami') {
      addTerminalLine('student@keal-workspace', 'term-ok');
    } else if (cmd === 'pwd') {
      addTerminalLine('/keal/workspace', 'term-ok');
    } else if (cmd === 'ls') {
      addTerminalLine('Desktop/   Documents/   Projects/   Notes/   README.txt', 'term-ok');
    } else if (cmd === 'date') {
      addTerminalLine(new Date().toString(), 'term-ok');
    } else if (cmd === 'system') {
      addTerminalLine('Keal Virtual Workspace v3 · browser sandbox · input relay status: ' + (relayOnline ? 'client detected' : 'waiting for client'), 'term-ok');
    } else if (cmd === 'echo') {
      addTerminalLine(tail);
    } else {
      addTerminalLine('Command not found in safe demo shell. Type "help" for available commands.', 'term-warn');
    }
  }

  function appMarkup(app) {
    if (appInfo[app] && appInfo[app].ext) return Keal.appFrameHtml(appInfo[app].ext);
    if (app === 'store') return `<div class="kd-mount kd-mount-store"></div>`;
    if (app === 'account') return `<div class="kd-mount ki-account-mount"></div>`;
    if (app === 'chat') return `<div class="kd-mount ki-chat-mount"></div>`;
    if (app === 'terminal') {
      return `<div class="keal-terminal-app">
        <nav class="runtime-tabs" aria-label="Terminal runtimes">
          <button type="button" data-runtime-tab="shell" class="is-active" aria-pressed="true">SAFE SHELL</button>
          <button type="button" data-runtime-tab="python" aria-pressed="false">PYTHON</button>
          <button type="button" data-runtime-tab="javascript" aria-pressed="false">JAVASCRIPT</button>
        </nav>
        <section class="runtime-panel runtime-shell" data-runtime-pane="shell">
          <div id="terminalOutput" class="terminal-output"><div class="term-accent">KEAL TERMINAL / SAFE VIRTUAL SHELL</div><div>Session ready. This console does not run Android or operating-system commands.</div><div>Type <span class="term-ok">help</span> to see available virtual commands.</div></div>
          <div class="terminal-form"><span class="terminal-prompt">keal@workspace:~$</span><input id="terminalInput" class="terminal-input" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Virtual shell command"><button id="terminalRun" class="terminal-run" type="button">RUN ↵</button></div>
        </section>
        <section class="runtime-panel runtime-code-panel" data-runtime-pane="python" hidden>
          <div class="runtime-toolbar"><span id="pythonStatus" data-state="idle">PYTHON NOT LOADED</span><span class="runtime-toolbar-actions"><button type="button" id="pythonLoad">LOAD RUNTIME</button><button type="button" id="pythonClear">CLEAR</button><button type="button" id="pythonRun" class="runtime-primary">RUN PYTHON ▶</button></span></div>
          <textarea id="pythonCode" class="runtime-editor" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Python code">print("Hello from KEAL OS")

values = [4, 8, 15, 16, 23, 42]
print("Sum:", sum(values))
print("Python is running in the browser!")</textarea>
          <div class="runtime-output-label">PYTHON OUTPUT</div><div id="pythonOutput" class="runtime-output" aria-live="polite"><div class="runtime-muted">The first run downloads the Pyodide WebAssembly runtime from its official CDN. Internet is required for the initial load.</div></div>
          <div class="runtime-footnote">Browser Python · Web Worker · no Android shell or device filesystem</div>
        </section>
        <section class="runtime-panel runtime-code-panel" data-runtime-pane="javascript" hidden>
          <div class="runtime-toolbar"><span id="javascriptStatus" data-state="idle">JAVASCRIPT READY</span><span class="runtime-toolbar-actions"><button type="button" id="javascriptClear">CLEAR</button><button type="button" id="javascriptRun" class="runtime-primary">RUN JS ▶</button></span></div>
          <textarea id="javascriptCode" class="runtime-editor" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="JavaScript code">console.log("Hello from KEAL JavaScript");
const values = [4, 8, 15, 16, 23, 42];
console.log("Sum:", values.reduce((a, b) => a + b, 0));</textarea>
          <div class="runtime-output-label">JAVASCRIPT OUTPUT</div><div id="javascriptOutput" class="runtime-output" aria-live="polite"><div class="runtime-muted">JavaScript runs in a dedicated Worker without access to the page DOM.</div></div>
          <div class="runtime-footnote">Worker sandbox · no Android shell · network APIs are not disabled</div>
        </section>
      </div>`;
    }
    if (app === 'editor') {
      return `<div class="kd-mount kd-mount-editor"></div>`;
    }
    if (app === 'files') {
      return `<div class="kd-mount kd-mount-files"></div>`;
    }
    if (app === 'notes') {
      return `<div class="kd-mount kd-mount-notes"></div>`;
    }
    return `<div class="kd-mount kd-mount-settings"></div>`;
  }

  function openApp(app) {
    if (!appInfo[app]) return;
    if (openWindows.has(app)) {
      const existing = openWindows.get(app);
      existing.style.display = 'flex';
      bringToFront(existing);
      return;
    }
    const info = appInfo[app];
    const win = document.createElement('section');
    win.className = 'workspace-app-window' + (app === 'terminal' ? ' terminal-window' : '');
    win.dataset.app = app;
    const offset = (openCounter++ % 5) * 23;
    const width = Math.min(info.width, WIDTH - 30);
    const height = Math.min(info.height, HEIGHT - 85);
    win.style.left = Math.min(info.x + offset, WIDTH - width - 12) + 'px';
    win.style.top = Math.min(info.y + offset, HEIGHT - height - 56) + 'px';
    win.style.width = width + 'px';
    win.style.height = height + 'px';
    win.style.zIndex = String(++zCounter);
    win.innerHTML = `<header class="workspace-app-titlebar"><span class="workspace-app-mark">${esc(info.mark)}</span><span class="workspace-app-title">${esc(info.title)}</span><div class="workspace-app-actions"><button type="button" data-minimize title="Minimize">−</button><button type="button" data-close title="Close">×</button></div></header><div class="workspace-app-content">${appMarkup(app)}</div>`;
    windowLayer.appendChild(win);
    openWindows.set(app, win);
    bringToFront(win);
    setupAppWindow(win, app);
  }

  function bringToFront(win) {
    if (!win) return;
    win.style.zIndex = String(++zCounter);
    document.querySelectorAll('.workspace-app-window').forEach(item => item.classList.toggle('active', item === win));
  }

  function setupAppWindow(win, app) {
    win.querySelector('[data-close]').addEventListener('click', () => {
      openWindows.delete(app);
      if (typeof win._kealRuntimeCleanup === 'function') win._kealRuntimeCleanup();
      win.remove();
    });
    win.querySelector('[data-minimize]').addEventListener('click', () => { win.style.display = 'none'; });
    win.addEventListener('mousedown', () => bringToFront(win));
    const input = win.querySelector('#terminalInput');
    const run = win.querySelector('#terminalRun');
    if (input) {
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); executeTerminalCommand(); }
      });
      run.addEventListener('click', executeTerminalCommand);
      if (window.KealRuntime) KealRuntime.mount(win);
    }
    const accountMount = win.querySelector('.ki-account-mount');
    if (accountMount && window.KealIdentity) KealIdentity.mountAccount(accountMount);
    const chatMount = win.querySelector('.ki-chat-mount');
    if (chatMount && window.KealIdentity) KealIdentity.mountChat(chatMount);
    const editorMount = win.querySelector('.kd-mount-editor');
    if (editorMount) win._editor = Keal.mountEditor(editorMount, { path: pendingEditorPath || 'code/main.py', kind: 'codeEditor' });
    const notesMount = win.querySelector('.kd-mount-notes');
    if (notesMount) win._editor = Keal.mountEditor(notesMount, { path: pendingEditorPath || 'notes/quick-notes.md', kind: 'workspaceNotes' });
    const storeMount = win.querySelector('.kd-mount-store');
    if (storeMount) Keal.mountStore(storeMount, { devices: [{ key: 'client', label: 'SAMSUNG' }], host: 'client', onOpen: id => openApp('x-' + id) });
    const extFrame = win.querySelector('.ext-app');
    if (extFrame && appInfo[app] && appInfo[app].ext) { win.classList.add('has-ext-app'); Keal.attachAppHost(extFrame, appInfo[app].ext, 'client'); }
    const filesMount = win.querySelector('.kd-mount-files');
    if (filesMount) Keal.mountFiles(filesMount, { onOpen: openInEditor });
    const settingsMount = win.querySelector('.kd-mount-settings');
    if (settingsMount) Keal.mountSettings(settingsMount, { devices: [{ key: 'wallpaper_client', label: 'WALLPAPER' }] });
    pendingEditorPath = null;
  }

  function syncExternalApps() {
    const wanted = new Map(Keal.installedFor('client').map(a => ['x-' + a.id, a]));
    Object.keys(appInfo).filter(k => k.startsWith('x-') && !wanted.has(k)).forEach(k => {
      const win = openWindows.get(k);
      if (win) { win.remove(); openWindows.delete(k); }
      delete appInfo[k];
    });
    wanted.forEach((manifest, key) => { appInfo[key] = { title: manifest.name, mark: manifest.icon, width: Math.min(manifest.width, WIDTH - 40), height: Math.min(manifest.height, HEIGHT - 90), x: 300, y: 110, ext: manifest }; });
    const grid = document.querySelector('.workspace-icon-grid');
    grid.querySelectorAll('.ext-icon').forEach(node => node.remove());
    wanted.forEach((manifest, key) => {
      const button = document.createElement('button');
      button.className = 'workspace-app-icon ext-icon';
      button.dataset.ext = key;
      button.setAttribute('aria-label', manifest.name + ', double click to open');
      button.innerHTML = '<span class="wi-box">' + Keal.esc(manifest.icon) + '</span><span>' + Keal.esc(manifest.name) + '</span>';
      grid.appendChild(button);
    });
  }
  window.addEventListener('keal-apps', syncExternalApps);
  (() => {
    let lastTap = { key: '', time: 0 };
    const grid = document.querySelector('.workspace-icon-grid');
    grid.addEventListener('dblclick', event => { const b = event.target.closest('.ext-icon'); if (b) { event.preventDefault(); openApp(b.dataset.ext); } });
    grid.addEventListener('pointerup', event => {
      const b = event.target.closest('.ext-icon');
      if (!b || event.pointerType !== 'touch') return;
      const now = Date.now();
      if (lastTap.key === b.dataset.ext && now - lastTap.time < 430) openApp(b.dataset.ext);
      lastTap = { key: b.dataset.ext, time: now };
    });
  })();

  let pendingEditorPath = null;
  // Prose files open in Notes, everything else in Code Lab.
  function openInEditor(path) {
    const app = /\.(md|txt)$/i.test(path) ? 'notes' : 'editor';
    const existing = openWindows.get(app);
    if (existing && existing._editor) { existing._editor.open(path); existing.style.display = 'flex'; bringToFront(existing); return; }
    pendingEditorPath = path;
    openApp(app);
  }

  document.querySelectorAll('[data-open]').forEach(button => {
    button.addEventListener('click', () => {
      const app = button.dataset.open;
      if (button.closest('.workspace-dock')) openApp(app);
      else button.classList.add('was-selected');
    });
    button.addEventListener('dblclick', event => {
      event.preventDefault();
      openApp(button.dataset.open);
    });
    button.addEventListener('pointerup', event => {
      if (event.pointerType !== 'touch') return;
      const app = button.dataset.open;
      const now = Date.now();
      if (lastTouchTap.app === app && now - lastTouchTap.time < 430) openApp(app);
      lastTouchTap = { app, time: now };
    });
  });
  document.querySelectorAll('[data-home]').forEach(button => button.addEventListener('click', () => {
    openWindows.forEach(win => win.style.display = 'none');
  }));

  function setupAppWindowDragging() {
    document.addEventListener('mousedown', event => {
      const titlebar = event.target.closest('.workspace-app-titlebar');
      if (!titlebar || event.target.closest('.workspace-app-actions')) return;
      const win = titlebar.closest('.workspace-app-window');
      if (!win) return;
      bringToFront(win);
      const pt = logicalFromClient(event.clientX, event.clientY);
      dragging = { win, startX: pt.x, startY: pt.y, left: parseFloat(win.style.left) || 0, top: parseFloat(win.style.top) || 0 };
      event.preventDefault();
    }, true);
    document.addEventListener('mousemove', event => {
      if (!dragging) return;
      const pt = logicalFromClient(event.clientX, event.clientY);
      const w = dragging.win.getBoundingClientRect().width * WIDTH / screen.getBoundingClientRect().width;
      const h = dragging.win.getBoundingClientRect().height * HEIGHT / screen.getBoundingClientRect().height;
      const left = dragging.left + pt.x - dragging.startX;
      const top = dragging.top + pt.y - dragging.startY;
      dragging.win.style.left = Math.max(0, Math.min(WIDTH - Math.min(w, WIDTH), left)) + 'px';
      dragging.win.style.top = Math.max(54, Math.min(HEIGHT - Math.min(h, HEIGHT) - 4, top)) + 'px';
    }, true);
    document.addEventListener('mouseup', () => { dragging = null; }, true);
  }
  setupAppWindowDragging();

  function moveRemoteCursor(event) {
    if (!('x' in event)) return;
    const x = Math.max(0, Math.min(WIDTH, Number(event.x) || 0));
    const y = Math.max(0, Math.min(HEIGHT, Number(event.y) || 0));
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
    dbg.lastPointer = { x, y, type: event.type, at: Date.now() };
  }

  function scrollableAncestor(el) {
    for (; el && el !== document.body; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    }
    return null;
  }

  function sendPointerToClient(event) {
    if (!isClient) return;
    dbg.applied++;
    dbg.lastEvent = event.type + ' #' + event.seq;
    moveRemoteCursor(event);
    if (event.type === 'pointermove') {
      const x = Math.max(0, Math.min(WIDTH, Number(event.x) || 0));
      const y = Math.max(0, Math.min(HEIGHT, Number(event.y) || 0));
      cursor.style.left = x + 'px';
      cursor.style.top = y + 'px';
      const rect = screen.getBoundingClientRect();
      const clientX = rect.left + x * rect.width / WIDTH;
      const clientY = rect.top + y * rect.height / HEIGHT;
      const target = document.elementFromPoint(clientX, clientY);
      if (target && !target.closest('#remoteCursor')) {
        target.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, view: window, clientX, clientY, buttons: 0 }));
      }
      return;
    }
    if (event.type === 'wheel') {
      const rect = screen.getBoundingClientRect();
      const clientX = rect.left + (Number(event.x) || 0) * rect.width / WIDTH;
      const clientY = rect.top + (Number(event.y) || 0) * rect.height / HEIGHT;
      const target = document.elementFromPoint(clientX, clientY);
      if (target) {
        const box = scrollableAncestor(target);
        if (box) box.scrollTop += Number(event.deltaY) || 0;
        target.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX, clientY, deltaY: Number(event.deltaY) || 0 }));
      }
      return;
    }
    if (['mousedown', 'mouseup', 'click', 'dblclick'].includes(event.type)) {
      const rect = screen.getBoundingClientRect();
      const x = Number(event.x) || 0, y = Number(event.y) || 0;
      const clientX = rect.left + x * rect.width / WIDTH;
      const clientY = rect.top + y * rect.height / HEIGHT;
      const target = document.elementFromPoint(clientX, clientY);
      if (!target || target.closest('#remoteCursor')) return;
      if (event.type === 'mousedown') {
        const focusable = target.closest('input,textarea,button,[contenteditable="true"]');
        if (focusable && typeof focusable.focus === 'function') focusable.focus({ preventScroll: true });
      }
      target.dispatchEvent(new MouseEvent(event.type, {
        bubbles: true, cancelable: true, view: window, clientX, clientY,
        button: Number(event.button) || 0, ctrlKey: !!event.ctrlKey, shiftKey: !!event.shiftKey,
        altKey: !!event.altKey, metaKey: !!event.metaKey
      }));
      return;
    }
    if (event.type === 'keydown') applyRemoteKey(event);
  }

  function replaceSelection(el, text) {
    const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
    const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
    if (typeof el.setRangeText === 'function') {
      el.setRangeText(text, start, end, 'end');
    } else {
      el.value = el.value.slice(0, start) + text + el.value.slice(end);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function applyRemoteKey(event) {
    let target = document.activeElement;
    if (!target || !target.matches('input,textarea,[contenteditable="true"]')) {
      // Useful fallback: a command typed after opening Terminal goes to its input.
      const terminal = document.getElementById('terminalInput');
      if (terminal && !event.ctrlKey && !event.altKey && !event.metaKey) {
        terminal.focus({ preventScroll: true });
        target = terminal;
      } else {
        return;
      }
    }
    if (event.ctrlKey || event.metaKey) {
      if (String(event.key).toLowerCase() === 'a' && typeof target.select === 'function') {
        target.select();
      }
      return;
    }
    const key = String(event.key || '');
    if (key === 'Enter') {
      if (target.id === 'terminalInput') executeTerminalCommand();
      else if (target.tagName === 'TEXTAREA') replaceSelection(target, '\n');
      else target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return;
    }
    if (key === 'Backspace' || key === 'Delete') {
      const start = typeof target.selectionStart === 'number' ? target.selectionStart : target.value.length;
      const end = typeof target.selectionEnd === 'number' ? target.selectionEnd : start;
      if (start !== end) {
        target.setRangeText('', start, end, 'end');
      } else if (key === 'Backspace' && start > 0) {
        target.setRangeText('', start - 1, start, 'end');
      } else if (key === 'Delete' && start < target.value.length) {
        target.setRangeText('', start, start + 1, 'end');
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End') {
      if (typeof target.selectionStart === 'number') {
        let pos = target.selectionStart;
        if (key === 'ArrowLeft') pos = Math.max(0, pos - 1);
        else if (key === 'ArrowRight') pos = Math.min(target.value.length, pos + 1);
        else if (key === 'Home') pos = 0;
        else pos = target.value.length;
        target.setSelectionRange(pos, pos);
      }
      return;
    }
    if ((key === 'ArrowUp' || key === 'ArrowDown') && target.tagName === 'TEXTAREA') {
      const text = target.value, pos = target.selectionStart;
      const lineStart = text.lastIndexOf('\n', pos - 1) + 1, col = pos - lineStart;
      let next = pos;
      if (key === 'ArrowUp' && lineStart > 0) {
        const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1;
        next = Math.min(prevStart + col, lineStart - 1);
      } else if (key === 'ArrowDown') {
        const lineEnd = text.indexOf('\n', pos);
        if (lineEnd !== -1) { const nextEnd = text.indexOf('\n', lineEnd + 1); next = Math.min(lineEnd + 1 + col, nextEnd === -1 ? text.length : nextEnd); }
      }
      target.setSelectionRange(next, next);
      return;
    }
    if (key === 'Tab') { replaceSelection(target, '  '); return; }
    if (key.length === 1 && !event.altKey) replaceSelection(target, key);
  }

  async function pollLoop() {
    const first = await api('/api/status');
    if (first.ok) { applyStatus(first.data); pollSeq = Number(first.data.latest_seq) || 0; }
    for (;;) {
      try {
        if (focusTarget !== 'samsung' || !relayOnline) { await sleep(300); continue; }
        // Long poll: the server holds the request until events exist (or ~20s), so latency stays low without request spam.
        const res = await api('/api/events?since=' + pollSeq + '&rev=' + focusRevision + '&wait=20', { timeout: 30000 });
        dbg.polls++;
        if (!res.ok) { handleApiFailure(res); await sleep(1500); continue; }
        applyStatus(res.data);
        if (res.data.reset) { pollSeq = Number(res.data.latest_seq) || pollSeq; await sleep(150); continue; }
        for (const event of res.data.events || []) {
          pollSeq = Math.max(pollSeq, Number(event.seq) || 0);
          sendPointerToClient(event);
        }
      } catch (_) {
        await sleep(1000);
      }
    }
  }

  setInterval(heartbeat, 2000);
  setInterval(refreshStatus, 500);
  document.addEventListener('visibilitychange', heartbeat);
  window.addEventListener('pageshow', heartbeat);
  if (cursor) cursor.style.display = 'none';
  heartbeat().then(refreshStatus);
  if (isClient) pollLoop();
  dbg.ready = true;
})();
