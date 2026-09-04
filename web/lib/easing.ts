/**
 * The motion tokens are CSS strings — `--land-ease` is
 * `cubic-bezier(.16,.84,.28,1)` and `--decay-trace` is `8s`. Canvas cannot use
 * either. This turns them into numbers and functions.
 *
 * Hand-written rather than pulled from a library: it is forty lines, and the
 * alternative is a dependency for one curve.
 */

export type EasingFn = (progress: number) => number;

/** `"8s"` → 8000, `"420ms"` → 420. Returns `fallback` for anything unparseable. */
export function parseDurationMs(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (trimmed === "") return fallback;

  const numeric = Number.parseFloat(trimmed);
  if (!Number.isFinite(numeric)) return fallback;

  if (trimmed.endsWith("ms")) return numeric;
  if (trimmed.endsWith("s")) return numeric * 1000;
  // A bare number in a duration token is a mistake, but ms is the safer read.
  return numeric;
}

/**
 * Evaluates a CSS cubic-bezier curve.
 *
 * CSS gives the curve as two control points with the endpoints fixed at (0,0)
 * and (1,1). Progress along the animation is the *x* axis, so finding the eased
 * value means solving x(t) = progress for t, then evaluating y(t). Newton–
 * Raphson converges in a handful of iterations everywhere except the flat
 * regions of a steep curve, where it can stall — hence the bisection fallback.
 */
/** Polynomial coefficients of one Bézier axis, endpoints fixed at 0 and 1. */
export type BezierAxis = { a: number; b: number; c: number };

export function bezierAxis(p1: number, p2: number): BezierAxis {
  const c = 3 * p1;
  const b = 3 * (p2 - p1) - c;
  return { a: 1 - c - b, b, c };
}

/** B(t) along one axis. */
export function bezierValue({ a, b, c }: BezierAxis, t: number): number {
  return ((a * t + b) * t + c) * t;
}

/**
 * dB/dt along one axis.
 *
 * Exported, and `cubicBezier` calls it rather than keeping its own copy,
 * because otherwise this derivative cannot be tested at all.
 *
 * Mutation-tested to establish that: flipping a sign here, swapping the
 * coefficients, or reversing the Newton step all left the full easing suite
 * green. The reason is that the bisection fallback below is a complete solver
 * on its own — it needs no derivative — so it silently rescues every arithmetic
 * error Newton can make. A wrong derivative costs about thirty extra
 * polynomial evaluations per call and changes no result.
 *
 * That makes the fallback look like dead code, which is the danger: it never
 * alters an answer, so the first person to delete it turns a latent
 * performance bug into an immediate correctness one. Testing this function
 * directly, against a numerical derivative, is what keeps that from being true.
 */
export function bezierSlope({ a, b, c }: BezierAxis, t: number): number {
  return (3 * a * t + 2 * b) * t + c;
}

export function cubicBezier(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EasingFn {
  // Expanded once up front, then shared by all three samplers.
  const axisX = bezierAxis(x1, x2);
  const axisY = bezierAxis(y1, y2);

  const sampleX = (t: number) => bezierValue(axisX, t);
  const sampleY = (t: number) => bezierValue(axisY, t);
  const slopeX = (t: number) => bezierSlope(axisX, t);

  return (progress: number) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;

    let t = progress;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(t) - progress;
      if (Math.abs(error) < 1e-6) return sampleY(t);
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break; // flat: Newton cannot help here
      t -= error / slope;
    }

    let low = 0;
    let high = 1;
    t = progress;
    for (let i = 0; i < 24; i++) {
      const x = sampleX(t);
      if (Math.abs(x - progress) < 1e-6) break;
      if (x > progress) high = t;
      else low = t;
      t = (low + high) / 2;
    }
    return sampleY(t);
  };
}

/** Straight line. Also what a malformed token falls back to. */
export const linear: EasingFn = (progress) =>
  progress <= 0 ? 0 : progress >= 1 ? 1 : progress;

const CUBIC_BEZIER = /^cubic-bezier\(([^)]+)\)$/;

/**
 * Parses `cubic-bezier(a, b, c, d)` as written in a CSS custom property.
 * Anything else — including the CSS keywords, which these tokens do not use —
 * falls back to linear and says so, because a silently wrong curve is a motion
 * bug nobody will trace back to a token.
 */
export function parseEasing(value: string): EasingFn {
  const match = CUBIC_BEZIER.exec(value.trim());
  if (!match) {
    console.warn(`[tokens] easing "${value}" is not a cubic-bezier; using linear`);
    return linear;
  }
  const parts = match[1].split(",").map((part) => Number.parseFloat(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    console.warn(`[tokens] easing "${value}" has bad coefficients; using linear`);
    return linear;
  }
  return cubicBezier(parts[0], parts[1], parts[2], parts[3]);
}

/**
 * Exponential decay, `e^(-age/τ)`.
 *
 * Rule 2 of the design system: age maps to alpha and nothing else. Exponential
 * rather than linear because a linear fade has a visible kink at the moment it
 * hits zero, and because trace decay in the field should feel like something
 * dissipating, not like a countdown.
 */
export function exponentialDecay(ageMs: number, tauMs: number): number {
  if (ageMs <= 0) return 1;
  if (tauMs <= 0) return 0;
  return Math.exp(-ageMs / tauMs);
}
