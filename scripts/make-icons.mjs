// Generate placeholder PWA app icons (a simple baseball) with no image deps.
// Writes web/icon-192.png and web/icon-512.png. Re-run to regenerate.
//
//   node scripts/make-icons.mjs
import zlib from "zlib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

// --- minimal PNG (RGBA, 8-bit) encoder -------------------------------------
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  // rows prefixed with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- draw a baseball, supersampled 2x for smooth edges ---------------------
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const BG = hex("#0b1014");     // app theme background
const BALL = hex("#eef3f2");   // off-white
const SEAM = hex("#e0584f");   // red

function drawBall(size) {
  const SS = 2, S = size * SS;
  const c = S / 2, ballR = 0.36 * S, seamW = 0.028 * S;
  const aL = { x: c - 1.3 * ballR, y: c }, aR = { x: c + 1.3 * ballR, y: c };
  const AR = 1.3 * ballR;
  const buf = Buffer.alloc(S * S * 4);
  const dist = (x, y, p) => Math.hypot(x - p.x, y - p.y);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let col = BG;
      if (dist(x, y, { x: c, y: c }) <= ballR) {
        col = BALL;
        if (Math.abs(dist(x, y, aL) - AR) < seamW || Math.abs(dist(x, y, aR) - AR) < seamW) col = SEAM;
      }
      const i = (y * S + x) * 4;
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = 255;
    }
  }
  // box-downsample SSxSS -> size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < SS; dy++) for (let dx = 0; dx < SS; dx++) {
        const i = ((y * SS + dy) * S + (x * SS + dx)) * 4;
        r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
      }
      const n = SS * SS, o = (y * size + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
    }
  }
  return out;
}

for (const size of [192, 512]) {
  const png = encodePng(size, size, drawBall(size));
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), png);
  console.log(`wrote web/icon-${size}.png (${png.length} bytes)`);
}
