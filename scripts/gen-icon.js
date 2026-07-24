'use strict';
// Regenerates server/public/apple-touch-icon.png — a 180×180 solid-teal tile (iOS masks the
// corners itself). Dependency-free PNG encoder so there's no build tooling. Run: node scripts/gen-icon.js
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const SIZE = 180;
const [R, G, B] = [0x0e, 0x8f, 0x8f]; // harbor teal

// raw RGBA scanlines, each prefixed with filter byte 0
const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
let o = 0;
for (let y = 0; y < SIZE; y++) {
  raw[o++] = 0;
  for (let x = 0; x < SIZE; x++) { raw[o++] = R; raw[o++] = G; raw[o++] = B; raw[o++] = 255; }
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'server', 'public', 'apple-touch-icon.png');
fs.writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
