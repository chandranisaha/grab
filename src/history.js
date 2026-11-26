const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const MAX = 500;
let entries = null;

const dir = () => path.join(app.getPath('userData'), 'history');
const file = () => path.join(app.getPath('userData'), 'history.json');

function load() {
  if (entries) return entries;
  try { entries = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { entries = []; }
  if (!Array.isArray(entries)) entries = [];
  return entries;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(entries));
  }, 200);
}

function thumbOf(dataUrl) {
  const img = nativeImage.createFromDataURL(dataUrl);
  const { width, height } = img.getSize();
  const k = Math.min(1, 320 / Math.max(width, height));
  const small = img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' });
  return { thumb: `data:image/jpeg;base64,${small.toJPEG(82).toString('base64')}`, width, height };
}

function create({ image, question, model, backend }) {
  load();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), `${id}.png`), Buffer.from(image.split(',')[1], 'base64'));
  const { thumb, width, height } = thumbOf(image);
  const entry = { id, ts: Date.now(), model, backend, question, thumb, width, height, turns: [], favorite: false };
  entries.unshift(entry);
  for (const old of entries.splice(MAX)) remove(old.id, true);
  save();
  return entry;
}

function addTurn(id, turn) {
  const e = load().find((x) => x.id === id);
  if (!e) return;
  e.turns.push(turn);
  e.updated = Date.now();
  save();
}

function get(id) {
  const e = load().find((x) => x.id === id);
  if (!e) return null;
  let image = null;
  try { image = `data:image/png;base64,${fs.readFileSync(path.join(dir(), `${id}.png`)).toString('base64')}`; } catch { /* missing */ }
  return { ...e, image };
}

function remove(id, already) {
  if (!already) { load(); entries = entries.filter((x) => x.id !== id); save(); }
  try { fs.unlinkSync(path.join(dir(), `${id}.png`)); } catch { /* missing */ }
}

function toggleFavorite(id) {
  const e = load().find((x) => x.id === id);
  if (e) { e.favorite = !e.favorite; save(); }
  return e?.favorite;
}

function clear() {
  load();
  for (const e of entries) remove(e.id, true);
  entries = [];
  save();
}

function list() {
  return load().map(({ id, ts, model, backend, question, thumb, width, height, turns, favorite }) => ({
    id, ts, model, backend, question, thumb, width, height, favorite,
    answer: turns[0]?.a || '', turnCount: turns.length,
    firstMs: turns[0]?.firstMs ?? null,
  }));
}

function stats() {
  const all = load();
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = dayStart - 6 * 864e5;
  const firsts = all.flatMap((e) => e.turns.map((t) => t.firstMs)).filter((v) => typeof v === 'number');
  firsts.sort((a, b) => a - b);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const s = dayStart - i * 864e5;
    days.push({ day: s, count: all.filter((e) => e.ts >= s && e.ts < s + 864e5).length });
  }
  return {
    total: all.length,
    today: all.filter((e) => e.ts >= dayStart).length,
    week: all.filter((e) => e.ts >= weekStart).length,
    followups: all.reduce((n, e) => n + Math.max(0, e.turns.length - 1), 0),
    medianFirstMs: firsts.length ? firsts[Math.floor(firsts.length / 2)] : null,
    fast: all.filter((e) => e.model !== 'smart').length,
    smart: all.filter((e) => e.model === 'smart').length,
    days,
  };
}

module.exports = { create, addTurn, get, remove, clear, list, stats, toggleFavorite };
