// Generates the toolbar icons (simple PNGs, no image libraries needed).
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function icon(size, pad = 0) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const art = size - pad * 2;
  const r = art * 0.22;
  for (let y = 0; y < size; y++) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const lx = x - pad;
      const ly = y - pad;
      const inArt = lx >= 0 && ly >= 0 && lx < art && ly < art;
      // rounded square, inset so the 128px store icon has the padding Chrome asks for
      const dx = Math.max(r - lx - 0.5, lx + 0.5 - (art - r), 0);
      const dy = Math.max(r - ly - 0.5, ly + 0.5 - (art - r), 0);
      const inside = inArt && Math.hypot(dx, dy) <= r;
      const u = lx / art, v = ly / art;
      const bar = u > 0.24 && u < 0.76 && [0.28, 0.46, 0.64].some((t) => v > t && v < t + 0.1) && !(v > 0.64 && u > 0.56);
      const [R, G, B] = bar ? [255, 255, 255] : [59, 91, 219];
      px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = inside ? 255 : 0;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(px)), chunk("IEND", Buffer.alloc(0))]);
}

mkdirSync("src/icons", { recursive: true });
// Toolbar sizes stay full-bleed. The 128px icon is also the store icon: Chrome wants
// the artwork at 96px with 16px of transparent padding on each side.
for (const s of [16, 32, 48]) writeFileSync(`src/icons/${s}.png`, icon(s));
writeFileSync("src/icons/128.png", icon(128, 16));
console.log("icons written to src/icons/");
