const {
  app, BrowserWindow, globalShortcut, desktopCapturer, screen, ipcMain,
  Tray, Menu, nativeImage, safeStorage, clipboard, dialog, nativeTheme, Notification, shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const { findClaude, ClaudeCodeSession, openLogin, authStatus } = require('./claude-code');

const MODELS = { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5' };
const DEFAULT_SHORTCUT = 'Control+Q';
const SYSTEM_PROMPT = [
  'You are Grab, a desktop assistant. The user circled a region of their screen; the image is that region.',
  'Answer the question about it directly and briefly. Lead with the answer, then the minimum explanation needed.',
  'Use Markdown. Put code in fenced blocks with a language tag. Write math in LaTeX with $...$ or $$...$$.',
  'If asked to copy or transcribe text, return only the exact text, preserving line breaks, in a fenced block when it is code.',
].join(' ');

if (!app.requestSingleInstanceLock()) app.quit();

const preload = path.join(__dirname, 'preload.js');
const configPath = () => path.join(app.getPath('userData'), 'config.json');

let config = {};
let tray = null;
let overlays = new Map();
let answerWin = null;
let settingsWin = null;
let session = null;
let activeStream = null;
let fadeTimer = null;
let overlayOpen = false;
const captures = new Map();

function loadConfig() {
  try { config = JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { config = {}; }
  config = { shortcut: DEFAULT_SHORTCUT, model: 'fast', openAtLogin: true, opacity: 1, backend: 'claude', ...config };
}

const claudeBin = () => findClaude(config.claudePath);
const needsLogin = (msg) => /authenticat|log ?in|oauth|not logged|credential|401|unauthori/i.test(msg || '');

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

function applyLoginItem() {
  const opts = { openAtLogin: !!config.openAtLogin };
  if (!app.isPackaged) Object.assign(opts, { path: process.execPath, args: [path.resolve(__dirname, '..')] });
  app.setLoginItemSettings(opts);
}

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
      buf[i] = 255; buf[i + 1] = 255; buf[i + 2] = 255; buf[i + 3] = Math.round(a * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  let ok = false;
  try { ok = globalShortcut.register(config.shortcut, startGrab); } catch { ok = false; }
  if (!ok) {
    new Notification({ title: 'Grab', body: `${config.shortcut} is taken by another app. Pick another shortcut in settings.` }).show();
  }
  updateTray();
  return ok;
}

function prettyShortcut(s) { return s.replace('Control', 'Ctrl').replace('CommandOrControl', 'Ctrl'); }

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Grab · ${prettyShortcut(config.shortcut)} to circle and ask`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Grab now (${prettyShortcut(config.shortcut)})`, click: startGrab },
    { type: 'separator' },
    { label: 'Settings', click: openSettings },
    { label: 'Launch at login', type: 'checkbox', checked: !!config.openAtLogin, click: (i) => { config.openAtLogin = i.checked; saveConfig(); applyLoginItem(); } },
    { type: 'separator' },
    { label: 'Quit Grab', click: () => app.exit(0) },
  ]));
}

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

async function startGrab() {
  if (overlayOpen) return;
  overlayOpen = true;
  try {
    syncOverlays();
    const displays = screen.getAllDisplays();
    const maxW = Math.max(...displays.map((d) => Math.round(d.bounds.width * d.scaleFactor)));
    const maxH = Math.max(...displays.map((d) => Math.round(d.bounds.height * d.scaleFactor)));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
    const cursor = screen.getCursorScreenPoint();
    const focusDisplay = screen.getDisplayNearestPoint(cursor);
    const pending = [];
    captures.clear();
    displays.forEach((d, i) => {
      const src = sources.find((s) => s.display_id === String(d.id)) || sources[i];
      const entry = overlays.get(d.id);
      if (!src || !entry) return;
      const { win } = entry;
      win.setBounds(d.bounds);
      pending.push(waitForReady(d.id));
      const image = src.thumbnail.toDataURL();
      captures.set(d.id, { image, bounds: d.bounds });
      win.webContents.send('overlay:open', {
        image,
        displayId: d.id,
        bounds: d.bounds,
        model: config.model,
        primary: d.id === focusDisplay.id,
      });
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
  } catch (err) {
    overlayOpen = false;
    hideOverlays();
    new Notification({ title: 'Grab', body: `Could not capture the screen: ${err.message}` }).show();
  }
}

const readyWaiters = new Map();

function waitForReady(displayId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { readyWaiters.delete(displayId); resolve(); }, 800);
    readyWaiters.set(displayId, () => { clearTimeout(timer); readyWaiters.delete(displayId); resolve(); });
  });
}

function hideOverlays() {
  overlayOpen = false;
  for (const { win } of overlays.values()) {
    if (!win.isDestroyed()) { win.webContents.send('overlay:reset'); win.hide(); }
  }
}

const nativeGlass = process.platform === 'darwin';
const panelColor = () => (nativeTheme.shouldUseDarkColors ? '#1c1c20' : '#f2f2f5');

function createAnswerWindow() {
  const opts = {
    width: 440, height: 340, minWidth: 320, minHeight: 200, show: false, frame: false,
    skipTaskbar: true, alwaysOnTop: true, resizable: true, maximizable: false, minimizable: false, fullscreenable: false,
    webPreferences: { preload },
  };
  if (nativeGlass) Object.assign(opts, { vibrancy: 'hud', visualEffectState: 'active', transparent: true });
  else Object.assign(opts, { backgroundColor: panelColor() });
  const win = new BrowserWindow(opts);
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'renderer', 'answer.html'), { query: { glass: nativeGlass ? 'native' : 'frozen' } });
  const sendBounds = () => { if (!win.isDestroyed()) win.webContents.send('answer:bounds', win.getBounds()); };
  win.on('move', sendBounds);
  win.on('resize', sendBounds);
  win.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); closeAnswer(); } });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  return win;
}

function placeAnswer(rect, displayId) {
  const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  const wa = display.workArea;
  const [w, h] = answerWin.getSize();
  const gap = 14;
  let x = rect.x + rect.width + gap;
  if (x + w > wa.x + wa.width) x = rect.x - w - gap;
  if (x < wa.x) x = Math.min(wa.x + wa.width - w - gap, Math.max(wa.x + gap, rect.x + rect.width - w));
  let y = Math.min(Math.max(rect.y, wa.y + gap), wa.y + wa.height - h - gap);
  answerWin.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
}

function setAnswerOpacity(target) {
  if (!answerWin || answerWin.isDestroyed()) return;
  clearInterval(fadeTimer);
  const start = answerWin.getOpacity();
  const steps = 10;
  let i = 0;
  fadeTimer = setInterval(() => {
    i++;
    if (answerWin.isDestroyed()) return clearInterval(fadeTimer);
    answerWin.setOpacity(start + (target - start) * (i / steps));
    if (i >= steps) clearInterval(fadeTimer);
  }, 16);
}

function closeAnswer() {
  if (activeStream) { try { activeStream.abort(); } catch { /* already done */ } activeStream = null; }
  session?.cc?.stop();
  session = null;
  captures.clear();
  if (answerWin && !answerWin.isDestroyed()) { answerWin.webContents.send('answer:reset'); answerWin.hide(); }
}

function runClaudeCode() {
  const send = (ch, data) => { if (answerWin && !answerWin.isDestroyed()) answerWin.webContents.send(ch, data); };
  const bin = claudeBin();
  if (!bin) {
    send('answer:error', { message: 'Claude Code was not found on this computer. Install the Claude desktop app or Claude Code, or switch to an API key in Settings.', needsKey: true });
    return;
  }
  if (!session.cc || session.cc.model !== (MODELS[session.model] || MODELS.fast)) {
    session.cc?.stop();
    session.cc = new ClaudeCodeSession({
      bin, model: MODELS[session.model] || MODELS.fast, system: SYSTEM_PROMPT,
      cwd: path.join(app.getPath('userData'), 'claude-work'),
    });
  }
  const cc = session.cc;
  const msgs = session.messages;
  const last = msgs[msgs.length - 1];
  let content = last.content;
  if (!cc.alive() && msgs.length > 1) {
    const history = msgs.slice(0, -1).map((m, i) => {
      const text = typeof m.content === 'string' ? m.content : m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return `${m.role === 'user' ? (i === 0 ? 'Question' : 'Follow-up') : 'Your answer'}: ${text}`;
    }).join('\n\n');
    content = [msgs[0].content[0], { type: 'text', text: `Earlier in this conversation about the image:\n\n${history}\n\nNew follow-up: ${typeof last.content === 'string' ? last.content : last.content[1].text}` }];
  }
  const turnId = Date.now();
  session.turnId = turnId;
  let text = '';
  const mine = () => session && session.turnId === turnId;
  activeStream = { abort: () => cc.stop() };
  send('answer:start', { turnId });
  cc.ask(content, {
    text: (delta) => { if (!mine()) return; text += delta; send('answer:delta', { turnId, delta }); },
    done: () => {
      if (!mine()) return;
      activeStream = null;
      msgs.push({ role: 'assistant', content: text });
      send('answer:done', { turnId });
    },
    error: (message) => {
      if (!mine()) return;
      activeStream = null;
      if (needsLogin(message)) send('answer:error', { message: 'Sign in to your Claude account to get answers. A window will open to sign in; then press Retry.', needsLogin: true });
      else send('answer:error', { message: String(message).split('\n')[0].slice(0, 220) });
    },
    aborted: () => {
      if (!mine()) return;
      activeStream = null;
      if (text) { msgs.push({ role: 'assistant', content: text }); send('answer:done', { turnId }); }
      else send('answer:error', { message: 'Stopped.' });
    },
  });
}

async function runTurn() {
  if (config.backend !== 'api') return runClaudeCode();
  const key = getApiKey();
  const send = (ch, data) => { if (answerWin && !answerWin.isDestroyed()) answerWin.webContents.send(ch, data); };
  if (!key) {
    send('answer:error', { message: 'Add your Claude API key in Settings to get answers.', needsKey: true });
    return;
  }
  const client = new Anthropic({ apiKey: key });
  const turnId = Date.now();
  session.turnId = turnId;
  let text = '';
  send('answer:start', { turnId });
  try {
    const stream = client.messages.stream({
      model: MODELS[session.model] || MODELS.fast,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: session.messages,
    });
    activeStream = stream;
    stream.on('text', (delta) => {
      if (session?.turnId !== turnId) return;
      text += delta;
      send('answer:delta', { turnId, delta });
    });
    await stream.finalMessage();
    if (session?.turnId !== turnId) return;
    session.messages.push({ role: 'assistant', content: text });
    send('answer:done', { turnId });
  } catch (err) {
    if (session?.turnId !== turnId) return;
    if (err?.name === 'APIUserAbortError' || /abort/i.test(err?.message || '')) {
      if (text) { session.messages.push({ role: 'assistant', content: text }); send('answer:done', { turnId }); }
      else send('answer:error', { message: 'Stopped.' });
      return;
    }
    send('answer:error', { message: friendlyError(err) });
  } finally {
    if (session?.turnId === turnId) activeStream = null;
  }
}

function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return 'Your API key was rejected. Check it in Settings.';
  if (status === 429) return 'Rate limited by the API. Wait a moment, then retry.';
  if (status === 529 || status === 503) return 'Claude is overloaded right now. Retry in a few seconds.';
  if (err?.name === 'APIConnectionError' || /ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(err?.message || '')) return 'You appear to be offline. Check your connection and retry.';
  return err?.message ? String(err.message).slice(0, 200) : 'Something went wrong.';
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  const opts = {
    width: 480, height: 690, resizable: false, maximizable: false, minimizable: false, frame: false, show: false,
    alwaysOnTop: true, webPreferences: { preload },
  };
  if (nativeGlass) Object.assign(opts, { vibrancy: 'hud', transparent: true });
  else Object.assign(opts, { backgroundColor: panelColor() });
  settingsWin = new BrowserWindow(opts);
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'), { query: { glass: nativeGlass ? 'native' : 'solid' } });
  settingsWin.once('ready-to-show', () => { settingsWin.center(); settingsWin.show(); });
  settingsWin.on('closed', () => { settingsWin = null; });
}

function registerIpc() {
  ipcMain.on('overlay:cancel', hideOverlays);
  ipcMain.on('overlay:ready', (_e, displayId) => readyWaiters.get(displayId)?.());

  ipcMain.on('overlay:selecting', (e) => {
    for (const { win } of overlays.values()) {
      if (win.webContents !== e.sender && !win.isDestroyed()) win.webContents.send('overlay:clear-selection');
    }
  });

  ipcMain.on('overlay:submit', (_e, payload) => {
    const { image, question, model, rect, displayId } = payload;
    hideOverlays();
    if (activeStream) { try { activeStream.abort(); } catch { /* ignore */ } activeStream = null; }
    session?.cc?.stop();
    config.model = model; saveConfig();
    const base64 = image.split(',')[1];
    session = {
      model, image, question,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
        { type: 'text', text: question },
      ] }],
    };
    if (!answerWin || answerWin.isDestroyed()) answerWin = createAnswerWindow();
    answerWin.setSize(440, 340);
    placeAnswer(rect, displayId);
    answerWin.setOpacity(config.opacity);
    answerWin.webContents.send('answer:open', {
      image, question, model, opacity: config.opacity,
      backdrop: captures.get(displayId) || null,
      bounds: answerWin.getBounds(),
    });
    answerWin.showInactive();
    runTurn();
  });

  ipcMain.on('answer:followup', (_e, question) => {
    if (!session || !question.trim()) return;
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'user' && session.messages.length > 1) session.messages.pop();
    else if (last?.role === 'user') {
      last.content = [last.content[0], { type: 'text', text: question.trim() }];
      return runTurn();
    }
    session.messages.push({ role: 'user', content: question.trim() });
    runTurn();
  });

  ipcMain.on('answer:retry', () => {
    if (!session) return;
    runTurn();
  });

  ipcMain.on('answer:stop', () => {
    if (activeStream) { try { activeStream.abort(); } catch { /* ignore */ } }
  });

  ipcMain.on('answer:close', closeAnswer);
  ipcMain.on('answer:pin', (_e, pinned) => { if (session) session.pinned = pinned; if (pinned) setAnswerOpacity(config.opacity); });
  ipcMain.on('answer:opacity', (_e, v) => {
    config.opacity = Math.min(1, Math.max(0.4, Number(v) || 1));
    saveConfig();
    if (answerWin && !answerWin.isDestroyed()) { clearInterval(fadeTimer); answerWin.setOpacity(config.opacity); }
  });
  ipcMain.on('answer:idle', () => { if (session && !session.pinned) setAnswerOpacity(0.12); });
  ipcMain.on('answer:active', () => setAnswerOpacity(config.opacity));
  ipcMain.on('answer:focus', () => { if (answerWin && !answerWin.isDestroyed()) answerWin.focus(); });
  ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
  ipcMain.on('settings:open', openSettings);

  ipcMain.handle('answer:save', async (_e, markdown) => {
    const dir = config.notesDir || path.join(app.getPath('documents'), 'Grab notes');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const res = await dialog.showSaveDialog(answerWin, {
      title: 'Save answer as note', defaultPath: path.join(dir, `grab-${stamp}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false };
    const imgName = path.basename(res.filePath, '.md') + '.png';
    let body = markdown;
    if (session?.image) {
      fs.writeFileSync(path.join(path.dirname(res.filePath), imgName), Buffer.from(session.image.split(',')[1], 'base64'));
      body = `![grab](${imgName})\n\n${markdown}`;
    }
    fs.writeFileSync(res.filePath, body);
    config.notesDir = path.dirname(res.filePath); saveConfig();
    return { ok: true, path: res.filePath };
  });

  ipcMain.handle('settings:get', () => {
    const bin = claudeBin();
    const auth = bin ? authStatus(bin) : { loggedIn: false };
    return {
      backend: config.backend,
      claudeFound: !!bin,
      claudeLoggedIn: auth.loggedIn,
      hasKey: !!getApiKey(),
      keyFromEnv: !config.apiKeyEnc && !!process.env.ANTHROPIC_API_KEY,
      shortcut: config.shortcut,
      model: config.model,
      openAtLogin: !!config.openAtLogin,
      platform: process.platform,
    };
  });

  ipcMain.on('claude:login', () => { const bin = claudeBin(); if (bin) openLogin(bin); });

  ipcMain.handle('settings:save', (_e, s) => {
    try {
      if (typeof s.apiKey === 'string' && s.apiKey.trim()) setApiKey(s.apiKey.trim());
      if (s.clearKey) setApiKey('');
      if (s.model) config.model = s.model;
      if (s.backend === 'api' || s.backend === 'claude') config.backend = s.backend;
      if (typeof s.openAtLogin === 'boolean') config.openAtLogin = s.openAtLogin;
      const prev = config.shortcut;
      if (s.shortcut) config.shortcut = s.shortcut;
      const ok = registerShortcut();
      if (!ok && s.shortcut && s.shortcut !== prev) {
        config.shortcut = prev; registerShortcut();
        return { ok: false, error: `${prettyShortcut(s.shortcut)} could not be registered. Another app is using it.` };
      }
      saveConfig(); applyLoginItem(); updateTray();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:test-key', async (_e, key) => {
    try {
      const client = new Anthropic({ apiKey: key || getApiKey() });
      await client.messages.create({ model: MODELS.fast, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: friendlyError(err) };
    }
  });

  ipcMain.on('settings:close', () => settingsWin?.close());
  ipcMain.on('open:console', () => shell.openExternal('https://console.anthropic.com/settings/keys'));
}

app.on('second-instance', startGrab);

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();
  app.setAppUserModelId('Grab');
  loadConfig();
  applyLoginItem();
  registerIpc();
  syncOverlays();
  answerWin = createAnswerWindow();
  tray = new Tray(trayIcon());
  tray.on('click', startGrab);
  registerShortcut();
  screen.on('display-added', syncOverlays);
  screen.on('display-removed', syncOverlays);
  screen.on('display-metrics-changed', syncOverlays);
  nativeTheme.on('updated', () => {
    if (!nativeGlass) for (const w of [answerWin, settingsWin]) if (w && !w.isDestroyed()) w.setBackgroundColor(panelColor());
  });
  const bin = claudeBin();
  const ready = config.backend === 'api' ? !!getApiKey() : !!bin && authStatus(bin).loggedIn;
  if (!ready) openSettings();
  if (process.argv.includes('--grab-now')) setTimeout(startGrab, 800);
});

app.on('window-all-closed', (e) => e.preventDefault());
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
