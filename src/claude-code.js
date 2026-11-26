const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';

function versionKey(v) {
  return v.split(/[.-]/).map((n) => String(Number(n) || 0).padStart(6, '0')).join('.');
}

function bundledCandidates() {
  const roots = [];
  if (process.platform === 'win32') roots.push(path.join(process.env.LOCALAPPDATA || '', 'Claude-Data'));
  if (process.platform === 'darwin') roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Claude-Data'));
  const found = [];
  for (const root of roots) {
    let profiles = [];
    try { profiles = fs.readdirSync(root); } catch { continue; }
    for (const prof of profiles) {
      const base = path.join(root, prof, 'claude-code');
      let versions = [];
      try { versions = fs.readdirSync(base); } catch { continue; }
      for (const ver of versions) {
        let builds = [];
        try { builds = fs.readdirSync(path.join(base, ver)); } catch { continue; }
        for (const b of builds) {
          const p = path.join(base, ver, b, exe);
          if (fs.existsSync(p)) found.push({ p, key: versionKey(ver) });
        }
      }
    }
  }
  return found.sort((a, b) => (a.key < b.key ? 1 : -1)).map((f) => f.p);
}

function onPath() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, ['claude'], { encoding: 'utf8', windowsHide: true, env: cleanEnv() });
    return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && /\.exe$|\/claude$/i.test(s));
  } catch { return []; }
}

function findClaude(preferred) {
  const list = [
    preferred,
    ...onPath(),
    path.join(os.homedir(), '.local', 'bin', exe),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    ...bundledCandidates(),
  ].filter(Boolean);
  return list.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

function cleanEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^CLAUDE/i.test(k) || /^ANTHROPIC_/i.test(k)) delete env[k];
  }
  return env;
}

class ClaudeCodeSession {
  constructor({ bin, model, system, cwd }) {
    this.bin = bin;
    this.model = model;
    this.system = system;
    this.cwd = cwd;
    this.proc = null;
    this.handlers = null;
    this.buf = '';
    this.stderr = '';
  }

  start() {
    fs.mkdirSync(this.cwd, { recursive: true });
    this.proc = spawn(this.bin, [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--model', this.model, '--tools', '', '--strict-mcp-config', '--setting-sources', '',
      '--no-session-persistence', '--system-prompt', this.system,
    ], { cwd: this.cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => this.onData(d));
    this.proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    this.proc.stdin.on('error', () => {});
    const proc = this.proc;
    proc.on('error', (err) => this.fail(proc, err.message));
    proc.on('exit', (code) => this.fail(proc, this.stderr.trim() || `Claude Code stopped (exit ${code}).`));
  }

  alive() { return !!(this.proc && this.proc.exitCode === null && !this.proc.killed); }

  ask(content, handlers) {
    if (!this.alive()) this.start();
    this.handlers = handlers;
    this.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      const h = this.handlers;
      if (!h) continue;
      if (ev.type === 'stream_event' && ev.event?.type === 'content_block_delta' && ev.event.delta?.type === 'text_delta') {
        h.text(ev.event.delta.text);
      } else if (ev.type === 'result') {
        this.handlers = null;
        if (ev.is_error) h.error(String(ev.result || ev.subtype || 'Claude Code returned an error.'));
        else h.done();
      }
    }
  }

  fail(proc, message) {
    if (proc !== this.proc) return;
    const h = this.handlers;
    this.handlers = null;
    this.proc = null;
    if (h) h.error(message);
  }

  stop() {
    const h = this.handlers;
    this.handlers = null;
    const p = this.proc;
    this.proc = null;
    if (p && p.exitCode === null) { try { p.kill(); } catch { /* already gone */ } }
    if (h) h.aborted();
  }
}

function openLogin(bin) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '"Sign in to Claude"', 'cmd', '/k', `"${bin}" auth login`], { env: cleanEnv(), detached: true, stdio: 'ignore', windowsHide: false, windowsVerbatimArguments: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "'${bin}' auth login"`], { detached: true, stdio: 'ignore' }).unref();
  }
}

function authStatus(bin) {
  try {
    const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', windowsHide: true, env: cleanEnv(), timeout: 15000 });
    const s = JSON.parse(r.stdout || '{}');
    return { loggedIn: !!s.loggedIn, method: s.authMethod || 'none' };
  } catch { return { loggedIn: false, method: 'unknown' }; }
}

module.exports = { findClaude, ClaudeCodeSession, openLogin, authStatus };
