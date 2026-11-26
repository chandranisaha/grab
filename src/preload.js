const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'overlay:cancel', 'overlay:submit', 'overlay:selecting', 'overlay:ready',
  'answer:followup', 'answer:brief', 'answer:retry', 'answer:stop', 'answer:close', 'answer:pin', 'answer:opacity',
  'answer:idle', 'answer:active', 'answer:model', 'answer:grab', 'clipboard:write',
  'dashboard:open', 'settings:open', 'claude:login', 'open:console',
  'dash:reopen', 'dash:grab', 'dash:close', 'dash:minimize',
]);
const INVOKE = new Set([
  'overlay:elements', 'answer:save', 'settings:get', 'settings:save', 'settings:test-key',
  'dash:data', 'dash:entry', 'dash:delete', 'dash:favorite', 'dash:clear',
]);
const ON = new Set([
  'overlay:open', 'overlay:reset', 'overlay:clear-selection', 'overlay:objects',
  'answer:open', 'answer:start', 'answer:delta', 'answer:done', 'answer:error', 'answer:reset', 'answer:bounds',
  'dash:tab', 'dash:changed',
]);

contextBridge.exposeInMainWorld('grab', {
  send: (ch, data) => { if (SEND.has(ch)) ipcRenderer.send(ch, data); },
  invoke: (ch, data) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, data) : Promise.reject(new Error('blocked'))),
  on: (ch, fn) => { if (ON.has(ch)) ipcRenderer.on(ch, (_e, data) => fn(data)); },
});
