/* KEAL Python runtime worker.
 * Python executes in a dedicated Web Worker through Pyodide/WebAssembly.
 * It has no direct access to the page DOM, Android shell, or device filesystem.
 */
const PYODIDE_VERSION = '314.0.7';
const PYODIDE_INDEX = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
let runtimePromise = null;
let runtime = null;

async function getRuntime() {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      self.postMessage({ type: 'status', status: 'loading', version: PYODIDE_VERSION });
      const moduleUrl = `${PYODIDE_INDEX}pyodide.mjs`;
      const { loadPyodide } = await import(moduleUrl);
      runtime = await loadPyodide({ indexURL: PYODIDE_INDEX });
      runtime.setStdout({ batched: text => self.postMessage({ type: 'stdout', text }) });
      runtime.setStderr({ batched: text => self.postMessage({ type: 'stderr', text }) });
      self.postMessage({ type: 'ready', version: PYODIDE_VERSION, python: runtime.runPython('import sys; sys.version.split()[0]') });
      return runtime;
    })().catch(error => {
      runtimePromise = null;
      self.postMessage({ type: 'fatal', error: String(error && error.message || error) });
      throw error;
    });
  }
  return runtimePromise;
}

self.addEventListener('message', async event => {
  const message = event.data || {};
  if (message.type === 'init') {
    try { await getRuntime(); } catch (_) { /* fatal message already emitted */ }
    return;
  }
  if (message.type !== 'run' || typeof message.code !== 'string') return;
  const id = message.id;
  if (message.code.length > 30000) {
    self.postMessage({ type: 'error', id, error: 'Code is too long (maximum 30,000 characters).' });
    self.postMessage({ type: 'done', id });
    return;
  }
  try {
    const py = await getRuntime();
    await py.loadPackagesFromImports(message.code);
    const result = await py.runPythonAsync(message.code);
    if (result !== undefined && result !== null) {
      let value;
      try { value = result.toString(); } finally { if (result && typeof result.destroy === 'function') result.destroy(); }
      if (value && value !== 'None') self.postMessage({ type: 'result', id, text: value.slice(0, 12000) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', id, error: String(error && error.message || error).slice(0, 8000) });
  } finally {
    self.postMessage({ type: 'done', id });
  }
});
