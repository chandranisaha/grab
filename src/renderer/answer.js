const { marked, katex, hljs } = window.Vendor;

const params = new URLSearchParams(location.search);
const frozen = params.get('glass') !== 'native';
if (frozen) document.body.classList.add('frozen');
const backdropEl = document.getElementById('backdrop');
let backdrop = null;

function placeBackdrop(win) {
  if (!frozen) return;
  const ok = !!(backdrop && win);
  document.body.classList.toggle('no-backdrop', !ok);
  if (!ok) { backdropEl.style.backgroundImage = 'none'; return; }
  const pad = 80;
  backdropEl.style.backgroundSize = `${backdrop.bounds.width}px ${backdrop.bounds.height}px`;
  backdropEl.style.backgroundPosition = `${backdrop.bounds.x - win.x + pad}px ${backdrop.bounds.y - win.y + pad}px`;
}

const $ = (id) => document.getElementById(id);
const log = $('log');
const scroller = $('scroll');
const follow = $('follow');
const go = $('go');
const pinBtn = $('pin');
const opacity = $('opacity');
const toastEl = $('toast');

let turns = [];
let current = null;
let busy = false;
let pinned = false;
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
        body = language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : esc(text);
      } catch { body = esc(text); }
      return `<div class="code"><div class="code-head"><span>${esc(language || 'text')}</span><button data-copy>Copy</button></div><pre><code class="hljs">${body}</code></pre></div>`;
    },
  },
});

function renderMath(tex, display) {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html', strict: 'ignore' });
  } catch { return esc(tex); }
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
  const html = marked.parse(prepared);
  return html.replace(/@@GRABMATH(\d+)@@/g, (_, n) => math[Number(n)] || '');
}

function nearBottom() {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
}

function paint(turn, { cursor = false } = {}) {
  const stick = nearBottom();
  if (turn.error) {
    turn.answerEl.innerHTML = '';
    if (turn.text) turn.answerEl.innerHTML = renderMarkdown(turn.text);
    const box = document.createElement('div');
    box.className = 'err';
    box.innerHTML = `<span>${esc(turn.error.message)}</span>`;
    const btn = document.createElement('button');
    btn.textContent = turn.error.needsKey ? 'Open settings' : 'Retry';
    btn.addEventListener('click', () => {
      if (turn.error.needsKey) window.grab.send('settings:open');
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
  if (stick) scroller.scrollTop = scroller.scrollHeight;
}

function queuePaint() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (current) paint(current, { cursor: busy });
  });
}

function addTurn(question) {
  const el = document.createElement('section');
  el.className = 'turn';
  const q = document.createElement('div');
  q.className = 'q';
  q.textContent = question;
  const a = document.createElement('div');
  a.className = 'md';
  el.append(q, a);
  log.appendChild(el);
  const turn = { question, text: '', error: null, el, answerEl: a };
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

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1400);
}

function copyText(text, msg = 'Copied') {
  window.grab.send('clipboard:write', text);
  toast(msg);
}

function lastAnswer() {
  for (let i = turns.length - 1; i >= 0; i--) if (turns[i].text) return turns[i].text;
  return '';
}

function transcript() {
  return turns.filter((t) => t.text).map((t) => `**Q:** ${t.question}\n\n${t.text}`).join('\n\n---\n\n');
}

function setPinned(v) {
  pinned = v;
  pinBtn.classList.toggle('on', v);
  pinBtn.title = v ? 'Unpin (Ctrl+P)' : 'Pin (Ctrl+P)';
  window.grab.send('answer:pin', v);
  if (v) wake(); else armIdle();
}

function setSlider(v) {
  const pct = Math.round(v * 100);
  opacity.value = pct;
  opacity.style.setProperty('--p', `${((pct - 40) / 60) * 100}%`);
}

function armIdle() {
  clearTimeout(idleTimer);
  if (pinned || busy) return;
  idleTimer = setTimeout(() => {
    if (pinned || busy || document.activeElement === follow && follow.value) return;
    faded = true;
    window.grab.send('answer:idle');
  }, 10000);
}

function wake() {
  if (faded) { faded = false; window.grab.send('answer:active'); }
  armIdle();
}

$('close').addEventListener('click', () => window.grab.send('answer:close'));
pinBtn.addEventListener('click', () => setPinned(!pinned));
$('copy').addEventListener('click', () => { const t = lastAnswer(); if (t) copyText(t, 'Answer copied'); });
$('save').addEventListener('click', async () => {
  const md = transcript();
  if (!md) return;
  const res = await window.grab.invoke('answer:save', md);
  if (res?.ok) toast('Saved note');
});
opacity.addEventListener('input', () => {
  const v = Number(opacity.value) / 100;
  setSlider(v);
  window.grab.send('answer:opacity', v);
});
go.addEventListener('click', () => (busy ? window.grab.send('answer:stop') : sendFollowUp()));
follow.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); sendFollowUp(); }
});

log.addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    const code = copy.closest('.code').querySelector('code').innerText;
    copyText(code, 'Code copied');
    return;
  }
  const a = e.target.closest('a[href]');
  if (a) { e.preventDefault(); window.open(a.href); }
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') { e.preventDefault(); window.grab.send('answer:close'); return; }
  if (mod && e.key.toLowerCase() === 'p') { e.preventDefault(); setPinned(!pinned); return; }
  if (mod && e.key.toLowerCase() === 'c') {
    const selected = String(window.getSelection() || '');
    const inField = document.activeElement === follow && follow.selectionStart !== follow.selectionEnd;
    if (!selected && !inField) { e.preventDefault(); const t = lastAnswer(); if (t) copyText(t, 'Answer copied'); }
  }
});

['mousemove', 'mousedown', 'keydown', 'wheel'].forEach((ev) => window.addEventListener(ev, wake, { passive: true }));
document.addEventListener('mouseenter', wake);

window.grab.on('answer:open', (data) => {
  log.innerHTML = '';
  turns = [];
  current = null;
  faded = false;
  pinned = false;
  pinBtn.classList.remove('on');
  $('thumb').src = data.image;
  backdrop = data.backdrop;
  backdropEl.style.backgroundImage = backdrop ? `url("${backdrop.image}")` : 'none';
  placeBackdrop(data.bounds);
  $('badge').textContent = data.model === 'smart' ? 'Smart' : 'Fast';
  setSlider(data.opacity);
  follow.value = '';
  addTurn(data.question);
});

window.grab.on('answer:start', () => {
  if (!current) return;
  current.text = '';
  current.error = null;
  setBusy(true);
  paint(current);
});

window.grab.on('answer:delta', ({ delta }) => {
  if (!current) return;
  current.text += delta;
  queuePaint();
});

window.grab.on('answer:done', () => {
  setBusy(false);
  if (current) paint(current);
});

window.grab.on('answer:error', (err) => {
  setBusy(false);
  if (!current) return;
  if (/abort/i.test(err.message) && current.text) { paint(current); return; }
  current.error = err;
  paint(current);
});

window.grab.on('answer:bounds', placeBackdrop);

window.grab.on('answer:reset', () => {
  setBusy(false);
  backdrop = null;
  backdropEl.style.backgroundImage = 'none';
  clearTimeout(idleTimer);
  log.innerHTML = '';
  turns = [];
  current = null;
});
