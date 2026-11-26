const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor');

fs.mkdirSync(out, { recursive: true });
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'vendor-entry.js')],
  bundle: true, minify: true, format: 'iife', target: 'chrome130',
  outfile: path.join(out, 'vendor.js'),
});

const katexDist = path.join(root, 'node_modules', 'katex', 'dist');
fs.copyFileSync(path.join(katexDist, 'katex.min.css'), path.join(out, 'katex.min.css'));
fs.cpSync(path.join(katexDist, 'fonts'), path.join(out, 'fonts'), { recursive: true });
console.log('vendor bundle written to', path.relative(root, out));

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b; raw[i + 3] = a;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', require('zlib').deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

function appIcon(x, y, S = 512) {
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const r = S * 0.225;
  const m = S * 0.06;
  const dx = Math.max(m + r - x, 0, x - (S - m - r));
  const dy = Math.max(m + r - y, 0, y - (S - m - r));
  const inside = clamp(r - Math.hypot(dx, dy) + 0.5);
  if (inside <= 0) return [0, 0, 0, 0];
  const t = (x + y) / (2 * S);
  let R = 192 + (109 - 192) * t;
  let G = 132 + (40 - 132) * t;
  let B = 252 + (217 - 252) * t;
  const c = S / 2;
  const d = Math.hypot(x - c, y - c);
  const ring = clamp(1 - Math.abs(d - S * 0.24) / (S * 0.028));
  const dot = clamp(S * 0.06 - d + 0.5);
  const w = Math.max(ring, dot);
  R += (255 - R) * w; G += (255 - G) * w; B += (255 - B) * w;
  return [Math.round(R), Math.round(G), Math.round(B), Math.round(inside * 255)];
}

const buildDir = path.join(root, 'build');
fs.mkdirSync(buildDir, { recursive: true });
fs.writeFileSync(path.join(buildDir, 'icon.png'), png(512, (x, y) => appIcon(x, y)));
console.log('app icon written to build/icon.png');
