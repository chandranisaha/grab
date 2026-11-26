const params = new URLSearchParams(location.search);
if (params.get('glass') !== 'native') document.body.classList.add('css-glass');

const $ = (id) => document.getElementById(id);
const DEFAULT_SHORTCUT = 'Control+Q';
let state = { shortcut: DEFAULT_SHORTCUT, model: 'fast', openAtLogin: true };
let recording = false;
let isMac = false;

const pretty = (s) => s.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl').replace('Command', 'Cmd').replace(/\+/g, ' + ');

function setModel(m) {
  state.model = m;
  for (const b of $('model').children) b.classList.toggle('active', b.dataset.model === m);
}

let conn = { found: false, loggedIn: false };

function setBackend(b) {
  state.backend = b;
  for (const btn of $('backend').children) btn.classList.toggle('active', btn.dataset.backend === b);
  $('keyGroup').hidden = b !== 'api';
  $('connRow').hidden = b !== 'claude';
  $('connNote').textContent = b === 'claude'
    ? 'Uses your Claude subscription through Claude Code. No API key needed.'
    : 'Billed per request to your Anthropic Console account.';
  showConn();
}

function showConn() {
  const dot = $('connDot');
  dot.className = 'conn-dot';
  if (!conn.found) {
    dot.classList.add('bad');
    $('connText').textContent = 'Claude Code not found. Install the Claude desktop app.';
    $('signin').hidden = true;
  } else if (conn.loggedIn) {
    dot.classList.add('ok');
    $('connText').textContent = 'Connected to your Claude account';
    $('signin').hidden = true;
  } else {
    dot.classList.add('bad');
    $('connText').textContent = 'Not signed in';
    $('signin').hidden = false;
  }
}

function setLogin(v) {
  state.openAtLogin = v;
  $('login').classList.toggle('on', v);
  $('login').setAttribute('aria-checked', String(v));
}

function showShortcut() {
  $('shortcut').textContent = recording ? 'Press keys...' : pretty(state.shortcut);
  $('shortcut').classList.toggle('rec', recording);
}

function status(msg, bad = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('bad', bad);
}

function keyNote(msg, cls = '') {
  $('keynote').textContent = msg;
  $('keynote').className = `note ${cls}`;
}

function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.metaKey) mods.push(isMac ? 'Command' : 'Super');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  else if (/^Arrow/.test(e.code)) key = e.code.slice(5);
  else if (['Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backslash'].includes(e.code)) {
    key = { Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\' }[e.code];
  }
  if (!key || mods.length === 0) return null;
  return [...mods, key].join('+');
}

$('shortcut').addEventListener('click', () => { recording = true; showShortcut(); });
$('shortcut').addEventListener('blur', () => { recording = false; showShortcut(); });
window.addEventListener('keydown', (e) => {
  if (!recording) {
    if (e.key === 'Escape') window.grab.send('settings:close');
    return;
  }
  e.preventDefault();
  if (e.key === 'Escape') { recording = false; showShortcut(); return; }
  const acc = toAccelerator(e);
  if (acc) { state.shortcut = acc; recording = false; showShortcut(); status('Press Save to apply the new shortcut.'); }
});

$('backend').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setBackend(b.dataset.backend); });
$('signin').addEventListener('click', () => {
  window.grab.send('claude:login');
  $('connText').textContent = 'Finish signing in in the window that opened...';
  let tries = 0;
  const poll = setInterval(async () => {
    const s = await window.grab.invoke('settings:get');
    conn = { found: s.claudeFound, loggedIn: s.claudeLoggedIn };
    if (conn.loggedIn || ++tries > 60) { clearInterval(poll); showConn(); }
  }, 3000);
});
$('resetkey').addEventListener('click', () => { state.shortcut = DEFAULT_SHORTCUT; showShortcut(); status('Press Save to apply.'); });
$('model').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setModel(b.dataset.model); });
$('login').addEventListener('click', () => setLogin(!state.openAtLogin));
$('close').addEventListener('click', () => window.grab.send('settings:close'));
$('getkey').addEventListener('click', (e) => { e.preventDefault(); window.grab.send('open:console'); });

$('test').addEventListener('click', async () => {
  const key = $('key').value.trim();
  keyNote('Testing...');
  $('test').disabled = true;
  const res = await window.grab.invoke('settings:test-key', key);
  $('test').disabled = false;
  if (res.ok) keyNote('Key works.', 'ok');
  else keyNote(res.error, 'bad');
});

$('saveBtn').addEventListener('click', async () => {
  const res = await window.grab.invoke('settings:save', {
    apiKey: $('key').value.trim(),
    shortcut: state.shortcut,
    model: state.model,
    openAtLogin: state.openAtLogin,
    backend: state.backend,
  });
  if (res.ok) {
    $('key').value = '';
    await load();
    status(`Saved. Press ${pretty(state.shortcut)} anywhere to grab.`);
  } else {
    status(res.error, true);
  }
});

async function load() {
  const s = await window.grab.invoke('settings:get');
  isMac = s.platform === 'darwin';
  state = { shortcut: s.shortcut, model: s.model, openAtLogin: s.openAtLogin, backend: s.backend };
  conn = { found: s.claudeFound, loggedIn: s.claudeLoggedIn };
  setBackend(s.backend);
  setModel(s.model);
  setLogin(s.openAtLogin);
  showShortcut();
  if (s.hasKey) {
    $('key').placeholder = s.keyFromEnv ? 'Using ANTHROPIC_API_KEY from environment' : 'Saved in keychain. Paste to replace.';
  } else {
    $('key').placeholder = 'sk-ant-...';
    if (s.backend === 'api') status('Paste your API key to start.');
  }
  if (s.backend === 'claude' && !s.claudeLoggedIn) status('Sign in to your Claude account to start.');
}

load();
