import { ImageResponse } from "next/og";
import {
  FIELD,
  GHOST,
  GHOST_CORE,
  GHOST_SETTLED,
  GRAIN_URL,
  HALO_GRADIENT,
  RULE,
  RULE_HAIR,
  SETTLED,
  T2,
  T2_RGB,
  T3,
  T4,
  TEXT_DIM,
  TEXT_NUM,
  TRACE,
  VOID,
  loadGoogleFont,
} from "@/lib/og";
import { TAGLINE, TITLE } from "@/lib/site";

export const alt = TITLE;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const WORDMARK = "DARKFLOW";
const KEY = "NEVER SEEN BY THIS FEED";

/**
 * The share card: the instrument, small, and its name.
 *
 * It was the logo and a wordmark in a second typeface, over a tagline that
 * said "in real time" — a claim the page itself no longer makes. Now it is a
 * cut of the chamber: a field of marks placed by fee, a block beside it with
 * the warm rows that never crossed, and tracks reaching the rows that did.
 * One face, the site's mono, at the wordmark's own weight. The picture is
 * generated from the same palette literals as everything else here, so a
 * token change reaches the card on the next build.
 *
 * The marks are seeded, so the card is the same card every build. Nothing on
 * it is a measurement, and it prints no number.
 */

/** Deterministic, so the card is stable across builds. mulberry32. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, for a fee distribution with a tail. */
function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

/* Geometry of the miniature, in card pixels. */
const CHAMBER = { x: 110, y: 96, w: 620, h: 300 };
const BLOCK = { x: 980, y: 96, w: 110, h: 300 };
const ROWS = 40;
const MARKS = 150;

export default async function OpenGraphImage() {
  const [plexBold, plexMono] = await Promise.all([
    loadGoogleFont("IBM Plex Mono", 600, WORDMARK),
    loadGoogleFont("IBM Plex Mono", 400, TAGLINE.toUpperCase() + KEY + "0123456789"),
  ]);
  const fonts = [
    plexBold && { name: "IBM Plex Mono", data: plexBold, weight: 600 as const },
    plexMono && { name: "IBM Plex Mono", data: plexMono, weight: 400 as const },
  ].filter((font) => font !== null);

  const rand = prng(0xda4f10);

  // The field: height is log-fee, luminance is its rank. A gaussian in log
  // space gives the dense band with a sparse top that the real pool has.
  const marks = Array.from({ length: MARKS }, () => {
    const z = gaussian(rand);
    const height = Math.min(0.97, Math.max(0.03, 0.62 - z * 0.17));
    const rank = 1 - height;
    const age = rand();
    return {
      x: CHAMBER.x + 18 + rand() * (CHAMBER.w - 36),
      y: CHAMBER.y + height * CHAMBER.h,
      colour: TRACE[Math.min(TRACE.length - 1, Math.floor(rank * TRACE.length))],
      alpha: 0.35 + 0.65 * (1 - age) * (1 - age),
    };
  });

  // The block: forty rows, a third of them private flow, widths on the root
  // scale the instrument uses. Tracks reach a sample of the public rows from
  // marks in the field.
  const rows = Array.from({ length: ROWS }, (_, i) => {
    const ghost = rand() < 0.3;
    const gas = 21_000 * Math.exp(Math.abs(gaussian(rand)) * 1.1);
    const width = BLOCK.w * (0.18 + 0.82 * Math.sqrt(Math.min(1, gas / 400_000)));
    const pitch = BLOCK.h / ROWS;
    return { ghost, y: BLOCK.y + i * pitch, h: pitch - 2, width };
  });
  const tracks = rows
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => !row.ghost && rand() < 0.5)
    .map(({ row }) => {
      const from = marks[Math.floor(rand() * marks.length)];
      return { x1: from.x, y1: from.y, x2: BLOCK.x + BLOCK.w - row.width, y2: row.y + row.h / 2 };
    });

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          backgroundColor: VOID,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            backgroundImage: GRAIN_URL,
            backgroundRepeat: "repeat",
            opacity: 0.03,
          }}
        />

        <svg
          width={size.width}
          height={size.height}
          viewBox={`0 0 ${size.width} ${size.height}`}
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          {/* The chamber's ground, dissolving toward the block. */}
          <defs>
            <linearGradient id="ground" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={FIELD} stopOpacity="1" />
              <stop offset="0.7" stopColor={FIELD} stopOpacity="0.78" />
              <stop offset="1" stopColor={FIELD} stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect x={CHAMBER.x} y={CHAMBER.y} width={CHAMBER.w + 180} height={CHAMBER.h} fill="url(#ground)" />
          {/* The reticle: three rules, at the threshold. */}
          {[0.25, 0.5, 0.75].map((f) => (
            <line
              key={f}
              x1={CHAMBER.x}
              y1={CHAMBER.y + f * CHAMBER.h + 0.5}
              x2={CHAMBER.x + CHAMBER.w}
              y2={CHAMBER.y + f * CHAMBER.h + 0.5}
              stroke={RULE_HAIR}
              strokeWidth="1"
            />
          ))}
          {/* The scale spine and the brackets. */}
          <line x1={CHAMBER.x + 0.5} y1={CHAMBER.y} x2={CHAMBER.x + 0.5} y2={CHAMBER.y + CHAMBER.h} stroke={RULE} strokeWidth="1" />
          <path d={`M${CHAMBER.x - 10},${CHAMBER.y + 12} v-12 h12`} stroke={RULE} strokeWidth="1" fill="none" />
          <path d={`M${CHAMBER.x - 10},${CHAMBER.y + CHAMBER.h - 12} v12 h12`} stroke={RULE} strokeWidth="1" fill="none" />
          <path d={`M${CHAMBER.x + CHAMBER.w + 10},${CHAMBER.y + 12} v-12 h-12`} stroke={RULE} strokeWidth="1" fill="none" />
          <path d={`M${CHAMBER.x + CHAMBER.w + 10},${CHAMBER.y + CHAMBER.h - 12} v12 h-12`} stroke={RULE} strokeWidth="1" fill="none" />

          {/* The tracks, under the marks and the rows. */}
          {tracks.map((t, i) => (
            <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2} stroke={T2} strokeWidth="1" strokeOpacity="0.28" />
          ))}

          {/* The field. */}
          {marks.map((m, i) => (
            <circle key={i} cx={m.x} cy={m.y} r="2.6" fill={m.colour} fillOpacity={m.alpha} />
          ))}

          {/* The block: the gas datum, then the rows, right-anchored. */}
          <line x1={BLOCK.x + 0.5} y1={BLOCK.y} x2={BLOCK.x + 0.5} y2={BLOCK.y + BLOCK.h} stroke={RULE} strokeWidth="1" />
          {rows.map((r, i) => (
            <rect
              key={i}
              x={BLOCK.x + BLOCK.w - r.width}
              y={r.y}
              width={r.width}
              height={r.h}
              fill={r.ghost ? GHOST_SETTLED : SETTLED}
            />
          ))}
          <rect x={BLOCK.x} y={BLOCK.y - 2} width={BLOCK.w} height="1" fill={T3} />
        </svg>

        {/* The plate. */}
        <div
          style={{
            position: "absolute",
            left: 110,
            top: 452,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 22,
            }}
          >
            {/* The interrupted trace, at the wordmark's cap height. */}
            <div style={{ display: "flex", position: "relative", width: 96, height: 36 }}>
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 15,
                  width: 51,
                  height: 6,
                  backgroundImage: `linear-gradient(to right, rgba(${T2_RGB}, 0) 0%, ${T2} 76.5%, ${T3} 100%)`,
                }}
              />
              <div style={{ position: "absolute", left: 63, top: 1.5, width: 33, height: 33, borderRadius: 33, backgroundImage: HALO_GRADIENT }} />
              <div style={{ position: "absolute", left: 71.7, top: 10.2, width: 15.6, height: 15.6, borderRadius: 16, backgroundColor: GHOST }} />
              <div style={{ position: "absolute", left: 76.5, top: 15, width: 6, height: 6, borderRadius: 6, backgroundColor: GHOST_CORE }} />
            </div>
            <div
              style={{
                fontFamily: "IBM Plex Mono",
                fontSize: 58,
                fontWeight: 600,
                letterSpacing: -0.02 * 58,
                color: T4,
              }}
            >
              {WORDMARK}
            </div>
          </div>
          <div
            style={{
              fontFamily: "IBM Plex Mono",
              fontSize: 22,
              letterSpacing: 0.14 * 22,
              color: TEXT_NUM,
              marginTop: 22,
            }}
          >
            {TAGLINE.toUpperCase()}
          </div>
        </div>

        {/* The key, beside the block: the one claim, next to its colour. */}
        <div
          style={{
            position: "absolute",
            left: BLOCK.x - 262,
            top: BLOCK.y + BLOCK.h + 22,
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: "IBM Plex Mono",
            fontSize: 15,
            letterSpacing: 0.12 * 15,
            color: TEXT_DIM,
          }}
        >
          <div style={{ width: 18, height: 5, backgroundColor: GHOST_SETTLED }} />
          <div>{KEY}</div>
        </div>
      </div>
    ),
    { ...size, fonts },
  );
}
