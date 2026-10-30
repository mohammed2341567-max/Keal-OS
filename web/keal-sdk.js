// KEAL app SDK: apps run in a sandboxed iframe (no token, no storage, no parent access).
// Everything privileged goes through this postMessage bridge, and the host checks the app's manifest permissions.
(() => {
  'use strict';
  let counter = 0;
  const pending = new Map();
  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || msg.keal !== 1 || !pending.has(msg.id)) return;
    const slot = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(msg.error)); else slot.resolve(msg.result);
  });
  window.Keal = {
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++counter;
        pending.set(id, { resolve, reject });
        window.parent.postMessage({ keal: 1, id, method, params: params || {} }, '*');
        setTimeout(() => { if (pending.delete(id)) reject(new Error('timeout')); }, 15000);
      });
    },
  };
})();
