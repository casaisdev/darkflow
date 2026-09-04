import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bezierAxis,
  bezierSlope,
  bezierValue,
  cubicBezier,
  exponentialDecay,
  linear,
  parseDurationMs,
  parseEasing,
} from "@/lib/easing";

/**
 * The hand-written cubic-bezier solver.
 *
 * Untested until now, and the most dangerous kind of untested: it is pure, it
 * is short, and it fails silently. Every seen transaction flies to its slot on
 * `--land-ease`, so a wrong curve means every landing in the product moves on
 * the wrong easing — and nothing on screen would ever reveal it, because there
 * is no reference alongside it to compare against.
 *
 * The reference values below are computed independently of the implementation,
 * from the Bézier definition itself, so this suite cannot agree with a bug by
 * sharing its arithmetic.
 */

/**
 * B(t) for a CSS cubic-bezier axis, straight from the definition.
 *
 * Named apart from `bezierAxis` in the module under test on purpose: this one
 * expands the Bernstein form every call, so it shares no arithmetic with the
 * coefficients the implementation precomputes.
 */
function bezierAt(p1: number, p2: number, t: number): number {
  const u = 1 - t;
  // Endpoints fixed at 0 and 1, as CSS requires.
  return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
}

/**
 * The eased value at `x`, found by bisection on t.
 *
 * Deliberately a different algorithm from the one under test — bisection has
 * no derivative, so a sign error in the implementation's Newton step cannot be
 * reproduced here.
 */
function referenceEase(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
): number {
  let low = 0;
  let high = 1;
  for (let i = 0; i < 80; i++) {
    const mid = (low + high) / 2;
    if (bezierAt(x1, x2, mid) < x) low = mid;
    else high = mid;
  }
  return bezierAt(y1, y2, (low + high) / 2);
}

/** The project's own curve. `--land-ease` in `app/globals.css`. */
const LAND = [0.16, 0.84, 0.28, 1] as const;

describe("cubicBezier", () => {
  it("pins both endpoints exactly", () => {
    const ease = cubicBezier(...LAND);
    // Not "close to". A flight that starts at 0.001 of the way there has
    // already teleported, and one that never reaches 1 never lands.
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
  });

  it("clamps outside the domain rather than extrapolating", () => {
    const ease = cubicBezier(...LAND);
    expect(ease(-0.5)).toBe(0);
    expect(ease(1.5)).toBe(1);
  });

  it("is monotone across the domain", () => {
    const ease = cubicBezier(...LAND);
    let previous = -Infinity;
    for (let i = 0; i <= 1000; i++) {
      const value = ease(i / 1000);
      // A non-monotone easing makes a mark travel backwards mid-flight.
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it("converges to an independently computed curve", () => {
    const ease = cubicBezier(...LAND);
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      const x = i / 200;
      worst = Math.max(worst, Math.abs(ease(x) - referenceEase(...LAND, x)));
    }
    // The solver's own convergence target is 1e-6 on x; the error that reaches
    // y is bounded by that times the slope, which this curve keeps under ~3.
    expect(worst).toBeLessThan(1e-4);
  });

  it("is genuinely eased, so a linear implementation would fail", () => {
    const ease = cubicBezier(...LAND);
    expect(Math.abs(ease(0.35) - 0.35)).toBeGreaterThan(0.2);
  });

  it("overshoots nothing: --land-ease stays inside 0..1", () => {
    const ease = cubicBezier(...LAND);
    for (let i = 0; i <= 500; i++) {
      const value = ease(i / 500);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  describe("degenerate curves", () => {
    it("handles control points at the corners", () => {
      const flat = cubicBezier(0, 0, 1, 1); // the identity curve
      for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
        expect(flat(x)).toBeCloseTo(x, 5);
      }
    });

    it("handles a near-vertical start, where Newton stalls", () => {
      // x1 = 0 with x2 = 0 makes x(t) almost flat near t = 0, so the slope
      // guard trips and the bisection fallback has to carry it. This is the
      // exact branch that would otherwise never run in this codebase.
      const steep = cubicBezier(0, 1, 0, 1);
      expect(steep(0)).toBe(0);
      expect(steep(1)).toBe(1);
      let previous = -Infinity;
      for (let i = 0; i <= 200; i++) {
        const value = steep(i / 200);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
        previous = value;
      }
      // It really is steep, or the fallback was never exercised.
      expect(steep(0.05)).toBeGreaterThan(0.4);
    });

    it("handles a near-vertical finish", () => {
      const late = cubicBezier(1, 0, 1, 0);
      expect(late(0)).toBe(0);
      expect(late(1)).toBe(1);
      expect(late(0.95)).toBeLessThan(0.6);
      for (let i = 0; i <= 200; i++) {
        expect(Number.isFinite(late(i / 200))).toBe(true);
      }
    });

    it("stays finite when both control points sit on one axis", () => {
      for (const curve of [
        cubicBezier(0, 0, 0, 0),
        cubicBezier(1, 1, 1, 1),
        cubicBezier(0, 1, 1, 0),
      ]) {
        for (let i = 0; i <= 100; i++) {
          expect(Number.isFinite(curve(i / 100))).toBe(true);
        }
      }
    });
  });
});

describe("the Newton derivative", () => {
  /**
   * Tested directly, and only testable directly.
   *
   * Mutation-tested through the public API first: flipping a sign in the
   * derivative, swapping its coefficients, or reversing the Newton step all
   * left all twenty-three easing tests green, because the bisection fallback
   * needs no derivative and rescues every one of those errors. Three surviving
   * mutants is not a suite gap that better assertions could close — it is the
   * solver's actual structure.
   *
   * So `bezierSlope` is exported and asserted here against a numerical
   * derivative of `bezierValue`. This is the only place a derivative bug can
   * be caught before someone removes the fallback and it becomes visible.
   */
  const AXES: [number, number][] = [
    [0.16, 0.28], // --land-ease, x
    [0.84, 1], // --land-ease, y
    [0, 1],
    [1, 0],
    [0, 0],
    [1, 1],
  ];

  it("matches a numerical derivative of the value it differentiates", () => {
    const h = 1e-6;
    for (const [p1, p2] of AXES) {
      const axis = bezierAxis(p1, p2);
      for (let i = 1; i < 100; i++) {
        const t = i / 100;
        // Central difference: second-order accurate, so the tolerance can be
        // tight enough that a wrong middle-term coefficient cannot hide in it.
        const numerical =
          (bezierValue(axis, t + h) - bezierValue(axis, t - h)) / (2 * h);
        expect(bezierSlope(axis, t)).toBeCloseTo(numerical, 5);
      }
    }
  });

  it("has the endpoint slopes CSS guarantees", () => {
    // B'(0) = 3·p1 and B'(1) = 3·(1 − p2) for endpoints pinned at 0 and 1.
    for (const [p1, p2] of AXES) {
      const axis = bezierAxis(p1, p2);
      expect(bezierSlope(axis, 0)).toBeCloseTo(3 * p1, 10);
      expect(bezierSlope(axis, 1)).toBeCloseTo(3 * (1 - p2), 10);
    }
  });

  it("reconstructs the value it came from", () => {
    // Guards the coefficients themselves, not just their derivative.
    for (const [p1, p2] of AXES) {
      const axis = bezierAxis(p1, p2);
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const u = 1 - t;
        const definition =
          3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
        expect(bezierValue(axis, t)).toBeCloseTo(definition, 10);
      }
    }
  });
});

describe("linear", () => {
  it("is the identity inside the domain and clamps outside it", () => {
    expect(linear(0)).toBe(0);
    expect(linear(0.42)).toBe(0.42);
    expect(linear(1)).toBe(1);
    expect(linear(-1)).toBe(0);
    expect(linear(2)).toBe(1);
  });
});

describe("parseEasing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the token as it is written in the stylesheet", () => {
    const ease = parseEasing("cubic-bezier(.16,.84,.28,1)");
    expect(ease(0.35)).toBeCloseTo(referenceEase(...LAND, 0.35), 4);
  });

  it("tolerates the spacing a stylesheet may add", () => {
    const a = parseEasing("cubic-bezier(.16,.84,.28,1)");
    const b = parseEasing("  cubic-bezier( 0.16 , 0.84 , 0.28 , 1.0 )  ");
    expect(b(0.4)).toBeCloseTo(a(0.4), 6);
  });

  it("falls back to linear and says so, rather than easing wrongly in silence", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // CSS keywords are valid CSS and are not used by these tokens. Accepting
    // one quietly would produce a curve nobody chose.
    expect(parseEasing("ease-in-out")(0.5)).toBe(0.5);
    expect(parseEasing("")(0.5)).toBe(0.5);
    expect(parseEasing("cubic-bezier(1,2)")(0.5)).toBe(0.5);
    expect(parseEasing("cubic-bezier(a,b,c,d)")(0.5)).toBe(0.5);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});

describe("parseDurationMs", () => {
  it("reads both units the tokens use", () => {
    expect(parseDurationMs("8s", 0)).toBe(8000);
    expect(parseDurationMs("420ms", 0)).toBe(420);
    expect(parseDurationMs("0.18s", 0)).toBeCloseTo(180, 6);
  });

  it("tolerates the whitespace getPropertyValue returns", () => {
    // Computed custom properties commonly come back with a leading space.
    expect(parseDurationMs(" 2400ms ", 0)).toBe(2400);
  });

  it("falls back rather than guessing", () => {
    expect(parseDurationMs("", 999)).toBe(999);
    expect(parseDurationMs("   ", 999)).toBe(999);
    expect(parseDurationMs("fast", 999)).toBe(999);
  });

  it("reads a bare number as milliseconds", () => {
    // A duration token without a unit is a mistake either way; ms is the read
    // that fails small rather than by a factor of a thousand.
    expect(parseDurationMs("500", 0)).toBe(500);
  });

  it("does not read 'ms' as 's'", () => {
    // The ordering trap: "420ms" ends with "s" too.
    expect(parseDurationMs("420ms", 0)).not.toBe(420_000);
  });
});

describe("exponentialDecay", () => {
  it("starts at one and halves on the expected schedule", () => {
    expect(exponentialDecay(0, 8000)).toBe(1);
    expect(exponentialDecay(-100, 8000)).toBe(1);
    expect(exponentialDecay(8000, 8000)).toBeCloseTo(Math.exp(-1), 12);
    expect(exponentialDecay(8000 * Math.LN2, 8000)).toBeCloseTo(0.5, 12);
  });

  it("reaches 1% at ln(100) tau, which is where the world culls", () => {
    // `CULL_AFTER_TAU` in world.ts is this number. If the two ever disagree,
    // traces are either culled while still visible or held after they are gone.
    expect(exponentialDecay(Math.log(100) * 8000, 8000)).toBeCloseTo(0.01, 10);
  });

  it("is monotone decreasing", () => {
    let previous = Infinity;
    for (let age = 0; age <= 40_000; age += 250) {
      const alpha = exponentialDecay(age, 8000);
      expect(alpha).toBeLessThanOrEqual(previous);
      previous = alpha;
    }
  });

  it("returns zero for a degenerate tau instead of NaN", () => {
    expect(exponentialDecay(100, 0)).toBe(0);
    expect(exponentialDecay(100, -5)).toBe(0);
  });
});
