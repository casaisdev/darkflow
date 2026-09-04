/**
 * Generates `app/favicon.ico` — the fallback icon for browsers that will not
 * take `app/icon.svg`.
 *
 * It rasterizes the same compact mark that `icon.svg` draws (x 12→24 of the
 * trace plus the dot, on a rounded --void tile) at 16, 32 and 48 px, encodes
 * each as PNG and packs them into an ICO. No dependencies: PNG is zlib plus
 * four chunks, and ICO is a 22-byte header per image.
 *
 * Run with `pnpm gen:favicon` after changing `app/icon.svg`.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "app", "favicon.ico");
const SIZES = [16, 32, 48];
const SUPERSAMPLE = 4;

// --- palette (mirrors app/globals.css) --------------------------------------
const VOID = [0x05, 0x07, 0x0a];
const T2 = [0x77, 0x94, 0xac];
const T3 = [0xa8, 0xc8, 0xde];
const GHOST = [0xff, 0x8a, 0x3d];
const GHOST_CORE = [0xff, 0xd9, 0xa8];
const GHOST_HALO = [0xd1, 0x54, 0x12];

// --- geometry, in the 32×32 icon space --------------------------------------
// Logo grid → icon space, same transform as icon.svg: translate(2,2) scale(1.4)
// translate(-12,4). The 32×32 space is then scaled to each output size.
const gx = (x) => 1.4 * (x - 12) + 2;
const gy = (y) => 1.4 * (y + 4) + 2;
const TILE_RADIUS = 7;
const TRACE = { x0: gx(12), x1: gx(17), y0: gy(5), y1: gy(7) };
const DOT = { cx: gx(26.5), cy: gy(6) };
const R_HALO = 1.4 * 5.5;
const R_DOT = 1.4 * 2.6;
const R_CORE = 1.4 * 1;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Coverage of a rounded 32×32 square at a point. Binary, antialiased by SSAA. */
function inTile(x, y) {
  const r = TILE_RADIUS;
  const cx = Math.min(Math.max(x, r), 32 - r);
  const cy = Math.min(Math.max(y, r), 32 - r);
  return Math.hypot(x - cx, y - cy) <= r;
}

/** Layers at a point, back to front, as [r, g, b, alpha]. */
function layersAt(x, y) {
  const layers = [];

  if (inTile(x, y)) layers.push([...VOID, 1]);

  if (x >= TRACE.x0 && x <= TRACE.x1 && y >= TRACE.y0 && y <= TRACE.y1) {
    const t = clamp01((x - TRACE.x0) / (TRACE.x1 - TRACE.x0));
    layers.push([
      lerp(T2[0], T3[0], t),
      lerp(T2[1], T3[1], t),
      lerp(T2[2], T3[2], t),
      1,
    ]);
  }

  const d = Math.hypot(x - DOT.cx, y - DOT.cy);
  // Cubic falloff, matching HALO_FALLOFF in components/Logo.tsx.
  if (d <= R_HALO) layers.push([...GHOST_HALO, 0.4 * (1 - d / R_HALO) ** 3]);
  if (d <= R_DOT) layers.push([...GHOST, 1]);
  if (d <= R_CORE) layers.push([...GHOST_CORE, 1]);

  return layers;
}

/** Source-over composite of the layers at a point, premultiplied. */
function sampleAt(x, y) {
  let [r, g, b, a] = [0, 0, 0, 0];
  for (const [lr, lg, lb, la] of layersAt(x, y)) {
    r = lr * la + r * (1 - la);
    g = lg * la + g * (1 - la);
    b = lb * la + b * (1 - la);
    a = la + a * (1 - la);
  }
  return [r, g, b, a];
}

/** Renders the mark at `size`×`size` as straight (un-premultiplied) RGBA. */
function render(size) {
  const scale = 32 / size;
  const step = 1 / SUPERSAMPLE;
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const [sr, sg, sb, sa] = sampleAt(
            (px + (sx + 0.5) * step) * scale,
            (py + (sy + 0.5) * step) * scale,
          );
          // sampleAt already returns premultiplied colour.
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }
      const alpha = a / samples;
      const i = (py * size + px) * 4;
      // Back to straight alpha; guard the fully transparent case.
      pixels[i] = alpha > 0 ? Math.round(r / a) : 0;
      pixels[i + 1] = alpha > 0 ? Math.round(g / a) : 0;
      pixels[i + 2] = alpha > 0 ? Math.round(b / a) : 0;
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

// --- PNG ---------------------------------------------------------------------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // bytes 10-12 stay 0: deflate, adaptive filtering, no interlace

  // One filter byte (0 = none) in front of every scanline.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- ICO ---------------------------------------------------------------------
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(images.length * 16);
  let offset = header.length + directory.length;

  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory[entry + 2] = 0; // palette size
    directory[entry + 3] = 0; // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(png.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...images.map((i) => i.png)]);
}

const images = SIZES.map((size) => ({ size, png: encodePng(size, render(size)) }));
writeFileSync(OUT, encodeIco(images));
console.log(`favicon.ico → ${SIZES.join(", ")} px, ${images.reduce((n, i) => n + i.png.length, 0)} bytes of PNG`);
