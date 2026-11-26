const { marked, katex } = window.Vendor;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULT_SHORTCUT = 'Control+Q';
const TITLES = { home: 'Home', history: 'History', settings: 'Settings' };

let data = { stats: null, list: [], settings: null };
let tab = new URLSearchParams(location.search).get('tab') || 'home';
let filter = 'all';
let selected = null;
let form = {};
let recording = false;
let toastTimer = null;

marked.use({ gfm: true, renderer: { html({ text }) { return esc(text); } } });
function md(src) {
  const math = [];
  const hold = (h) => `@@M${math.push(h) - 1}@@`;
  const k = (t, d) => { try { return katex.renderToString(t, { displayMode: d, throwOnError: false, strict: 'ignore' }); } catch { return esc(t); } };
  const parts = String(src || '').split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((p, i) => (i % 2 ? p : p
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => hold(k(t.trim(), true)))
    .replace(/(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, (_, pre, t) => pre + hold(k(t, false)))));
  return marked.parse(parts.join('')).replace(/@@M(\d+)@@/g, (_, n) => math[n] || '');
}

const pretty = (s) => s.replace('CommandOrControl', 'Ctrl').replace('Control', 'Ctrl').replace('Command', 'Cmd').split('+');
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}
const fmtMs = (ms) => (ms == null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const snippet = (t) => String(t || '').replace(/```[\s\S]*?```/g, '[code]').replace(/[#*_`>$]/g, '').replace(/\s+/g, ' ').trim();

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}

// ---------- navigation ----------

function show(next) {
  tab = TITLES[next] ? next : 'home';
  for (const b of $('nav').children) b.classList.toggle('active', b.dataset.tab === tab);
  for (const k of Object.keys(TITLES)) $(`page-${k}`).hidden = k !== tab;
  $('pageTitle').textContent = TITLES[tab];
}
$('nav').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.tab); });
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) show(g.dataset.goto); });
$('minBtn').addEventListener('click', () => window.grab.send('dash:minimize'));
$('closeBtn').addEventListener('click', () => window.grab.send('dash:close'));
$('grabNow').addEventListener('click', () => window.grab.send('dash:grab'));

// ---------- connection ----------

function connState(s) {
  if (s.backend === 'api') return s.hasKey ? ['ok', 'Using your API key'] : ['bad', 'No API key saved'];
  if (!s.claudeFound) return ['bad', 'Claude Code not found'];
  return s.claudeLoggedIn ? ['ok', 'Connected to your Claude account'] : ['bad', 'Not signed in to Claude'];
}
function paintConn(el, s) {
  const [cls, txt] = connState(s);
  el.className = `conn ${el.classList.contains('big') ? 'big ' : ''}${cls}`;
  el.querySelector('.txt').textContent = txt;
}

// ---------- home ----------

function renderHome() {
  const st = data.stats;
  $('stToday').textContent = st.today;
  $('stWeek').textContent = st.week;
  $('stTotal').textContent = st.total;
  $('stFollow').textContent = `${st.followups} follow-up${st.followups === 1 ? '' : 's'}`;
  $('stFirst').textContent = fmtMs(st.medianFirstMs);
  $('stFast').textContent = st.fast;
  $('stSmart').textContent = st.smart;
  renderChart(st.days);
  const recent = data.list.slice(0, 6);
  $('recent').innerHTML = recent.length ? recent.map((e) => `
    <button class="rcard" data-open="${e.id}">
      <div class="img" style="background-image:url('${e.thumb}')"></div>
      <div class="body"><div class="qq">${esc(e.question)}</div><div class="aa">${esc(snippet(e.answer)) || '<span class="muted">No answer saved</span>'}</div><div class="when">${ago(e.ts)} · ${e.model === 'smart' ? 'Smart' : 'Fast'}</div></div>
    </button>`).join('')
    : `<div class="empty">No grabs yet. Press <kbd>${pretty(data.settings.shortcut).join('</kbd> + <kbd>')}</kbd> anywhere, then click, circle or drag over something.</div>`;
}

function renderChart(days) {
  const el = $('chart');
  const W = el.clientWidth || 520;
  const H = el.clientHeight || 150;
  const padB = 22;
  const padT = 18;
  const max = Math.max(1, ...days.map((d) => d.count));
  const slot = W / days.length;
  const bw = Math.min(34, slot * 0.46);
  const names = days.map((d) => new Date(d.day).toLocaleDateString(undefined, { weekday: 'short' }));
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grabs per day for the last 7 days">`;
  svg += `<line class="base" x1="0" x2="${W}" y1="${H - padB}" y2="${H - padB}"/>`;
  days.forEach((d, i) => {
    const h = d.count ? Math.max(4, ((H - padB - padT) * d.count) / max) : 0;
    const x = i * slot + (slot - bw) / 2;
    const y = H - padB - h;
    const r = Math.min(4, bw / 2, h);
    const path = h ? `M${x},${H - padB} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${H - padB} Z` : '';
    svg += `<rect class="hit" x="${i * slot}" y="0" width="${slot}" height="${H}" data-i="${i}"/>`;
    if (h) svg += `<path class="bar" d="${path}" data-i="${i}"/>`;
    if (i === days.length - 1 || d.count === max) svg += `<text class="val" x="${x + bw / 2}" y="${y - 6}" text-anchor="middle">${d.count}</text>`;
    svg += `<text class="axis" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${i === days.length - 1 ? 'Today' : names[i]}</text>`;
  });
  el.innerHTML = svg + '</svg>';
  const tip = $('tip');
  el.querySelectorAll('.hit').forEach((hit) => {
    hit.addEventListener('mouseenter', () => {
      const i = Number(hit.dataset.i);
      const d = days[i];
      el.querySelectorAll('.bar').forEach((b) => b.classList.toggle('on', b.dataset.i === String(i)));
      tip.innerHTML = `${new Date(d.day).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}<br><b>${d.count}</b> grab${d.count === 1 ? '' : 's'}`;
      tip.hidden = false;
      const card = el.getBoundingClientRect();
      const parent = el.parentElement.getBoundingClientRect();
      tip.style.left = `${card.left - parent.left + i * slot + slot / 2}px`;
      tip.style.top = `${card.top - parent.top + 8}px`;
    });
    hit.addEventListener('mouseleave', () => { tip.hidden = true; el.querySelectorAll('.bar').forEach((b) => b.classList.remove('on')); });
  });
}

// ---------- history ----------

function filtered() {
  const q = $('q').value.trim().toLowerCase();
  return data.list.filter((e) => {
    if (filter === 'fav' && !e.favorite) return false;
    if (filter === 'fast' && e.model === 'smart') return false;
    if (filter === 'smart' && e.model !== 'smart') return false;
    return !q || e.question.toLowerCase().includes(q) || (e.answer || '').toLowerCase().includes(q);
  });
}

const STAR = '<svg class="star" viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>';

function renderList() {
  const items = filtered();
  $('histList').innerHTML = items.length ? items.map((e) => `
    <button class="hitem ${e.id === selected ? 'active' : ''}" data-id="${e.id}">
      <div class="th" style="background-image:url('${e.thumb}')"></div>
      <div class="tx"><div class="qq">${esc(e.question)}</div><div class="aa">${esc(snippet(e.answer))}</div></div>
      <div class="side-info">${e.favorite ? STAR : ''}<span>${ago(e.ts)}</span></div>
    </button>`).join('')
    : `<div class="empty">${data.list.length ? 'Nothing matches.' : 'Your grabs will show up here.'}</div>`;
  $('navCount').textContent = data.list.length || '';
}

async function openEntry(id) {
  selected = id;
  renderList();
  const e = await window.grab.invoke('dash:entry', id);
  if (!e) { $('histDetail').innerHTML = '<div class="empty-detail">This grab was deleted.</div>'; return; }
  const turns = e.turns.length ? e.turns : [{ q: e.question, a: '' }];
  $('histDetail').innerHTML = `
    ${e.image ? `<img class="d-img" src="${e.image}" alt="">` : ''}
    <div class="d-actions">
      <button class="btn btn-accent" data-act="reopen"><svg viewBox="0 0 24 24"><path d="M4 12h12M12 6l6 6-6 6"/></svg>Continue</button>
      <button class="btn" data-act="copy"><svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>Copy answer</button>
      <button class="btn ${e.favorite ? 'on' : ''}" data-act="fav"><svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>${e.favorite ? 'Starred' : 'Star'}</button>
      <button class="btn ghost danger" data-act="del"><svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>Delete</button>
    </div>
    <div class="d-meta">${new Date(e.ts).toLocaleString()} · ${e.model === 'smart' ? 'Smart (Sonnet)' : 'Fast (Haiku)'} · ${e.width}×${e.height}px${turns[0].firstMs != null ? ` · first words ${fmtMs(turns[0].firstMs)}` : ''}</div>
    ${turns.map((t) => `<div class="d-turn"><div class="d-q">${esc(t.q)}</div><div class="md">${md(t.a)}</div></div>`).join('')}`;
  $('histDetail').dataset.id = id;
  $('histDetail').dataset.answer = turns[turns.length - 1].a || '';
}

$('histList').addEventListener('click', (e) => { const b = e.target.closest('.hitem'); if (b) openEntry(b.dataset.id); });
$('recent').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) { show('history'); openEntry(b.dataset.open); } });
$('q').addEventListener('input', renderList);
$('filter').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  for (const x of $('filter').children) x.classList.toggle('active', x === b);
  renderList();
});
$('histDetail').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = $('histDetail').dataset.id;
  const act = b.dataset.act;
  if (act === 'reopen') { window.grab.send('dash:reopen', id); toast('Opened in an answer window'); }
  if (act === 'copy') { window.grab.send('clipboard:write', $('histDetail').dataset.answer); toast('Answer copied'); }
  if (act === 'fav') { await window.grab.invoke('dash:favorite', id); await refresh(); openEntry(id); }
  if (act === 'del') {
    if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.lastChild.textContent = 'Click again to delete'; return; }
    await window.grab.invoke('dash:delete', id);
    selected = null;
    $('histDetail').innerHTML = '<div class="empty-detail">Deleted.</div>';
    await refresh();
  }
});
$('clearAll').addEventListener('click', async () => {
  const b = $('clearAll');
  if (!data.list.length) return;
  if (b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = `Delete all ${data.list.length}?`; setTimeout(() => { b.dataset.armed = ''; b.textContent = 'Clear all'; }, 4000); return; }
  await window.grab.invoke('dash:clear');
  b.dataset.armed = ''; b.textContent = 'Clear all';
  selected = null;
  $('histDetail').innerHTML = '<div class="empty-detail">History cleared.</div>';
  await refresh();
});

// ---------- settings ----------

function setSeg(id, attr, value) { for (const b of $(id).children) b.classList.toggle('active', b.dataset[attr] === value); }
function setSwitch(id, v) { $(id).classList.toggle('on', !!v); }
function setRange(v) {
  const pct = Math.round(v * 100);
  $('opacity').value = pct;
  $('opacity').style.setProperty('--p', `${((pct - 40) / 60) * 100}%`);
  $('opval').textContent = `${pct}%`;
}

function renderSettings() {
  const s = data.settings;
  setSeg('backend', 'backend', form.backend);
  setSeg('model', 'model', form.model);
  setSwitch('objects', form.objects);
  setSwitch('history', form.history);
  setSwitch('login', form.openAtLogin);
  setRange(form.opacity);
  $('shortcut').textContent = recording ? 'Press keys...' : pretty(form.shortcut).join(' + ');
  $('shortcut').classList.toggle('rec', recording);
  const isApi = form.backend === 'api';
  $('connRow').hidden = isApi;
  $('keyRow').hidden = !isApi;
  paintConn($('setConn'), { ...s, backend: form.backend });
  $('signin').hidden = isApi || !s.claudeFound || s.claudeLoggedIn;
  $('connNote').textContent = isApi
    ? (s.hasKey ? (s.keyFromEnv ? 'Using ANTHROPIC_API_KEY from the environment.' : 'A key is saved in your OS keychain. Paste a new one to replace it.') : 'Billed per request to your Anthropic Console account. Stored encrypted in your OS keychain.')
    : 'Uses your Claude subscription through Claude Code. No API key needed. Tools, plugins and file access are switched off.';
  $('key').placeholder = s.hasKey ? 'Saved. Paste to replace.' : 'sk-ant-...';
}

function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.metaKey) mods.push(data.settings.platform === 'darwin' ? 'Command' : 'Super');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  if (!key || !mods.length) return null;
  return [...mods, key].join('+');
}

$('backend').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { form.backend = b.dataset.backend; renderSettings(); } });
$('model').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { form.model = b.dataset.model; renderSettings(); } });
for (const [id, k] of [['objects', 'objects'], ['history', 'history'], ['login', 'openAtLogin']]) {
  $(id).addEventListener('click', () => { form[k] = !form[k]; renderSettings(); });
}
$('opacity').addEventListener('input', () => { form.opacity = Number($('opacity').value) / 100; setRange(form.opacity); });
$('shortcut').addEventListener('click', () => { recording = true; renderSettings(); });
$('shortcut').addEventListener('blur', () => { recording = false; renderSettings(); });
$('resetkey').addEventListener('click', () => { form.shortcut = DEFAULT_SHORTCUT; renderSettings(); });
$('getkey').addEventListener('click', () => window.grab.send('open:console'));
$('signin').addEventListener('click', () => {
  window.grab.send('claude:login');
  $('setConn').querySelector('.txt').textContent = 'Finish signing in in the window that opened...';
  let tries = 0;
  const poll = setInterval(async () => {
    const s = await window.grab.invoke('settings:get');
    if (s.claudeLoggedIn || ++tries > 60) { clearInterval(poll); data.settings = s; renderSettings(); paintConn($('sideConn'), s); paintConn($('homeConn'), s); }
  }, 3000);
});
$('test').addEventListener('click', async () => {
  $('connNote').textContent = 'Testing...';
  const res = await window.grab.invoke('settings:test-key', $('key').value.trim());
  $('connNote').textContent = res.ok ? 'Key works.' : res.error;
  $('connNote').className = `note ${res.ok ? 'ok' : 'bad'}`;
});
$('saveBtn').addEventListener('click', async () => {
  const res = await window.grab.invoke('settings:save', { ...form, apiKey: $('key').value.trim() });
  const st = $('status');
  if (res.ok) {
    $('key').value = '';
    st.textContent = 'Saved.'; st.className = 'status';
    await refresh();
  } else { st.textContent = res.error; st.className = 'status bad'; }
});

window.addEventListener('keydown', (e) => {
  if (recording) {
    e.preventDefault();
    if (e.key === 'Escape') { recording = false; renderSettings(); return; }
    const acc = toAccelerator(e);
    if (acc) { form.shortcut = acc; recording = false; renderSettings(); $('status').textContent = 'Press Save changes to apply the new shortcut.'; }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); show('history'); $('q').focus(); }
});

// ---------- data ----------

async function refresh() {
  data = await window.grab.invoke('dash:data');
  const s = data.settings;
  form = { backend: s.backend, model: s.model, objects: s.objects, history: s.history, openAtLogin: s.openAtLogin, opacity: s.opacity, shortcut: s.shortcut };
  const keys = pretty(s.shortcut);
  $('sideKey').textContent = keys.join(' ');
  $('heroKey1').textContent = keys.slice(0, -1).join(' + ') || keys[0];
  $('heroKey2').textContent = keys[keys.length - 1];
  paintConn($('sideConn'), s);
  paintConn($('homeConn'), s);
  renderHome();
  renderList();
  renderSettings();
}

window.grab.on('dash:tab', show);
window.grab.on('dash:changed', async () => { await refresh(); if (selected) openEntry(selected); });
window.addEventListener('resize', () => data.stats && renderChart(data.stats.days));

show(tab);
refresh();
