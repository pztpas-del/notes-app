// Draws the app icon (three linked notes) as PNG files without any libraries.
// Run: node dev/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [42, 36, 64], FG = [190, 172, 255], HI = [255, 255, 255];
const segDist = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function icon(size, maskable) {
  const s = size / 100;
  const scale = maskable ? 0.72 : 1; // keep the drawing inside the safe zone
  const P = ([x, y]) => [(50 + (x - 50) * scale) * s, (50 + (y - 50) * scale) * s];
  const nodes = [[30, 32, 9], [70, 40, 9], [44, 70, 11]].map(([x, y, r]) => [...P([x, y]), r * scale * s]);
  const lines = [[0, 1], [0, 2], [1, 2]];
  const radius = maskable ? 0 : 22 * s;
  return png(size, (x, y) => {
    // rounded square background with soft edge
    const qx = Math.max(Math.abs(x - size / 2) - (size / 2 - radius), 0);
    const qy = Math.max(Math.abs(y - size / 2) - (size / 2 - radius), 0);
    const outside = Math.hypot(qx, qy) - radius;
    const bgAlpha = Math.max(0, Math.min(1, 0.5 - outside));
    if (bgAlpha <= 0) return [0, 0, 0, 0];
    let c = BG;
    const lw = 3.2 * scale * s;
    const dl = Math.min(...lines.map(([a, b]) => segDist(x, y, nodes[a][0], nodes[a][1], nodes[b][0], nodes[b][1])));
    c = mix(c, FG, Math.max(0, Math.min(1, lw / 2 + 0.5 - dl)));
    nodes.forEach(([nx, ny, r], i) => {
      const d = Math.hypot(x - nx, y - ny);
      c = mix(c, i === 2 ? HI : FG, Math.max(0, Math.min(1, r + 0.5 - d)));
    });
    return [...c, Math.round(bgAlpha * 255)];
  });
}

const out = path.join(__dirname, '..', 'docs', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), icon(192, false));
fs.writeFileSync(path.join(out, 'icon-512.png'), icon(512, false));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), icon(512, true));
console.log('icons written to', out);
