const { marked, katex, hljs } = window.Vendor;

const params = new URLSearchParams(location.search);
const frozen = params.get('glass') !== 'native';
if (frozen) document.body.classList.add('frozen');

const $ = (id) => document.getElementById(id);
const backdropEl = $('backdrop');
const log = $('log');
const scroller = $('scroll');
const follow = $('follow');
const go = $('go');
const pinBtn = $('pin');
const briefBtn = $('brief');
const menu = $('menu');
const opacity = $('opacity');
const toastEl = $('toast');
const modelEl = $('model');
const BRIEF_LABEL = 'Summary in 1-2 lines';

let backdrop = null;
let turns = [];
let current = null;
let busy = false;
let pinned = false;
let model = 'fast';
let image = null;
let renderQueued = false;
let idleTimer = null;
let faded = false;
let toastTimer = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    html({ text }) { return esc(text); },
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      let body;
      try {
        body = language && hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : esc(text);
      } catch { body = esc(text); }
      return `<div class="code"><div class="code-head"><span>${esc(language || 'text')}</span><button data-copy>Copy</button></div><pre><code class="hljs">${body}</code></pre></div>`;
    },
  },
});

function renderMath(tex, display) {
  try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore' }); } catch { return esc(tex); }
}

function renderMarkdown(src) {
  const math = [];
  const hold = (html) => `@@GRABMATH${math.push(html) - 1}@@`;
  const parts = src.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/g);
  const prepared = parts.map((part, i) => {
    if (i % 2 === 1) return part;
    return part
      .replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => hold(renderMath(t.trim(), true)))
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => hold(renderMath(t.trim(), true)))
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, t) => hold(renderMath(t.trim(), false)))
      .replace(/(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\w$])/g, (_, pre, t) => pre + hold(renderMath(t, false)));
  }).join('');
  return marked.parse(prepared).replace(/@@GRABMATH(\d+)@@/g, (_, n) => math[Number(n)] || '');
}

function placeBackdrop(win) {
  if (!frozen) return;
  const ok = !!(backdrop && win);
  document.body.classList.toggle('no-backdrop', !ok);
  if (!ok) { backdropEl.style.backgroundImage = 'none'; return; }
  const pad = 80;
  backdropEl.style.backgroundSize = `${backdrop.bounds.width}px ${backdrop.bounds.height}px`;
  backdropEl.style.backgroundPosition = `${backdrop.bounds.x - win.x + pad}px ${backdrop.bounds.y - win.y + pad}px`;
}

const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;

function paint(turn, { cursor = false } = {}) {
  const stick = nearBottom();
  if (turn.error) {
    turn.answerEl.innerHTML = turn.text ? renderMarkdown(turn.text) : '';
    const box = document.createElement('div');
    box.className = 'err';
    box.innerHTML = `<span>${esc(turn.error.message)}</span>`;
    const btn = document.createElement('button');
    btn.textContent = turn.error.needsKey ? 'Open settings' : turn.error.needsLogin ? 'Sign in' : 'Retry';
    btn.addEventListener('click', () => {
      if (turn.error.needsKey) window.grab.send('settings:open');
      else if (turn.error.needsLogin) { window.grab.send('claude:login'); btn.textContent = 'Retry'; turn.error.needsLogin = false; }
      else retry(turn);
    });
    box.appendChild(btn);
    turn.answerEl.appendChild(box);
  } else if (!turn.text) {
    turn.answerEl.innerHTML = '<div class="thinking"><i></i><i></i><i></i></div>';
  } else {
    turn.answerEl.innerHTML = renderMarkdown(turn.text);
    if (cursor) {
      const last = turn.answerEl.lastElementChild;
      const target = last && /^(P|LI|H\d)$/.test(last.tagName) ? last : (last?.querySelector('li:last-child') || null);
      if (target) target.classList.add('cursor');
    }
  }
  turn.metaEl.textContent = turn.meta || '';
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

function queuePaint() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; if (current) paint(current, { cursor: busy }); });
}

function addTurn(question, { brief = false, withImage = false, text = '', meta = '' } = {}) {
  const el = document.createElement('section');
  el.className = brief ? 'turn brief' : 'turn';
  const q = document.createElement('div');
  q.className = 'q';
  if (withImage && image) { const im = document.createElement('img'); im.src = image; q.appendChild(im); }
  const span = document.createElement('span');
  span.textContent = question;
  q.appendChild(span);
  const a = document.createElement('div');
  a.className = 'md';
  const m = document.createElement('div');
  m.className = 'meta';
  el.append(q, a, m);
  log.appendChild(el);
  const turn = { question, text, error: null, el, answerEl: a, metaEl: m, meta, brief };
  turns.push(turn);
  current = turn;
  paint(turn);
  scroller.scrollTop = scroller.scrollHeight;
  return turn;
}

function setBusy(v) {
  busy = v;
  go.classList.toggle('busy', v);
  go.title = v ? 'Stop' : 'Send (Enter)';
  briefBtn.disabled = v || !lastAnswer();
  if (v) wake(); else armIdle();
}

function retry(turn) {
  turn.error = null;
  turn.text = '';
  paint(turn);
  window.grab.send('answer:retry');
}

function sendFollowUp() {
  const q = follow.value.trim();
  if (!q || busy) return;
  follow.value = '';
  addTurn(q);
  window.grab.send('answer:followup', q);
}

function brief() {
  if (busy || !lastAnswer()) return;
  addTurn(BRIEF_LABEL, { brief: true });
  window.grab.send('answer:brief');
}

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
}

function copyText(text, msg = 'Copied') { window.grab.send('clipboard:write', text); toast(msg); }

function lastAnswer() {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].text && !turns[i].error) return turns[i].text;
  return '';
}

const transcript = () => turns.filter((t) => t.text).map((t) => `**Q:** ${t.question}\n\n${t.text}`).join('\n\n---\n\n');

function setPinned(v) {
  pinned = v;
  pinBtn.classList.toggle('on', v);
  document.body.classList.toggle('pinned', v);
  pinBtn.title = v ? 'Unpin (Ctrl+P)' : 'Pin (Ctrl+P)';
  window.grab.send('answer:pin', v);
  toast(v ? 'Pinned: stays on top, never fades, new grabs open beside it' : 'Unpinned');
  if (v) wake(); else armIdle();
}

function setModel(m, notify) {
  model = m === 'smart' ? 'smart' : 'fast';
  for (const b of modelEl.children) b.classList.toggle('active', b.dataset.model === model);
  if (notify) { window.grab.send('answer:model', model); toast(model === 'smart' ? 'Next reply uses Smart (Sonnet)' : 'Next reply uses Fast (Haiku)'); }
}

function setSlider(v) {
  const pct = Math.round(v * 100);
  opacity.value = pct;
  opacity.style.setProperty('--p', `${((pct - 40) / 60) * 100}%`);
  $('opval').textContent = `${pct}%`;
}

function armIdle() {
  clearTimeout(idleTimer);
  if (pinned || busy) return;
  idleTimer = setTimeout(() => {
    if (pinned || busy || !menu.hidden || (document.activeElement === follow && follow.value)) return;
    faded = true;
    window.grab.send('answer:idle');
  }, 10000);
}

function wake() {
  if (faded) { faded = false; window.grab.send('answer:active'); }
  armIdle();
}

const toggleMenu = (show = menu.hidden) => { menu.hidden = !show; $('more').classList.toggle('on', show); };

$('brand').addEventListener('click', () => window.grab.send('dashboard:open', 'home'));
$('close').addEventListener('click', () => window.grab.send('answer:close'));
pinBtn.addEventListener('click', () => setPinned(!pinned));
briefBtn.addEventListener('click', brief);
$('copy').addEventListener('click', () => { const t = lastAnswer(); if (t) copyText(t, 'Answer copied'); });
$('more').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
modelEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b.dataset.model !== model) setModel(b.dataset.model, true); });
document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target)) toggleMenu(false); });

menu.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  toggleMenu(false);
  const act = b.dataset.act;
  if (act === 'grab') window.grab.send('answer:grab');
  if (act === 'dashboard') window.grab.send('dashboard:open', 'home');
  if (act === 'copyall') { const md = transcript(); if (md) copyText(md, 'Conversation copied'); }
  if (act === 'save') {
    const md = transcript();
    if (!md) return;
    const res = await window.grab.invoke('answer:save', md);
    if (res?.ok) toast('Saved note');
  }
});

opacity.addEventListener('input', () => {
  const v = Number(opacity.value) / 100;
  setSlider(v);
  window.grab.send('answer:opacity', v);
});
go.addEventListener('click', () => (busy ? window.grab.send('answer:stop') : sendFollowUp()));
follow.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendFollowUp(); } });

log.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { copyText(copy.closest('.code').querySelector('code').innerText, 'Code copied'); return; }
  const a = e.target.closest('a[href]');
  if (a) { e.preventDefault(); window.open(a.href); }
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { e.preventDefault(); if (!menu.hidden) toggleMenu(false); else window.grab.send('answer:close'); return; }
  if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); setPinned(!pinned); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); brief(); return; }
  if (mod && e.key.toLowerCase() === 'c') {
    const selected = String(window.getSelection() || '');
    const inField = document.activeElement === follow && follow.selectionStart !== follow.selectionEnd;
    if (!selected && !inField) { e.preventDefault(); const t = lastAnswer(); if (t) copyText(t, 'Answer copied'); }
  }
});

['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
document.addEventListener('mouseenter', wake);

const fmtMs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

window.grab.on('answer:open', (data) => {
  log.innerHTML = '';
  turns = [];
  current = null;
  faded = false;
  pinned = false;
  pinBtn.classList.remove('on');
  document.body.classList.remove('pinned');
  toggleMenu(false);
  image = data.image;
  setModel(data.model, false);
  setSlider(data.opacity);
  backdrop = data.backdrop;
  backdropEl.style.backgroundImage = backdrop ? `url("${backdrop.image}")` : 'none';
  placeBackdrop(data.bounds);
  follow.value = '';
  if (data.turns?.length) {
    data.turns.forEach((t, i) => {
      const turn = addTurn(t.q, { brief: t.q === BRIEF_LABEL, withImage: i === 0, text: t.a, meta: t.firstMs != null ? `${t.model === 'smart' ? 'Smart' : 'Fast'} · first words ${fmtMs(t.firstMs)}` : '' });
      paint(turn);
    });
    setBusy(false);
  } else {
    addTurn(data.question, { withImage: true });
  }
});

window.grab.on('answer:start', () => {
  if (!current) return;
  current.text = '';
  current.error = null;
  current.meta = '';
  setBusy(true);
  paint(current);
});

window.grab.on('answer:delta', ({ delta }) => {
  if (!current) return;
  current.text += delta;
  queuePaint();
});

window.grab.on('answer:done', ({ firstMs, ms }) => {
  if (current) {
    current.meta = `${model === 'smart' ? 'Smart' : 'Fast'} · first words ${fmtMs(firstMs ?? ms)} · done in ${fmtMs(ms)}`;
    paint(current);
  }
  setBusy(false);
});

window.grab.on('answer:error', (err) => {
  if (current) {
    if (!(/abort/i.test(err.message) && current.text)) current.error = err;
    paint(current);
  }
  setBusy(false);
});

window.grab.on('answer:bounds', placeBackdrop);

window.grab.on('answer:reset', () => {
  setBusy(false);
  clearTimeout(idleTimer);
  backdrop = null;
  backdropEl.style.backgroundImage = 'none';
  log.innerHTML = '';
  turns = [];
  current = null;
});
