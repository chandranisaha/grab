const {
  app, BrowserWindow, globalShortcut, desktopCapturer, screen, ipcMain,
  Tray, Menu, nativeImage, safeStorage, clipboard, dialog, nativeTheme, Notification, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { findClaude, ClaudeCodeSession, openLogin, authStatus } = require('./claude-code');
const uia = require('./uia');
const history = require('./history');

const MODELS = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };
const DEFAULT_SHORTCUT = 'Control+Q';
const SYSTEM_PROMPT = [
  'You are Grab, a desktop assistant. The user circled a region of their screen; the image is that region.',
  'Answer the question about it directly and briefly. Lead with the answer, then the minimum explanation needed.',
  'Use Markdown. Put code in fenced blocks with a language tag. Write math in LaTeX with $...$ or $$...$$.',
  'If asked to copy or transcribe text, return only the exact text, preserving line breaks, in a fenced block when it is code.',
].join(' ');
const BRIEF_PROMPT = 'Summarize your previous answer in one or two short lines of plain text. No preamble, no lists, no headings.';
const BRIEF_LABEL = 'Summary in 1-2 lines';

if (!app.requestSingleInstanceLock()) app.quit();

const preload = path.join(__dirname, 'preload.js');
const configPath = () => path.join(app.getPath('userData'), 'config.json');
const nativeGlass = process.platform === 'darwin';
const panelColor = () => (nativeTheme.shouldUseDarkColors ? '#16131f' : '#f4f2fa');

let config = {};
let tray = null;
const overlays = new Map();
const answers = new Map();
let dashWin = null;
let overlayOpen = false;
const captures = new Map();
let warm = null;
let warmTimer = null;
let windowsSnapshot = Promise.resolve([]);
const elementCache = new Map();

// ---------- config ----------

function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
  config = { shortcut: DEFAULT_SHORTCUT, model: 'fast', openAtLogin: true, opacity: 1, backend: 'claude', history: true, objects: true, ...config };
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

function getApiKey() {
  if (config.apiKeyEnc && safeStorage.isEncryptionAvailable()) {
    try { return safeStorage.decryptString(Buffer.from(config.apiKeyEnc, 'base64')); } catch { /* fall through */ }
  }
  return process.env.ANTHROPIC_API_KEY || '';
}

function setApiKey(key) {
  if (!key) { delete config.apiKeyEnc; return; }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain is not available on this system.');
  config.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
}

const claudeBin = () => findClaude(config.claudePath);
const needsLogin = (msg) => /authenticat|log ?in|oauth|not logged|credential|401|unauthori/i.test(msg || '');

function applyLoginItem() {
  const opts = { openAtLogin: !!config.openAtLogin };
  if (!app.isPackaged) Object.assign(opts, { path: process.execPath, args: [path.resolve(__dirname, '..')] });
  app.setLoginItemSettings(opts);
}

// ---------- tray & shortcut ----------

function trayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const ring = Math.max(0, 1 - Math.abs(d - 11) / 2.2);
      const dot = Math.max(0, 1 - Math.max(0, d - 3.2));
      const a = Math.min(1, ring + dot);
      const i = (y * size + x) * 4;
      buf[i] = 247; buf[i + 1] = 92; buf[i + 2] = 168; buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function prettyShortcut(s) { return s.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl'); }

function registerShortcut() {
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(config.shortcut, startGrab); } catch { ok = false; }
  if (!ok) new Notification({ title: 'grab', body: `${prettyShortcut(config.shortcut)} is taken by another app. Pick another shortcut in the dashboard.` }).show();
  updateTray();
  return ok;
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`grab · ${prettyShortcut(config.shortcut)} to select and ask`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Grab now (${prettyShortcut(config.shortcut)})`, click: startGrab },
    { label: 'Open dashboard', click: () => openDashboard('home') },
    { type: 'separator' },
    { label: 'Launch at login', type: 'checkbox', checked: !!config.openAtLogin, click: (i) => { config.openAtLogin = i.checked; saveConfig(); applyLoginItem(); } },
    { type: 'separator' },
    { label: 'Quit grab', click: () => app.exit(0) },
  ]));
}

// ---------- Claude Code warm start ----------

function wantModel(m) { return MODELS[m] || MODELS.fast; }

function warmUp() {
  if (config.backend === 'api') return;
  clearTimeout(warmTimer);
  warmTimer = setTimeout(dropWarm, 90000);
  const model = wantModel(config.model);
  if (warm && warm.alive() && warm.model === model) return;
  dropWarm();
  const bin = claudeBin();
  if (!bin) return;
  warm = new ClaudeCodeSession({ bin, model, system: SYSTEM_PROMPT, cwd: path.join(app.getPath('userData'), 'claude-work') });
  warm.start();
}

function dropWarm() {
  clearTimeout(warmTimer);
  if (warm) { warm.stop(); warm = null; }
}

function takeWarm(model) {
  if (warm && warm.alive() && warm.model === model) { const w = warm; warm = null; clearTimeout(warmTimer); return w; }
  return null;
}

// ---------- overlay ----------

function createOverlay(display) {
  const win = new BrowserWindow({
    x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height,
    show: false, frame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
    skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, hasShadow: false, enableLargerThanScreen: true,
    backgroundColor: '#000000', roundedCorners: false, thickFrame: false,
    webPreferences: { preload, backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); win.hide(); } });
  return win;
}

function syncOverlays() {
  const displays = screen.getAllDisplays();
  const ids = new Set(displays.map((d) => d.id));
  for (const [id, entry] of overlays) {
    if (!ids.has(id)) { app.isQuitting = true; entry.win.destroy(); app.isQuitting = false; overlays.delete(id); }
  }
  for (const d of displays) {
    if (!overlays.has(d.id)) overlays.set(d.id, { win: createOverlay(d), display: d });
    else overlays.get(d.id).display = d;
  }
}

const readyWaiters = new Map();
function waitForReady(displayId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { readyWaiters.delete(displayId); resolve(); }, 800);
    readyWaiters.set(displayId, () => { clearTimeout(timer); readyWaiters.delete(displayId); resolve(); });
  });
}

function localRect(r, d) {
  return { x: r.x - d.bounds.x, y: r.y - d.bounds.y, width: r.width, height: r.height };
}

async function startGrab() {
  if (overlayOpen) return;
  overlayOpen = true;
  warmUp();
  elementCache.clear();
  windowsSnapshot = config.objects ? uia.windows() : Promise.resolve([]);
  try {
    syncOverlays();
    const displays = screen.getAllDisplays();
    const maxW = Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor)));
    const maxH = Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor)));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
    const focusDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const pending = [];
    captures.clear();
    displays.forEach((d, i) => {
      const src = sources.find((s) => s.display_id === String(d.id)) || sources[i];
      const entry = overlays.get(d.id);
      if (!src || !entry) return;
      entry.win.setBounds(d.bounds);
      pending.push(waitForReady(d.id));
      const image = src.thumbnail.toDataURL();
      captures.set(d.id, { image, bounds: d.bounds });
      entry.win.webContents.send('overlay:open', { image, displayId: d.id, bounds: d.bounds, model: config.model, primary: d.id === focusDisplay.id });
    });
    await Promise.all(pending);
    if (!overlayOpen) return;
    for (const d of displays) {
      const entry = overlays.get(d.id);
      if (!entry) continue;
      entry.win.showInactive();
      entry.win.setBounds(d.bounds);
    }
    const target = overlays.get(focusDisplay.id);
    if (target) { target.win.show(); target.win.focus(); }
    sendObjects(displays);
  } catch (err) {
    hideOverlays();
    new Notification({ title: 'grab', body: `Could not capture the screen: ${err.message}` }).show();
  }
}

async function sendObjects(displays) {
  const wins = await windowsSnapshot;
  if (!overlayOpen || !wins.length) return;
  for (const d of displays) {
    const entry = overlays.get(d.id);
    if (!entry || entry.win.isDestroyed()) continue;
    const local = wins
      .filter((w) => w.x < d.bounds.x + d.bounds.width && w.x + w.width > d.bounds.x && w.y < d.bounds.y + d.bounds.height && w.y + w.height > d.bounds.y)
      .map((w) => ({ hwnd: w.hwnd, title: w.title, cls: w.cls, ...localRect(w, d) }));
    entry.win.webContents.send('overlay:objects', local);
  }
}

function hideOverlays() {
  overlayOpen = false;
  for (const { win } of overlays.values()) {
    if (!win.isDestroyed()) { win.webContents.send('overlay:reset'); win.hide(); }
  }
}

// ---------- answer windows ----------

function createAnswer() {
  const opts = {
    width: 460, height: 360, minWidth: 340, minHeight: 220, show: false, frame: false,
    skipTaskbar: true, alwaysOnTop: true, resizable: true, maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: { preload },
  };
  if (nativeGlass) Object.assign(opts, { vibrancy: 'hud', visualEffectState: 'active', transparent: true });
  else Object.assign(opts, { backgroundColor: panelColor() });
  const win = new BrowserWindow(opts);
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'answer.html'), { query: { glass: nativeGlass ? 'native' : 'frozen' } });
  const A = { id: win.webContents.id, win, session: null, pinned: false, stream: null, fadeTimer: null };
  A.ready = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  const sendBounds = () => { if (!win.isDestroyed()) win.webContents.send('answer:bounds', win.getBounds()); };
  win.on('move', sendBounds);
  win.on('resize', sendBounds);
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); closeAnswer(A); } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  answers.set(A.id, A);
  return A;
}

function acquireAnswer() {
  const free = [...answers.values()].filter((a) => !a.pinned && !a.win.isDestroyed());
  const A = free.find((a) => a.win.isVisible()) || free[0] || createAnswer();
  endSession(A);
  A.pinned = false;
  return A;
}

const answerOf = (sender) => answers.get(sender.id);
const send = (A, ch, data) => { if (A && !A.win.isDestroyed()) A.win.webContents.send(ch, data); };

function placeAnswer(A, rect, displayId) {
  const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  const wa = display.workArea;
  const [w, h] = A.win.getSize();
  const gap = 14;
  let x = rect.x + rect.width + gap;
  if (x + w > wa.x + wa.width) x = rect.x - w - gap;
  if (x < wa.x) x = Math.min(wa.x + wa.width - w - gap, Math.max(wa.x + gap, rect.x + rect.width - w));
  let y = Math.min(Math.max(rect.y, wa.y + gap), wa.y + wa.height - h - gap);
  for (const other of answers.values()) {
    if (other === A || !other.win.isVisible()) continue;
    const b = other.win.getBounds();
    if (Math.abs(b.x - x) < 30 && Math.abs(b.y - y) < 30) { x += 28; y += 28; }
  }
  A.win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
}

function fade(A, target) {
  if (!A || A.win.isDestroyed()) return;
  clearInterval(A.fadeTimer);
  const start = A.win.getOpacity();
  let i = 0;
  A.fadeTimer = setInterval(() => {
    i++;
    if (A.win.isDestroyed()) return clearInterval(A.fadeTimer);
    A.win.setOpacity(start + (target - start) * (i / 10));
    if (i >= 10) clearInterval(A.fadeTimer);
  }, 16);
}

function endSession(A) {
  if (A.stream) { try { A.stream.abort(); } catch { /* done */ } A.stream = null; }
  A.session?.cc?.stop();
  A.session = null;
}

function closeAnswer(A) {
  endSession(A);
  A.pinned = false;
  if (A.win.isDestroyed()) return;
  const spares = [...answers.values()].filter((a) => a !== A && !a.win.isDestroyed() && !a.pinned && !a.win.isVisible());
  if (spares.length) {
    answers.delete(A.id);
    app.isQuitting = true; A.win.destroy(); app.isQuitting = false;
  } else {
    send(A, 'answer:reset');
    A.win.hide();
  }
  if (![...answers.values()].some((a) => a.win.isVisible())) captures.clear();
}

async function openAnswer({ image, question, model, rect, displayId, backdrop, turns, historyId }) {
  const A = acquireAnswer();
  await A.ready;
  if (A.win.isDestroyed()) return null;
  const base64 = image.split(',')[1];
  const messages = [{ role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
    { type: 'text', text: question },
  ] }];
  for (const [i, t] of (turns || []).entries()) {
    if (i > 0) messages.push({ role: 'user', content: t.prompt || t.q });
    messages.push({ role: 'assistant', content: t.a });
  }
  A.session = { model, image, question, messages, historyId: historyId || null, label: question };
  A.win.setSize(460, 360);
  if (rect) placeAnswer(A, rect, displayId);
  else A.win.center();
  A.win.setOpacity(config.opacity);
  send(A, 'answer:open', {
    image, question, model, opacity: config.opacity, backdrop: backdrop || null, bounds: A.win.getBounds(),
    turns: turns || null, historyOn: !!config.history,
  });
  A.win.showInactive();
  return A;
}

// ---------- turns ----------

function streamApi(A, s, h) {
  const key = getApiKey();
  if (!key) { h.error('Add your Claude API key in the dashboard to get answers.', { needsKey: true }); return { abort() {} }; }
  const stream = new Anthropic({ apiKey: key }).messages.stream({
    model: wantModel(s.model), max_tokens: 2048, system: SYSTEM_PROMPT, messages: s.messages,
  });
  stream.on('text', h.text);
  stream.finalMessage().then(h.done).catch((err) => {
    if (err?.name === 'APIUserAbortError' || /abort/i.test(err?.message || '')) h.aborted();
    else h.error(friendlyError(err));
  });
  return { abort: () => stream.abort() };
}

function streamClaudeCode(A, s, h) {
  const bin = claudeBin();
  if (!bin) {
    h.error('Claude Code was not found on this computer. Install the Claude desktop app, or switch to an API key in the dashboard.', { needsKey: true });
    return { abort() {} };
  }
  const model = wantModel(s.model);
  if (!s.cc || s.cc.model !== model) {
    s.cc?.stop();
    s.cc = takeWarm(model) || new ClaudeCodeSession({ bin, model, system: SYSTEM_PROMPT, cwd: path.join(app.getPath('userData'), 'claude-work') });
    s.ccTurns = 0;
  }
  const msgs = s.messages;
  const last = msgs[msgs.length - 1];
  const lastText = typeof last.content === 'string' ? last.content : last.content[1].text;
  let content = last.content;
  if (msgs.length > 1 && (!s.cc.alive() || s.ccTurns === 0)) {
    const past = msgs.slice(0, -1).map((m, i) => {
      const text = typeof m.content === 'string' ? m.content : m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return `${m.role === 'user' ? (i === 0 ? 'Question' : 'Follow-up') : 'Your answer'}: ${text}`;
    }).join('\n\n');
    content = [msgs[0].content[0], { type: 'text', text: `Earlier in this conversation about the image:\n\n${past}\n\nNew follow-up: ${lastText}` }];
  }
  const cc = s.cc;
  cc.ask(content, {
    text: h.text,
    done: () => { s.ccTurns = (s.ccTurns || 0) + 1; h.done(); },
    error: (message) => {
      s.ccTurns = 0;
      if (needsLogin(message)) h.error('Sign in to your Claude account to get answers.', { needsLogin: true });
      else h.error(String(message).split('\n')[0].slice(0, 220));
    },
    aborted: () => { s.ccTurns = 0; h.aborted(); },
  });
  return { abort: () => cc.stop() };
}

function runTurn(A, { label, prompt } = {}) {
  const s = A.session;
  if (!s) return;
  const turnId = Date.now();
  s.turnId = turnId;
  const t0 = Date.now();
  let firstMs = null;
  let text = '';
  const mine = () => A.session === s && s.turnId === turnId;
  const last = s.messages[s.messages.length - 1];
  const q = label || (typeof last.content === 'string' ? last.content : last.content[1].text);
  const finish = () => {
    A.stream = null;
    s.messages.push({ role: 'assistant', content: text });
    send(A, 'answer:done', { turnId, firstMs, ms: Date.now() - t0 });
    if (config.history) {
      if (!s.historyId) s.historyId = history.create({ image: s.image, question: s.question, model: s.model, backend: config.backend }).id;
      history.addTurn(s.historyId, { q, prompt: prompt || null, a: text, firstMs, ms: Date.now() - t0, model: s.model, ts: Date.now() });
      if (dashWin && !dashWin.isDestroyed()) dashWin.webContents.send('dash:changed');
    }
  };
  const h = {
    text: (delta) => {
      if (!mine()) return;
      if (firstMs === null) firstMs = Date.now() - t0;
      text += delta;
      send(A, 'answer:delta', { turnId, delta });
    },
    done: () => { if (mine()) finish(); },
    error: (message, extra = {}) => { if (!mine()) return; A.stream = null; send(A, 'answer:error', { message, ...extra }); },
    aborted: () => {
      if (!mine()) return;
      if (text) finish();
      else { A.stream = null; send(A, 'answer:error', { message: 'Stopped.' }); }
    },
  };
  send(A, 'answer:start', { turnId });
  A.stream = config.backend === 'api' ? streamApi(A, s, h) : streamClaudeCode(A, s, h);
}

function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return 'Your API key was rejected. Check it in the dashboard.';
  if (status === 429) return 'Rate limited by the API. Wait a moment, then retry.';
  if (status === 529 || status === 503) return 'Claude is overloaded right now. Retry in a few seconds.';
  if (err?.name === 'APIConnectionError' || /ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(err?.message || '')) return 'You appear to be offline. Check your connection and retry.';
  return err?.message ? String(err.message).slice(0, 200) : 'Something went wrong.';
}

// ---------- dashboard ----------

function openDashboard(tab = 'home') {
  if (dashWin && !dashWin.isDestroyed()) {
    dashWin.webContents.send('dash:tab', tab);
    dashWin.show(); dashWin.focus();
    return;
  }
  const opts = {
    width: 1040, height: 700, minWidth: 820, minHeight: 560, frame: false, show: false,
    title: 'grab', webPreferences: { preload },
  };
  if (nativeGlass) Object.assign(opts, { vibrancy: 'under-window', transparent: true });
  else Object.assign(opts, { backgroundColor: panelColor() });
  dashWin = new BrowserWindow(opts);
  dashWin.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'), { query: { tab } });
  dashWin.once('ready-to-show', () => { dashWin.center(); dashWin.show(); });
  dashWin.on('closed', () => { dashWin = null; });
  dashWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  dashWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

function settingsSnapshot() {
  const bin = claudeBin();
  const auth = bin ? authStatus(bin) : { loggedIn: false };
  return {
    backend: config.backend, claudeFound: !!bin, claudeLoggedIn: auth.loggedIn,
    hasKey: !!getApiKey(), keyFromEnv: !config.apiKeyEnc && !!process.env.ANTHROPIC_API_KEY,
    shortcut: config.shortcut, model: config.model, openAtLogin: !!config.openAtLogin,
    history: !!config.history, objects: !!config.objects, opacity: config.opacity, platform: process.platform,
  };
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.on('overlay:cancel', hideOverlays);
  ipcMain.on('overlay:ready', (_e, displayId) => readyWaiters.get(displayId)?.());
  ipcMain.on('overlay:selecting', (e) => {
    for (const { win } of overlays.values()) {
      if (win.webContents !== e.sender && !win.isDestroyed()) win.webContents.send('overlay:clear-selection');
    }
  });
  ipcMain.handle('overlay:elements', async (e, hwnd) => {
    const entry = [...overlays.values()].find((o) => o.win.webContents === e.sender);
    if (!entry) return [];
    if (!elementCache.has(hwnd)) elementCache.set(hwnd, uia.elements(hwnd));
    const list = await elementCache.get(hwnd);
    return list.map((el) => ({ kind: el.kind, name: el.name, ...localRect(el, entry.display) }));
  });

  ipcMain.on('overlay:submit', (_e, payload) => {
    const { image, question, model, rect, displayId } = payload;
    hideOverlays();
    config.model = model; saveConfig();
    openAnswer({ image, question, model, rect, displayId, backdrop: captures.get(displayId) || null }).then((A) => { if (A) runTurn(A); });
  });

  ipcMain.on('answer:followup', (e, question) => {
    const A = answerOf(e.sender);
    const s = A?.session;
    if (!s || !question.trim()) return;
    const last = s.messages[s.messages.length - 1];
    if (last.role === 'user' && s.messages.length > 1) s.messages.pop();
    else if (last.role === 'user') { last.content = [last.content[0], { type: 'text', text: question.trim() }]; return runTurn(A); }
    s.messages.push({ role: 'user', content: question.trim() });
    runTurn(A);
  });

  ipcMain.on('answer:brief', (e) => {
    const A = answerOf(e.sender);
    const s = A?.session;
    if (!s || A.stream) return;
    if (s.messages[s.messages.length - 1].role === 'user' && s.messages.length > 1) s.messages.pop();
    s.messages.push({ role: 'user', content: BRIEF_PROMPT });
    runTurn(A, { label: BRIEF_LABEL, prompt: BRIEF_PROMPT });
  });

  ipcMain.on('answer:retry', (e) => { const A = answerOf(e.sender); if (A?.session) runTurn(A); });
  ipcMain.on('answer:stop', (e) => { const A = answerOf(e.sender); if (A?.stream) { try { A.stream.abort(); } catch { /* done */ } } });
  ipcMain.on('answer:close', (e) => { const A = answerOf(e.sender); if (A) closeAnswer(A); });
  ipcMain.on('answer:model', (e, model) => {
    const A = answerOf(e.sender);
    if (A?.session && MODELS[model]) { A.session.model = model; config.model = model; saveConfig(); }
  });
  ipcMain.on('answer:pin', (e, pinned) => {
    const A = answerOf(e.sender);
    if (!A) return;
    A.pinned = !!pinned;
    A.win.setAlwaysOnTop(true, A.pinned ? 'pop-up-menu' : 'floating');
    fade(A, config.opacity);
  });
  ipcMain.on('answer:opacity', (e, v) => {
    config.opacity = Math.min(1, Math.max(0.4, Number(v) || 1));
    saveConfig();
    const A = answerOf(e.sender);
    if (A && !A.win.isDestroyed()) { clearInterval(A.fadeTimer); A.win.setOpacity(config.opacity); }
  });
  ipcMain.on('answer:idle', (e) => { const A = answerOf(e.sender); if (A?.session && !A.pinned) fade(A, 0.12); });
  ipcMain.on('answer:active', (e) => { const A = answerOf(e.sender); if (A) fade(A, config.opacity); });
  ipcMain.on('answer:grab', () => startGrab());
  ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.on('dashboard:open', (_e, tab) => openDashboard(tab || 'home'));
  ipcMain.on('settings:open', () => openDashboard('settings'));
  ipcMain.on('claude:login', () => { const bin = claudeBin(); if (bin) openLogin(bin); });
  ipcMain.on('open:console', () => shell.openExternal('https://console.anthropic.com/settings/keys'));

  ipcMain.handle('answer:save', async (e, markdown) => {
    const A = answerOf(e.sender);
    const dir = config.notesDir || path.join(app.getPath('documents'), 'Grab notes');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const res = await dialog.showSaveDialog(A?.win, {
      title: 'Save answer as note', defaultPath: path.join(dir, `grab-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    const imgName = path.basename(res.filePath, '.md') + '.png';
    let body = markdown;
    if (A?.session?.image) {
      fs.writeFileSync(path.join(path.dirname(res.filePath), imgName), Buffer.from(A.session.image.split(',')[1], 'base64'));
      body = `![grab](${imgName})\n\n${markdown}`;
    }
    fs.writeFileSync(res.filePath, body);
    config.notesDir = path.dirname(res.filePath); saveConfig();
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('settings:get', () => settingsSnapshot());
  ipcMain.handle('settings:save', (_e, s) => {
    try {
      if (typeof s.apiKey === 'string' && s.apiKey.trim()) setApiKey(s.apiKey.trim());
      if (s.clearKey) setApiKey('');
      if (s.model && MODELS[s.model]) config.model = s.model;
      if (s.backend === 'api' || s.backend === 'claude') config.backend = s.backend;
      for (const k of ['openAtLogin', 'history', 'objects']) if (typeof s[k] === 'boolean') config[k] = s[k];
      if (typeof s.opacity === 'number') config.opacity = Math.min(1, Math.max(0.4, s.opacity));
      const prev = config.shortcut;
      if (s.shortcut) config.shortcut = s.shortcut;
      const ok = registerShortcut();
      if (!ok && s.shortcut && s.shortcut !== prev) {
        config.shortcut = prev; registerShortcut();
        return { ok: false, error: `${prettyShortcut(s.shortcut)} could not be registered. Another app is using it.` };
      }
      if (config.backend === 'api') dropWarm();
      saveConfig(); applyLoginItem(); updateTray();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('settings:test-key', async (_e, key) => {
    try {
      await new Anthropic({ apiKey: key || getApiKey() }).messages.create({ model: MODELS.fast, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });

  ipcMain.handle('dash:data', () => ({ stats: history.stats(), list: history.list(), settings: settingsSnapshot() }));
  ipcMain.handle('dash:entry', (_e, id) => history.get(id));
  ipcMain.handle('dash:delete', (_e, id) => { history.remove(id); return true; });
  ipcMain.handle('dash:favorite', (_e, id) => history.toggleFavorite(id));
  ipcMain.handle('dash:clear', () => { history.clear(); return true; });
  ipcMain.on('dash:reopen', (_e, id) => {
    const e = history.get(id);
    if (!e?.image) return;
    openAnswer({ image: e.image, question: e.question, model: e.model, turns: e.turns, historyId: e.id });
  });
  ipcMain.on('dash:grab', () => {
    if (dashWin && !dashWin.isDestroyed()) dashWin.minimize();
    setTimeout(startGrab, 250);
  });
  ipcMain.on('dash:close', () => dashWin?.close());
  ipcMain.on('dash:minimize', () => dashWin?.minimize());
}

app.on('second-instance', startGrab);

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();
  app.setAppUserModelId('grab');
  loadConfig();
  applyLoginItem();
  registerIpc();
  syncOverlays();
  createAnswer();
  if (config.objects) uia.start();
  tray = new Tray(trayIcon());
  tray.on('click', () => openDashboard('home'));
  registerShortcut();
  screen.on('display-added', syncOverlays);
  screen.on('display-removed', syncOverlays);
  screen.on('display-metrics-changed', syncOverlays);
  nativeTheme.on('updated', () => {
    if (nativeGlass) return;
    for (const w of [dashWin, ...[...answers.values()].map((a) => a.win)]) if (w && !w.isDestroyed()) w.setBackgroundColor(panelColor());
  });
  const bin = claudeBin();
  const ready = config.backend === 'api' ? !!getApiKey() : !!bin && authStatus(bin).loggedIn;
  if (!ready) openDashboard('settings');
  if (process.argv.includes('--grab-now')) setTimeout(startGrab, 800);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { app.isQuitting = true; dropWarm(); uia.stop(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
