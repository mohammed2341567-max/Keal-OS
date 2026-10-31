// Shared relay client: pairing token, per-page instance id and a never-throwing fetch wrapper.
(() => {
  'use strict';
  const meta = name => (document.querySelector('meta[name="keal-' + name + '"]') || {}).content || '';
  const token = meta('token') || new URLSearchParams(location.search).get('t') || '';
  const isWeb = meta('mode') === 'web';
  const root = meta('root') || './';
  // Home edition: server-rooted ('/media/x'); Web edition: relative to the site base. A bare 'media/x' must NOT stay relative in Home
  // (inside a sandboxed app it would resolve under /apps/<id>/ and 404 - the 6.1.0 Music regression).
  const pageUrl = path => isWeb ? new URL(String(path).replace(/^\//,''), new URL(root, location.href)).href : (String(path).startsWith('/') ? String(path) : '/' + path);
  const instance = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  // Resolves to {ok, status, data, ms}. status 0 = network failure/timeout. Never rejects.
  async function api(path, { method = 'GET', body, timeout = 8000 } = {}) {
    if (isWeb) {
      try { await window.KealCloud.ready; return await window.KealCloud.api(path, { method, body, timeout }); }
      catch (err) { return { ok:false, status:0, data:null, ms:0, error:String(err && err.message || err) }; }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const started = performance.now();
    try {
      const res = await fetch(path, {
        method, cache: 'no-store', signal: ctrl.signal,
        headers: Object.assign({ 'X-Keal-Token': token }, body === undefined ? {} : { 'Content-Type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* non-JSON error page */ }
      return { ok: res.ok, status: res.status, data, ms: Math.round(performance.now() - started) };
    } catch (err) {
      return { ok: false, status: 0, data: null, ms: Math.round(performance.now() - started), error: String(err && err.name || err) };
    } finally {
      clearTimeout(timer);
    }
  }
  window.KealRelay = { token, instance, boot: meta('boot'), version: meta('version') || (window.KEAL_CONFIG && window.KEAL_CONFIG.appVersion) || '6.1.0', api, isWeb, root, pageUrl };
})();
