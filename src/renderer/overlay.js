const CHIPS = [
  { label: 'Explain', prompt: 'Explain this.' },
  { label: 'Solve', prompt: 'Solve this. Show the key steps, then the final answer.' },
  { label: 'Fix this error', prompt: 'What does this error mean and how do I fix it?' },
  { label: 'Summarize', prompt: 'Summarize this.' },
  { label: 'Translate', prompt: 'Translate this into English.' },
  { label: 'Copy text', prompt: 'Transcribe the exact text in this image. Return only the text.' },
];
const MAX_EDGE = 1500;
const DIM = 'rgba(0, 0, 0, 0.42)';

const stage = document.getElementById('stage');
const ctx = stage.getContext('2d');
const ask = document.getElementById('ask');
const input = document.getElementById('q');
const thumb = document.getElementById('thumb');
const hint = document.getElementById('hint');
const chipsEl = document.getElementById('chips');
const modelEl = document.getElementById('model');

let img = null;
let info = null;
let sel = null;
let loop = null;
let points = [];
let drawing = false;
let shift = false;
let activeChip = -1;
let model = 'fast';
let hintTimer = null;
let accent = '#0a84ff';

CHIPS.forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = c.label;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => { activeChip = i; submit(); });
  chipsEl.appendChild(b);
});
const tabHint = document.createElement('span');
tabHint.className = 'tab-hint';
tabHint.textContent = 'Tab to pick';
chipsEl.appendChild(tabHint);

modelEl.addEventListener('mousedown', (e) => e.preventDefault());
modelEl.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setModel(b.dataset.model);
});

function setModel(m) {
  model = m === 'smart' ? 'smart' : 'fast';
  for (const b of modelEl.children) b.classList.toggle('active', b.dataset.model === model);
}

function setChip(i) {
  activeChip = i;
  [...chipsEl.querySelectorAll('.chip')].forEach((b, j) => b.classList.toggle('active', j === i));
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  stage.width = Math.round(window.innerWidth * dpr);
  stage.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function scale() { return img ? img.naturalWidth / window.innerWidth : 1; }

function pathLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

function isStraight(pts) {
  if (pts.length < 2) return false;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = pathLength(pts);
  return len > 0 && Math.hypot(b.x - a.x, b.y - a.y) / len > 0.82;
}

function rectFrom(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

function bbox(pts) {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.max(0, Math.min(...xs) - 4);
  const y = Math.max(0, Math.min(...ys) - 4);
  return {
    x, y,
    width: Math.min(window.innerWidth, Math.max(...xs) + 4) - x,
    height: Math.min(window.innerHeight, Math.max(...ys) + 4) - y,
  };
}

function smooth(pts) {
  let out = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 2);
  for (let pass = 0; pass < 3; pass++) {
    const n = out.length;
    if (n < 3) break;
    out = out.map((p, i) => {
      const a = out[(i - 1 + n) % n];
      const c = out[(i + 1) % n];
      return { x: (a.x + p.x * 2 + c.x) / 4, y: (a.y + p.y * 2 + c.y) / 4 };
    });
  }
  return out;
}

function strokePath(pts, close) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2;
    const my = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  if (close) ctx.closePath();
}

function glow(fn) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 14;
  ctx.lineWidth = 3;
  fn();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1;
  fn();
  ctx.stroke();
  ctx.restore();
}

function roundRect(r, radius) {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, radius);
}

function bright(r) {
  if (!img || r.width < 1 || r.height < 1) return;
  const s = scale();
  ctx.save();
  roundRect(r, 6);
  ctx.clip();
  ctx.drawImage(img, r.x * s, r.y * s, r.width * s, r.height * s, r.x, r.y, r.width, r.height);
  ctx.restore();
}

function render() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  if (!img) return;
  ctx.drawImage(img, 0, 0, w, h);
  ctx.fillStyle = DIM;
  ctx.fillRect(0, 0, w, h);

  if (drawing && points.length > 1) {
    if (shift || isStraight(points)) {
      const r = rectFrom(points[0], points[points.length - 1]);
      bright(r);
      glow(() => roundRect(r, 6));
    } else {
      glow(() => strokePath(points, false));
    }
    return;
  }

  if (sel) {
    bright(sel);
    if (loop) {
      ctx.save();
      ctx.globalAlpha = 0.9;
      glow(() => strokePath(loop, true));
      ctx.restore();
    } else {
      glow(() => roundRect(sel, 6));
    }
    drawHandles(sel);
  }
}

function drawHandles(r) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  const l = Math.min(14, r.width / 3, r.height / 3);
  const c = [[r.x, r.y, 1, 1], [r.x + r.width, r.y, -1, 1], [r.x, r.y + r.height, 1, -1], [r.x + r.width, r.y + r.height, -1, -1]];
  for (const [x, y, dx, dy] of c) {
    ctx.beginPath();
    ctx.moveTo(x + dx * l, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * l);
    ctx.stroke();
  }
  ctx.restore();
}

function cropToDataUrl(r) {
  const s = scale();
  const sw = Math.max(1, Math.round(r.width * s));
  const sh = Math.max(1, Math.round(r.height * s));
  const k = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(sw * k));
  c.height = Math.max(1, Math.round(sh * k));
  const cx = c.getContext('2d');
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(img, Math.round(r.x * s), Math.round(r.y * s), sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/png');
}

function drawThumb(r) {
  const tx = thumb.getContext('2d');
  const s = scale();
  tx.clearRect(0, 0, thumb.width, thumb.height);
  const k = Math.min(thumb.width / r.width, thumb.height / r.height);
  const w = r.width * k;
  const h = r.height * k;
  tx.imageSmoothingQuality = 'high';
  tx.drawImage(img, r.x * s, r.y * s, r.width * s, r.height * s, (thumb.width - w) / 2, (thumb.height - h) / 2, w, h);
}

function placeAsk(r) {
  ask.hidden = false;
  const W = ask.offsetWidth;
  const H = ask.offsetHeight;
  const gap = 12;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = r.x + r.width + gap;
  let y = r.y;
  if (x + W > vw - gap) x = r.x - W - gap;
  if (x < gap) {
    x = Math.min(Math.max(gap, r.x), vw - W - gap);
    y = r.y + r.height + gap;
    if (y + H > vh - gap) y = r.y - H - gap;
    if (y < gap) y = r.y + r.height - H - gap;
  }
  y = Math.min(Math.max(gap, y), vh - H - gap);
  ask.style.left = `${Math.round(x)}px`;
  ask.style.top = `${Math.round(y)}px`;
  requestAnimationFrame(() => ask.classList.add('show'));
}

function hideAsk() {
  ask.classList.remove('show');
  ask.hidden = true;
}

function finishSelection(r, path) {
  sel = r;
  loop = path;
  render();
  drawThumb(r);
  setChip(-1);
  placeAsk(r);
  input.focus();
}

function fadeHint() {
  hint.classList.add('gone');
}

function submit() {
  if (!sel || !img) return;
  const typed = input.value.trim();
  const chip = activeChip >= 0 ? CHIPS[activeChip].prompt : '';
  const question = chip && typed ? `${chip}\n\n${typed}` : (typed || chip || 'Explain this.');
  const b = info.bounds;
  window.grab.send('overlay:submit', {
    image: cropToDataUrl(sel),
    question,
    model,
    displayId: info.displayId,
    rect: { x: Math.round(b.x + sel.x), y: Math.round(b.y + sel.y), width: Math.round(sel.width), height: Math.round(sel.height) },
  });
}

function reset() {
  img = null; sel = null; loop = null; points = []; drawing = false; info = null;
  hideAsk();
  input.value = '';
  setChip(-1);
  clearTimeout(hintTimer);
  hint.classList.remove('show', 'gone');
  render();
}

function cancel() {
  window.grab.send('overlay:cancel');
}

stage.addEventListener('mousedown', (e) => {
  if (e.button === 2) return cancel();
  if (e.button !== 0 || !img) return;
  fadeHint();
  hideAsk();
  sel = null; loop = null;
  drawing = true;
  shift = e.shiftKey;
  points = [{ x: e.clientX, y: e.clientY }];
  window.grab.send('overlay:selecting');
  render();
});

window.addEventListener('mousemove', (e) => {
  if (!drawing) return;
  shift = e.shiftKey;
  points.push({ x: Math.min(Math.max(0, e.clientX), window.innerWidth), y: Math.min(Math.max(0, e.clientY), window.innerHeight) });
  render();
});

window.addEventListener('mouseup', (e) => {
  if (!drawing || e.button !== 0) return;
  drawing = false;
  const len = pathLength(points);
  if (len < 6) {
    finishSelection({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, null);
    return;
  }
  let r;
  let path = null;
  if (shift || isStraight(points)) {
    r = rectFrom(points[0], points[points.length - 1]);
  } else {
    path = smooth(points);
    r = bbox(path);
  }
  points = [];
  if (r.width < 10 || r.height < 10) { sel = null; render(); return; }
  finishSelection(r, path);
});

stage.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
  if (!sel) return;
  if (e.key === 'Tab') {
    e.preventDefault();
    const n = CHIPS.length;
    setChip(e.shiftKey ? (activeChip <= 0 ? n - 1 : activeChip - 1) : (activeChip + 1) % n);
    return;
  }
  if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); return; }
  if (document.activeElement !== input && e.key.length === 1 && !e.ctrlKey && !e.metaKey) input.focus();
});

document.getElementById('send').addEventListener('mousedown', (e) => e.preventDefault());
document.getElementById('send').addEventListener('click', submit);
ask.addEventListener('mousedown', (e) => e.stopPropagation());

window.addEventListener('resize', resize);

window.grab.on('overlay:open', (data) => {
  reset();
  info = data;
  setModel(data.model);
  const next = new Image();
  next.onload = () => {
    img = next;
    resize();
    if (data.primary) {
      hint.classList.add('show');
      hintTimer = setTimeout(fadeHint, 1500);
    }
    window.grab.send('overlay:ready', data.displayId);
  };
  next.onerror = () => window.grab.send('overlay:ready', data.displayId);
  next.src = data.image;
});

window.grab.on('overlay:reset', reset);
window.grab.on('overlay:clear-selection', () => { sel = null; loop = null; hideAsk(); render(); });

accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent;
resize();
