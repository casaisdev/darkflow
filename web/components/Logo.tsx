import type { CSSProperties } from "react";

/**
 * DARKFLOW — the interrupted trace.
 *
 * A line enters from the left, travels, and is cut off. After a deliberately
 * wide gap, a solid amber dot.
 * The line is what you saw coming. The dot is what showed up unannounced.
 *
 * 32×12 grid:
 *   trace  x 0→17,  y=6, width 2, right edge cut at 90°
 *   gap    x 17→24
 *   dot    center (26.5, 6) · r 2.6 --ghost · core r 1.0 --ghost-core
 *                            · halo r 5.5 --ghost-halo
 */

/** Stream connection state. Only the logo draws it; nothing consumes it yet. */
export type ConnectionState = "idle" | "connecting" | "live";

const GRID_W = 32;
const GRID_H = 12;
const TRACE_END = 17;
const DOT_X = 26.5;
const AXIS_Y = 6;

/** Trace length in grid units, used as the dash length for the draw-in. */
const TRACE_LEN = TRACE_END;

/** Offset of the --t-2 stop inside the gradient (x=13 over a 17-long trace). */
const T2_STOP = 13 / TRACE_END;

const traceLenVar = { "--df-trace-len": TRACE_LEN } as CSSProperties;

/**
 * Halo falloff as [offset, opacity] stops, opacity being a multiplier on
 * --ghost-halo's own alpha. Cubic: (1 - t)³.
 *
 * The gap between the cut and the dot is 7 units and has to stay felt. A linear
 * falloff is still above the perceptual floor at 0.95r, so amber starts showing
 * around x=21 and only ~4 units of true void survive. Cubic drops under it by
 * ~0.65r, which puts first visible amber near x=23 and keeps the gap wide.
 */
const HALO_FALLOFF: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [0.25, 0.422],
  [0.5, 0.125],
  [0.75, 0.016],
  [1, 0],
];

/** Sizes are CSS lengths, so callers can pass `clamp()` and go responsive. */
const toLength = (size: number | string) =>
  typeof size === "number" ? `${size}px` : size;

type DefsProps = { uid: string };

/**
 * The `<defs>` carry ids. If several logos with different states share a page,
 * give them distinct `uid`s so the DOM keeps unique ids.
 */
function LogoDefs({ uid }: DefsProps) {
  return (
    <defs>
      <linearGradient
        id={`${uid}-trace`}
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1={AXIS_Y}
        x2={TRACE_END}
        y2={AXIS_Y}
      >
        <stop offset="0" style={{ stopColor: "var(--t-2)", stopOpacity: 0 }} />
        <stop offset={T2_STOP} style={{ stopColor: "var(--t-2)" }} />
        <stop offset="1" style={{ stopColor: "var(--t-3)" }} />
      </linearGradient>
      {/* The brief calls for a halo of r=5.5 in --ghost-halo. It is resolved as
          a radial gradient fading to transparent: a flat 11-unit disc on a
          12-unit grid would read as a blob, not as a glow.
          The falloff is cubic, not linear. A linear ramp stays perceptible out
          to ~0.95r, which pushes visible amber back to x≈21 and eats 3 of the
          7 units of gap. The gap is the logo; the halo does not get to borrow
          from it. See HALO_FALLOFF. */}
      <radialGradient
        id={`${uid}-halo`}
        gradientUnits="userSpaceOnUse"
        cx={DOT_X}
        cy={AXIS_Y}
        r="5.5"
      >
        {HALO_FALLOFF.map(([offset, opacity]) => (
          <stop
            key={offset}
            offset={offset}
            style={{ stopColor: "var(--ghost-halo)", stopOpacity: opacity }}
          />
        ))}
      </radialGradient>
    </defs>
  );
}

/** The dot: halo, body, core. The three layers of the glow. */
function GhostDot({ uid }: DefsProps) {
  return (
    <>
      <circle
        className="df-halo"
        cx={DOT_X}
        cy={AXIS_Y}
        r="5.5"
        fill={`url(#${uid}-halo)`}
      />
      <circle className="fill-ghost" cx={DOT_X} cy={AXIS_Y} r="2.6" />
      <circle className="fill-ghost-core" cx={DOT_X} cy={AXIS_Y} r="1" />
    </>
  );
}

/** The trace. `strokeLinecap="butt"` is the 90° cut. */
function Trace({ uid }: DefsProps) {
  return (
    <line
      className="df-trace"
      x1="0"
      y1={AXIS_Y}
      x2={TRACE_END}
      y2={AXIS_Y}
      stroke={`url(#${uid}-trace)`}
      strokeWidth="2"
      strokeLinecap="butt"
    />
  );
}

export type LogoProps = {
  /** Width, as a number of px or any CSS length. Height follows the 32:12 ratio. */
  size?: number | string;
  state?: ConnectionState;
  className?: string;
  /** Prefix for the `<defs>` ids. Change it when a page holds several logos. */
  uid?: string;
  /** Accessible name. `null` marks the mark as decorative. */
  title?: string | null;
};

export function Logo({
  size = 128,
  state = "live",
  className,
  uid = "df",
  title = "DARKFLOW",
}: LogoProps) {
  const width = toLength(size);
  return (
    <svg
      viewBox={`0 0 ${GRID_W} ${GRID_H}`}
      data-state={state}
      style={{
        ...traceLenVar,
        width,
        height: `calc(${width} * ${GRID_H} / ${GRID_W})`,
      }}
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
    >
      <LogoDefs uid={uid} />
      <Trace uid={uid} />
      <GhostDot uid={uid} />
    </svg>
  );
}

/**
 * Compact variant (favicon): only x 12→24 of the trace, plus the dot.
 * The viewBox is cropped to a square centred on the y=6 axis.
 */
export function LogoMark({
  size = 32,
  state = "live",
  className,
  uid = "dfm",
  title = "DARKFLOW",
}: LogoProps) {
  const side = toLength(size);
  return (
    <svg
      viewBox="12 -4 20 20"
      data-state={state}
      style={{ ...traceLenVar, width: side, height: side }}
      className={className}
      role={title ? "img" : "presentation"}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
    >
      <LogoDefs uid={uid} />
      <Trace uid={uid} />
      <GhostDot uid={uid} />
    </svg>
  );
}

/** Logo width relative to the wordmark's type size. */
const LOGO_TO_TYPE = 2.8;

/**
 * Archivo's cap height, read from the font's own OS/2 table
 * (sCapHeight 686 / unitsPerEm 1000). Its x-height is 0.526em, which is not
 * what we align to: "DARKFLOW" is set uppercase, so the only band of ink is
 * baseline → cap height and the optical centre of that band is cap/2.
 */
const ARCHIVO_CAP_HEIGHT = 0.686;

/**
 * How far the logo must drop so its axis lands on the cap centre instead of on
 * the box centre.
 *
 * The lockup aligns on the text baseline, which puts the logo's bottom edge on
 * it, so the trace sits at half the logo's height above the baseline. The cap
 * centre is at half the cap height. The difference is the correction.
 */
const LOGO_HEIGHT_RATIO = (LOGO_TO_TYPE * GRID_H) / GRID_W; // 1.05em
const TRACE_DROP = Number(
  (LOGO_HEIGHT_RATIO / 2 - ARCHIVO_CAP_HEIGHT / 2).toFixed(4),
); // 0.182em

export type WordmarkProps = Omit<LogoProps, "title"> & {
  /** Type size of "DARKFLOW", as px or any CSS length. The logo scales with it. */
  size?: number | string;
};

/**
 * Logo + "DARKFLOW" set in Archivo Bold uppercase, -0.02em tracking.
 *
 * Defaults to `live`, i.e. the complete mark: trace, cut, gap, dot. The
 * connection states belong to the logo when it is used as an instrument in the
 * app chrome — as an identity lockup it is always whole.
 */
export function Wordmark({
  size = 28,
  state = "live",
  className,
  uid = "dfw",
}: WordmarkProps) {
  const type = toLength(size);
  return (
    <span
      className={`inline-flex items-baseline ${className ?? ""}`}
      style={{ gap: `calc(${type} * 0.55)` }}
    >
      {/* Wrapper so the logo can be nudged without disturbing the flex baseline. */}
      <span
        style={{
          display: "flex",
          transform: `translateY(calc(${type} * ${TRACE_DROP}))`,
        }}
      >
        <Logo
          size={`calc(${type} * ${LOGO_TO_TYPE})`}
          state={state}
          uid={uid}
          title={null}
        />
      </span>
      {/*
        Engraved, and painted with a text colour rather than a trace colour.
        It was --t-4, which is a stop on the cold ramp — the ramp rule 2
        reserves for fee priority and nothing else. A wordmark in a fee colour
        is the apparatus borrowing the vocabulary it uses to make claims about
        the data. It was also the brightest text on the page at 83.3% relative
        luminance, above the primary reading's 73.7%, which inverts the one
        thing brightness is for here: the maker's name outshone the measurement.
      */}
      <span
        className="wordmark text-text-num"
        style={{ fontSize: type, lineHeight: 1 }}
      >
        Darkflow
      </span>
    </span>
  );
}

export default Logo;
