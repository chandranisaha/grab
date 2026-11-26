const { spawn } = require('child_process');
const path = require('path');
const { app, screen } = require('electron');

let proc = null;
let ready = null;
let seq = 0;
const pending = new Map();
let buf = '';

function scriptPath() {
  const p = path.join(__dirname, 'native', 'uia.ps1');
  return app.isPackaged ? p.replace('app.asar', 'app.asar.unpacked') : p;
}

function start() {
  if (process.platform !== 'win32' || proc) return;
  proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath()], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  ready = new Promise((resolve) => {
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.ready) { resolve(true); continue; }
        const p = pending.get(m.id);
        if (p) { pending.delete(m.id); clearTimeout(p.timer); p.resolve(m.error ? null : m.data); }
      }
    });
  });
  proc.stdin.on('error', () => {});
  proc.on('exit', () => {
    proc = null; ready = null; buf = '';
    for (const p of pending.values()) { clearTimeout(p.timer); p.resolve(null); }
    pending.clear();
  });
}

async function call(op, args, timeout = 2500) {
  if (!proc) start();
  if (!proc) return null;
  const ok = await Promise.race([ready, new Promise((r) => setTimeout(() => r(false), 4000))]);
  if (!ok || !proc) return null;
  return new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
    pending.set(id, { resolve, timer });
    proc.stdin.write(JSON.stringify({ id, op, ...args }) + '\n');
  });
}

function toDip(r) {
  const d = screen.screenToDipRect(null, { x: r.x, y: r.y, width: r.w, height: r.hgt });
  return { x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) };
}

async function windows() {
  const list = await call('windows', { pid: process.pid });
  if (!Array.isArray(list)) return [];
  return list.map((w) => ({ hwnd: w.h, title: w.t, cls: w.c, ...toDip(w) }));
}

async function elements(hwnd) {
  const list = await call('elements', { hwnd }, 4000);
  if (!Array.isArray(list)) return [];
  return list.map((e) => ({ kind: e.k, name: e.n, ...toDip(e) }));
}

function stop() { if (proc) { try { proc.kill(); } catch { /* gone */ } } }

module.exports = { start, windows, elements, stop };
