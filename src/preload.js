const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'overlay:cancel', 'overlay:submit', 'overlay:selecting', 'overlay:ready',
  'answer:followup', 'answer:retry', 'answer:stop', 'answer:close', 'answer:pin', 'answer:opacity',
  'answer:idle', 'answer:active', 'answer:focus', 'clipboard:write',
  'settings:open', 'settings:close', 'open:console',
]);
const INVOKE = new Set(['answer:save', 'settings:get', 'settings:save', 'settings:test-key']);
const ON = new Set([
  'overlay:open', 'overlay:reset', 'overlay:clear-selection',
  'answer:open', 'answer:start', 'answer:delta', 'answer:done', 'answer:error', 'answer:reset', 'answer:bounds',
]);

contextBridge.exposeInMainWorld('grab', {
  send: (ch, data) => { if (SEND.has(ch)) ipcRenderer.send(ch, data); },
  invoke: (ch, data) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, data) : Promise.reject(new Error('blocked'))),
  on: (ch, fn) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, data) => fn(data)); },
});
