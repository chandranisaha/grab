const CHIPS = [
  { label: 'Explain', prompt: 'Explain this.' },
  { label: 'In 1-2 lines', prompt: 'What is this? Answer in one or two short lines only.' },
  { label: 'Solve', prompt: 'Solve this. Show the key steps, then the final answer.' },
  { label: 'Fix this error', prompt: 'What does this error mean and how do I fix it?' },
  { label: 'Summarize', prompt: 'Summarize this.' },
  { label: 'Translate', prompt: 'Translate this into English.' },
  { label: 'Copy text', prompt: 'Transcribe the exact text in this image. Return only the text.' },
];
const MAX_EDGE = 1500;
const DIM = 'rgba(10, 4, 22, 0.5)';
const MIN_OBJ_W = 14;
const MIN_OBJ_H = 10;

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
let accent = '#a855f7';
let objWindows = [];
const elements = new Map();
let hover = null;
let pointer = null;
let pixels = null;

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
const area = (r) => r.width * r.height;
const contains = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

function clip(r) {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return {
    x, y,
    width: Math.max(0, Math.min(window.innerWidth, r.x + r.width) - x),
    height: Math.max(0, Math.min(window.innerHeight, r.y + r.height) - y),
  };
}

// ---------- object detection ----------

function windowAt(x, y) {
  const hit = objWindows.find((w) => contains(w, x, y) && w.cls !== 'Progman' && w.cls !== 'WorkerW');
  return hit || null;
}

function loadElements(w) {
  if (!w || elements.has(w.hwnd)) return;
  elements.set(w.hwnd, null);
  window.grab.invoke('overlay:elements', w.hwnd).then((list) => {
    elements.set(w.hwnd, Array.isArray(list) ? list : []);
    if (pointer && !drawing) updateHover(pointer.x, pointer.y);
  }).catch(() => elements.set(w.hwnd, []));
}

function labelOf(kind, name) {
  const k = (kind || '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const n = (name || '').trim();
  if (n && k) return `${k} · ${n.length > 40 ? n.slice(0, 39) + '…' : n}`;
  return n || k || 'Object';
}

function objectAt(x, y) {
  const w = windowAt(x, y);
  if (!w) {
    return objWindows.length ? { rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, label: 'Whole screen' } : null;
  }
  loadElements(w);
  const winRect = clip(w);
  const list = elements.get(w.hwnd);
  let best = null;
  if (list) {
    for (const el of list) {
      if (el.width < MIN_OBJ_W || el.height < MIN_OBJ_H || !contains(el, x, y)) continue;
      const r = clip(el);
      if (area(r) >= area(winRect) * 0.98) continue;
      if (!best || area(r) < area(best.rect)) best = { rect: r, label: labelOf(el.kind, el.name) };
    }
  }
  return best || { rect: winRect, label: labelOf('Window', w.title) };
}

function grayPixels() {
  if (pixels || !img) return pixels;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, c.width, c.height).data;
  const g = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  pixels = { g, w: c.width, h: c.height };
  return pixels;
}

function edgeBox(cssX, cssY) {
  const P = grayPixels();
  if (!P) return null;
  const s = scale();
  const { g, w, h } = P;
  const T = 22;
  const edge = (x, y) => {
    if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) return true;
    const i = y * w + x;
    return Math.abs(g[i + 1] - g[i - 1]) + Math.abs(g[i + w] - g[i - w]) > T;
  };
  const cx = Math.round(cssX * s);
  const cy = Math.round(cssY * s);
  let l = cx - 3; let r = cx + 3; let t = cy - 3; let b = cy + 3;
  const done = { l: false, r: false, t: false, b: false };
  const col = (x) => { let n = 0; for (let y = t; y <= b; y++) if (edge(x, y)) n++; return n / (b - t + 1); };
  const row = (y) => { let n = 0; for (let x = l; x <= r; x++) if (edge(x, y)) n++; return n / (r - l + 1); };
  const big = (len) => len >= 16;
  for (let iter = 0; iter < 3000 && !(done.l && done.r && done.t && done.b); iter++) {
    if (!done.l) { if (l <= 1) done.l = true; else if (big(b - t) && col(l - 1) > 0.6) done.l = true; else l -= 2; }
    if (!done.r) { if (r >= w - 2) done.r = true; else if (big(b - t) && col(r + 1) > 0.6) done.r = true; else r += 2; }
    if (!done.t) { if (t <= 1) done.t = true; else if (big(r - l) && row(t - 1) > 0.6) done.t = true; else t -= 2; }
    if (!done.b) { if (b >= h - 2) done.b = true; else if (big(r - l) && row(b + 1) > 0.6) done.b = true; else b += 2; }
  }
  const rect = { x: l / s, y: t / s, width: (r - l) / s, height: (b - t) / s };
  if (rect.width < 24 || rect.height < 18) return null;
  return rect;
}

function refine(obj, x, y) {
  const screenArea = window.innerWidth * window.innerHeight;
  if (obj && area(obj.rect) < screenArea * 0.3) return obj;
  const box = edgeBox(x, y);
  if (box && (!obj || area(box) < area(obj.rect) * 0.8)) return { rect: box, label: 'Detected object' };
  return obj || { rect: { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, label: 'Whole screen' };
}

function updateHover(x, y) {
  const next = objectAt(x, y);
  const same = hover && next && hover.label === next.label && hover.rect.x === next.rect.x && hover.rect.y === next.rect.y && hover.rect.width === next.rect.width;
  if (same) return;
  hover = next;
  render();
}

// ---------- drawing helpers ----------

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
  return clip({ x: Math.min(...xs) - 4, y: Math.min(...ys) - 4, width: Math.max(...xs) - Math.min(...xs) + 8, height: Math.max(...ys) - Math.min(...ys) + 8 });
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
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, (pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last.x, last.y);
  if (close) ctx.closePath();
}

function glow(fn, width = 3) {
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = accent;
  ctx.shadowColor = accent;
  ctx.shadowBlur = 16;
  ctx.lineWidth = width;
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
  ctx.roundRect(r.x, r.y, r.width, r.height, Math.min(radius, r.width / 2, r.height / 2));
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

function tag(r, text) {
  ctx.save();
  ctx.font = '600 12px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 18;
  const h = 22;
  let x = r.x;
  let y = r.y - h - 6;
  if (y < 4) y = r.y + 6;
  x = Math.min(Math.max(4, x), window.innerWidth - w - 4);
  ctx.fillStyle = 'rgba(28, 14, 48, 0.92)';
  ctx.strokeStyle = accent;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#f3e8ff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 9, y + h / 2 + 0.5);
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
    if (loop) glow(() => strokePath(loop, true));
    else glow(() => roundRect(sel, 6));
    drawHandles(sel);
  }

  if (hover && !sel) {
    bright(hover.rect);
    ctx.save();
    ctx.setLineDash([6, 4]);
    glow(() => roundRect(hover.rect, 6), 2);
    ctx.restore();
    tag(hover.rect, hover.label);
  } else if (hover && sel && !overAsk()) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.setLineDash([5, 5]);
    glow(() => roundRect(hover.rect, 6), 1.5);
    ctx.restore();
  }
}

function overAsk() {
  if (ask.hidden || !pointer) return false;
  const r = ask.getBoundingClientRect();
  return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
}

function drawHandles(r) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
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

// ---------- selection & submit ----------

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
  sel = clip(r);
  loop = path;
  hover = null;
  render();
  drawThumb(sel);
  setChip(-1);
  placeAsk(sel);
  input.focus();
}

function selectWholeScreen() {
  window.grab.send('overlay:selecting');
  fadeHint();
  finishSelection({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }, null);
}

function fadeHint() { hint.classList.add('gone'); }

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
  hover = null; pointer = null; pixels = null; objWindows = []; elements.clear();
  hideAsk();
  input.value = '';
  setChip(-1);
  clearTimeout(hintTimer);
  hint.classList.remove('show', 'gone');
  render();
}

function cancel() { window.grab.send('overlay:cancel'); }

stage.addEventListener('mousedown', (e) => {
  if (e.button === 2) return cancel();
  if (e.button !== 0 || !img) return;
  fadeHint();
  drawing = true;
  shift = e.shiftKey;
  points = [{ x: e.clientX, y: e.clientY }];
});

window.addEventListener('mousemove', (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  if (!drawing) {
    if (img) updateHover(e.clientX, e.clientY);
    return;
  }
  shift = e.shiftKey;
  points.push({ x: Math.min(Math.max(0, e.clientX), window.innerWidth), y: Math.min(Math.max(0, e.clientY), window.innerHeight) });
  if (pathLength(points) > 6 && (sel || hover)) {
    hideAsk();
    sel = null; loop = null; hover = null;
    window.grab.send('overlay:selecting');
  }
  render();
});

window.addEventListener('mouseup', (e) => {
  if (!drawing || e.button !== 0) return;
  drawing = false;
  const len = pathLength(points);
  window.grab.send('overlay:selecting');
  if (len < 6) {
    const obj = refine(objectAt(e.clientX, e.clientY), e.clientX, e.clientY);
    points = [];
    finishSelection(obj.rect, null);
    return;
  }
  let r;
  let path = null;
  if (shift || isStraight(points)) r = rectFrom(points[0], points[points.length - 1]);
  else { path = smooth(points); r = bbox(path); }
  points = [];
  if (r.width < 10 || r.height < 10) { sel = null; render(); return; }
  finishSelection(r, path);
});

stage.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && !input.value) { e.preventDefault(); selectWholeScreen(); return; }
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
      hintTimer = setTimeout(fadeHint, 2200);
    }
    window.grab.send('overlay:ready', data.displayId);
  };
  next.onerror = () => window.grab.send('overlay:ready', data.displayId);
  next.src = data.image;
});

window.grab.on('overlay:objects', (list) => {
  objWindows = Array.isArray(list) ? list : [];
  if (pointer && !drawing) {
    loadElements(windowAt(pointer.x, pointer.y));
    updateHover(pointer.x, pointer.y);
  }
});

window.grab.on('overlay:reset', reset);
window.grab.on('overlay:clear-selection', () => { sel = null; loop = null; hover = null; hideAsk(); render(); });

accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || accent;
resize();
