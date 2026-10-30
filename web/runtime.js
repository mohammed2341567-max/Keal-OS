/* KEAL Runtime Lab: browser-only Python (Pyodide) and JavaScript workers. */
(() => {
  'use strict';
  const PYTHON_TIMEOUT_MS = 45000;
  const JS_TIMEOUT_MS = 8000;
  const MAX_CODE = 30000;
  const esc = value => String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  function appendOutput(node, text, kind = 'normal') {
    if (!node) return;
    const line = document.createElement('div');
    line.className = 'runtime-line runtime-' + kind;
    line.textContent = String(text).slice(0, 12000);
    node.appendChild(line);
    while (node.childElementCount > 300) node.firstElementChild.remove();
    node.scrollTop = node.scrollHeight;
  }

  function makeJavaScriptWorker() {
    const source = `
      const fmt = value => {
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value); } catch (_) { return String(value); }
      };
      const send = (type, text) => postMessage({type, text: String(text).slice(0, 12000)});
      const output = {
        log: (...values) => send('stdout', values.map(fmt).join(' ')),
        info: (...values) => send('stdout', values.map(fmt).join(' ')),
        warn: (...values) => send('stderr', values.map(fmt).join(' ')),
        error: (...values) => send('stderr', values.map(fmt).join(' ')),
        clear: () => postMessage({type:'clear'})
      };
      onmessage = async event => {
        const {id, code} = event.data || {};
        try {
          if (typeof code !== 'string' || code.length > ${MAX_CODE}) throw new Error('Code must be text no longer than ${MAX_CODE} characters.');
          const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
          const execute = new AsyncFunction('console', code);
          const result = await execute(output);
          if (result !== undefined) send('result', fmt(result));
        } catch (error) { send('error', error && error.message || error); }
        finally { postMessage({type:'done', id}); }
      };
    `;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url, { name: 'keal-js-runner' });
    worker.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
    worker._kealBlobUrl = url;
    return worker;
  }

  function mount(root) {
    if (!root || root.dataset.runtimeMounted === 'true') return;
    root.dataset.runtimeMounted = 'true';
    const tabs = [...root.querySelectorAll('[data-runtime-tab]')];
    const panes = [...root.querySelectorAll('[data-runtime-pane]')];
    const switchTab = name => {
      tabs.forEach(button => {
        const active = button.dataset.runtimeTab === name;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
      });
      panes.forEach(pane => { pane.hidden = pane.dataset.runtimePane !== name; });
    };
    tabs.forEach(button => button.addEventListener('click', () => switchTab(button.dataset.runtimeTab)));
    switchTab('shell');

    const pyCode = root.querySelector('#pythonCode');
    const pyOutput = root.querySelector('#pythonOutput');
    const pyStatus = root.querySelector('#pythonStatus');
    const pyRun = root.querySelector('#pythonRun');
    const pyLoad = root.querySelector('#pythonLoad');
    const jsCode = root.querySelector('#javascriptCode');
    const jsOutput = root.querySelector('#javascriptOutput');
    const jsStatus = root.querySelector('#javascriptStatus');
    const jsRun = root.querySelector('#javascriptRun');
    const pyClear = root.querySelector('#pythonClear');
    const jsClear = root.querySelector('#javascriptClear');
    let pyWorker = null;
    let pyReady = false;
    let pyLoading = null;
    let pyRequest = 0;
    let pyActive = null;
    let jsWorker = null;
    let jsRequest = 0;
    let jsTimer = null;

    const pyStatusText = (text, state = '') => {
      if (pyStatus) { pyStatus.textContent = text; pyStatus.dataset.state = state; }
    };
    const jsStatusText = (text, state = '') => {
      if (jsStatus) { jsStatus.textContent = text; jsStatus.dataset.state = state; }
    };

    function stopPython(reason) {
      if (pyWorker) pyWorker.terminate();
      pyWorker = null; pyReady = false; pyLoading = null;
      if (pyActive) {
        clearTimeout(pyActive.timer);
        appendOutput(pyOutput, reason || 'Python worker stopped.', 'error');
        pyActive.resolve(false); pyActive = null;
      }
    }

    function startPython() {
      if (pyReady) return Promise.resolve(true);
      if (pyLoading) return pyLoading;
      pyStatusText('DOWNLOADING PYTHON RUNTIME…', 'loading');
      appendOutput(pyOutput, 'Loading Pyodide from the official CDN. The first launch needs internet and may take a little while; the browser can cache runtime files for later launches.', 'muted');
      pyLoading = new Promise(resolve => {
        let settled = false;
        try {
          const workerPath = window.KealRelay && window.KealRelay.pageUrl ? window.KealRelay.pageUrl('python-worker.js') : 'python-worker.js';
          pyWorker = new Worker(new URL(workerPath, document.baseURI), { type: 'module', name: 'keal-python-runtime' });
        } catch (error) {
          pyStatusText('WORKER UNAVAILABLE', 'error');
          appendOutput(pyOutput, error.message || error, 'error');
          pyLoading = null; resolve(false); return;
        }
        const initTimer = setTimeout(() => {
          if (!settled) {
            settled = true; stopPython('Python runtime initialization timed out. Check the network/CDN and try again.');
            pyStatusText('LOAD TIMEOUT', 'error'); resolve(false);
          }
        }, 120000);
        pyWorker.addEventListener('message', event => {
          const data = event.data || {};
          if (data.type === 'status') pyStatusText('LOADING PYODIDE ' + data.version, 'loading');
          if (data.type === 'ready') {
            pyReady = true; settled = true; clearTimeout(initTimer);
            pyStatusText('PYTHON ' + data.python + ' READY', 'ready');
            appendOutput(pyOutput, 'Python runtime ready · Pyodide ' + data.version + ' · Python ' + data.python, 'success');
            pyLoading = null; resolve(true);
          } else if (data.type === 'stdout') appendOutput(pyOutput, data.text, 'normal');
          else if (data.type === 'stderr') appendOutput(pyOutput, data.text, 'warn');
          else if (data.type === 'result') appendOutput(pyOutput, data.text, 'result');
          else if (data.type === 'fatal') {
            appendOutput(pyOutput, data.error, 'error');
            pyStatusText('RUNTIME ERROR', 'error');
            if (pyWorker) pyWorker.terminate();
            pyWorker = null; pyReady = false;
            if (!settled) { settled = true; clearTimeout(initTimer); pyLoading = null; resolve(false); }
          } else if (data.type === 'error') appendOutput(pyOutput, data.error, 'error');
          else if (data.type === 'done' && pyActive && data.id === pyActive.id) {
            clearTimeout(pyActive.timer); pyActive.resolve(true); pyActive = null;
            pyStatusText('PYTHON READY', 'ready');
            if (pyRun) pyRun.disabled = false;
          }
        });
        pyWorker.addEventListener('error', event => {
          appendOutput(pyOutput, event.message || 'Python worker error.', 'error');
          pyStatusText('WORKER ERROR', 'error');
          if (!settled) { settled = true; clearTimeout(initTimer); pyLoading = null; resolve(false); }
        });
        pyWorker.postMessage({ type: 'init' });
      });
      return pyLoading;
    }

    async function runPython() {
      const code = pyCode ? pyCode.value : '';
      if (!code.trim()) return;
      if (code.length > MAX_CODE) { appendOutput(pyOutput, 'Maximum code size is ' + MAX_CODE + ' characters.', 'error'); return; }
      pyRun.disabled = true;
      appendOutput(pyOutput, '>>> ' + code.split('\n')[0], 'prompt');
      const ready = await startPython();
      if (!ready || !pyWorker) { pyRun.disabled = false; return; }
      if (pyActive) { appendOutput(pyOutput, 'A Python task is already running.', 'warn'); pyRun.disabled = false; return; }
      const id = ++pyRequest;
      const complete = new Promise(resolve => {
        const timer = setTimeout(() => {
          if (pyActive && pyActive.id === id) {
            pyActive = null; stopPython('Execution stopped after 20 seconds to keep the workspace responsive.');
            pyStatusText('EXECUTION STOPPED', 'error');
            if (pyRun) pyRun.disabled = false;
          }
          resolve(false);
        }, PYTHON_TIMEOUT_MS);
        pyActive = { id, timer, resolve };
      });
      pyWorker.postMessage({ type: 'run', id, code });
      await complete;
    }

    function ensureJsWorker() {
      if (jsWorker) return jsWorker;
      jsWorker = makeJavaScriptWorker();
      jsWorker.addEventListener('message', event => {
        const data = event.data || {};
        if (data.type === 'clear') { if (jsOutput) jsOutput.replaceChildren(); return; }
        if (data.type === 'stdout') appendOutput(jsOutput, data.text, 'normal');
        if (data.type === 'stderr' || data.type === 'error') appendOutput(jsOutput, data.text, 'error');
        if (data.type === 'result') appendOutput(jsOutput, data.text, 'result');
        if (data.type === 'done' && data.id === jsRequest) {
          clearTimeout(jsTimer); jsTimer = null;
          if (jsRun) jsRun.disabled = false;
          jsStatusText('JAVASCRIPT READY', 'ready');
        }
      });
      jsWorker.addEventListener('error', event => {
        appendOutput(jsOutput, event.message || 'JavaScript worker error.', 'error');
        jsStatusText('WORKER ERROR', 'error');
      });
      return jsWorker;
    }

    function runJavaScript() {
      const code = jsCode ? jsCode.value : '';
      if (!code.trim()) return;
      if (code.length > MAX_CODE) { appendOutput(jsOutput, 'Maximum code size is ' + MAX_CODE + ' characters.', 'error'); return; }
      if (jsTimer) clearTimeout(jsTimer);
      if (jsWorker) { jsWorker.terminate(); jsWorker = null; }
      const worker = ensureJsWorker();
      jsRun.disabled = true; jsStatusText('RUNNING', 'loading');
      appendOutput(jsOutput, '▶ ' + code.split('\n')[0], 'prompt');
      const id = ++jsRequest;
      worker.postMessage({ id, code });
      jsTimer = setTimeout(() => {
        if (jsWorker) { jsWorker.terminate(); jsWorker = null; }
        jsTimer = null; jsRun.disabled = false;
        jsStatusText('STOPPED · TIME LIMIT', 'error');
        appendOutput(jsOutput, 'Execution stopped after 8 seconds.', 'error');
      }, JS_TIMEOUT_MS);
    }

    if (pyLoad) pyLoad.addEventListener('click', startPython);
    if (pyRun) pyRun.addEventListener('click', runPython);
    if (pyClear) pyClear.addEventListener('click', () => { if (pyOutput) pyOutput.replaceChildren(); });
    if (jsRun) jsRun.addEventListener('click', runJavaScript);
    if (jsClear) jsClear.addEventListener('click', () => { if (jsOutput) jsOutput.replaceChildren(); });
    if (pyCode) pyCode.addEventListener('keydown', event => {
      if (event.key === 'Tab') { event.preventDefault(); const start = pyCode.selectionStart, end = pyCode.selectionEnd; pyCode.setRangeText('    ', start, end, 'end'); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runPython(); }
    });
    if (jsCode) jsCode.addEventListener('keydown', event => {
      if (event.key === 'Tab') { event.preventDefault(); const start = jsCode.selectionStart, end = jsCode.selectionEnd; jsCode.setRangeText('  ', start, end, 'end'); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runJavaScript(); }
    });
    root._kealRuntimeCleanup = () => {
      stopPython('Python runtime closed.');
      if (jsWorker) { jsWorker.terminate(); URL.revokeObjectURL(jsWorker._kealBlobUrl); jsWorker = null; }
      if (jsTimer) clearTimeout(jsTimer);
    };
  }

  window.KealRuntime = { mount };
})();
