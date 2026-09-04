import { describe, expect, it } from "vitest";
import { createQuantileScale } from "@/lib/quantile";
import {
  FLOOR_BAND,
  MIN_AXIS_SAMPLES,
  MIN_TIP_WEI,
  atFloor,
  createFeeLayout,
} from "@/lib/canvas/layout";
import { createWorld, enqueue, step } from "@/lib/canvas/world";
import { tx } from "./helpers";

/**
 * The fee axis: the rolling window, and the mapping from a tip to a height.
 *
 * This is what turns a scatter of dots into readings. Two things have to hold,
 * and both were broken at some point in this repo's history:
 *
 * - The window must be bounded by p1..p99 rather than by min..max, or two
 *   outliers squash the whole population into a sliver.
 * - The ticks must sit at round gwei values and the entities must use the same
 *   mapping, or a label ends up naming a height that nothing occupies.
 */

const GWEI = 1e9;

/** A log-normal window, shaped like the real fee distribution. */
function filled(capacity = 4096) {
  const scale = createQuantileScale({ capacity });
  // Deterministic and heavy-tailed: values from 0.01 to ~1000 gwei.
  for (let i = 0; i < capacity; i++) {
    const u = (i + 0.5) / capacity;
    scale.push(Math.exp(Math.log(GWEI) + (u - 0.5) * 8));
  }
  scale.rebuild();
  return scale;
}

describe("quantile scale", () => {
  it("reports ready only once it holds enough samples", () => {
    const scale = createQuantileScale({ capacity: 64, minSamples: 64 });
    expect(scale.ready()).toBe(false);
    for (let i = 0; i < 63; i++) scale.push(i * GWEI);
    expect(scale.ready()).toBe(false);
    scale.push(63 * GWEI);
    expect(scale.ready()).toBe(true);
  });

  it("answers from the mid-ramp, not from a guess, before the first rebuild", () => {
    // `ready()` is a sample-count predicate, not a freshness one: it can be
    // true while the sorted snapshot is still empty, because the snapshot is
    // rebuilt at 2–4 Hz rather than on every push. The engine rebuilds and
    // refreshes in the same tick, so the gap never opens in practice — but the
    // behaviour in the gap has to be defined, and it is: an unbuilt window
    // answers 0.5 everywhere rather than inventing an ordering.
    const scale = createQuantileScale({ capacity: 64, minSamples: 8 });
    for (let i = 0; i < 64; i++) scale.push(i * GWEI);
    expect(scale.ready()).toBe(true);
    expect(scale.percentile(1 * GWEI)).toBe(0.5);
    expect(scale.percentile(60 * GWEI)).toBe(0.5);
    scale.rebuild();
    expect(scale.percentile(1 * GWEI)).toBeLessThan(
      scale.percentile(60 * GWEI),
    );
  });

  it("returns percentiles that span the full range", () => {
    const scale = filled();
    expect(scale.percentile(scale.valueAt(0.5))).toBeCloseTo(0.5, 2);
    expect(scale.percentile(0)).toBe(0);
    expect(scale.percentile(1e30)).toBe(1);
  });

  it("is monotone in the value", () => {
    const scale = filled();
    let previous = -1;
    for (const gwei of [0.05, 0.1, 1, 5, 20, 100, 500]) {
      const p = scale.percentile(gwei * GWEI);
      expect(p).toBeGreaterThanOrEqual(previous);
      previous = p;
    }
  });

  it("evicts oldest-first, so the window is recent rather than cumulative", () => {
    const scale = createQuantileScale({ capacity: 100 });
    for (let i = 0; i < 100; i++) scale.push(1 * GWEI);
    for (let i = 0; i < 100; i++) scale.push(500 * GWEI);
    scale.rebuild();
    expect(scale.size()).toBe(100);
    // The base fee moves every block; a window that never forgot would rank
    // today's transactions against last hour's market.
    expect(scale.valueAt(0.5)).toBe(500 * GWEI);
  });
});

describe("fee layout", () => {
  it("maps the p1 and p99 ends to the top and bottom of the field", () => {
    const scale = filled();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    // 0 is the top, where the expensive sit.
    expect(layout.heightFor(scale.valueAt(0.99))).toBeCloseTo(0, 2);
    // The axis ends at the top of the floor band, not at the chamber's foot.
    expect(layout.heightFor(scale.valueAt(0.01))).toBeCloseTo(1 - FLOOR_BAND, 2);
  });

  it("clamps outside the window instead of drawing off-screen", () => {
    const scale = filled();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    // Two outliers must not squash the population; they park on the edge.
    expect(layout.heightFor(1e30)).toBe(0);
    // The axis ends at the top of the floor band; below the window is there.
    expect(layout.heightFor(1)).toBe(1 - FLOOR_BAND);
    // A zero tip is at the floor: the band's top edge, where the world then
    // spreads it. Never 1 — the chamber foot is the band's, not the axis's.
    expect(layout.heightFor(0)).toBe(1 - FLOOR_BAND);
  });

  it("gives a higher tip a smaller height, in both modes", () => {
    const scale = filled();
    for (const mode of ["logValue", "rank"] as const) {
      const layout = createFeeLayout(scale, mode);
      layout.refresh();
      expect(layout.heightFor(100 * GWEI)).toBeLessThan(
        layout.heightFor(1 * GWEI),
      );
    }
  });

  it("puts ticks on round gwei values, inside the field", () => {
    const scale = filled();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    const ticks = layout.ticks();
    expect(ticks.length).toBeGreaterThan(2);
    // Round values, not round heights. The label says "10 gwei" at whatever
    // height 10 gwei happens to be, so the number stays meaningful while the
    // axis rescales under it.
    const steps = [1, 1.5, 2, 3, 4, 5, 7];
    const isRound = (gwei: number) =>
      steps.some((step) =>
        [-2, -1, 0, 1, 2, 3].some(
          (decade) => Math.abs(gwei - step * 10 ** decade) < 1e-9,
        ),
      );
    for (const tick of ticks) {
      expect(isRound(tick.gwei)).toBe(true);
      // A value outside the window clamps to 0 or 1 and must never be
      // labelled — that would put a numeral where the value is not.
      expect(tick.height).toBeGreaterThan(0.02);
      expect(tick.height).toBeLessThan(0.98);
    }
    // Descending in height as the value rises.
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].height).toBeLessThan(ticks[i - 1].height);
    }
  });

  it("never leaves more than a fifth of the chamber unlabelled", () => {
    /**
     * The property the tick set exists for.
     *
     * Before, candidates stepped by 2x or 2.5x and the edge filter dropped any
     * that landed near an end, so the unlabelled band at the bottom was set by
     * where p1 happened to fall against the nearest round number — measured at
     * 13.6% in one window and reachable at 40% in another with no datum
     * changing.
     *
     * `refresh` forces the window to span at least a factor of ten, and the
     * candidate sequence never steps by more than 1.5x, so consecutive labels
     * are at most ln(1.5)/ln(10) = 17.6% apart. Thinning can widen a gap by at
     * most MIN_TICK_SPACING, giving 21.6%. The edges are within
     * TICK_EDGE_MARGIN of 0 and 1.
     *
     * Swept over three decades of window position and width, which is every
     * shape the axis can take.
     */
    const LIMIT = 0.216 + 1e-6;
    let worst = 0;
    let worstAt = "";
    for (let lowExp = -2; lowExp <= 2; lowExp += 0.25) {
      for (const ratio of [10, 13, 20, 50, 131, 400, 1000]) {
        const low = 10 ** lowExp * GWEI;
        const scale = createQuantileScale({ capacity: 4096, minSamples: 1 });
        // A log-uniform window spanning exactly `ratio`.
        for (let i = 0; i < 512; i++) {
          scale.push(low * ratio ** (i / 511));
        }
        scale.rebuild();
        const layout = createFeeLayout(scale, "logValue");
        layout.refresh();
        const heights = layout.ticks().map((t) => t.height);
        expect(heights.length).toBeGreaterThan(2);
        // Gaps between consecutive labels, and from each end of the axis —
        // which ends at the top of the floor band, not at the chamber foot.
        const marks = [0, ...[...heights].sort((a, b) => a - b), 1 - FLOOR_BAND];
        for (let i = 1; i < marks.length; i++) {
          const gap = marks[i] - marks[i - 1];
          if (gap > worst) {
            worst = gap;
            worstAt = `low=1e${lowExp} span=${ratio}x`;
          }
        }
      }
    }
    // Reported so a regression names the window it broke on rather than just
    // a number: this is how the 38.3% case at the top of the range surfaced.
    expect({ worstGap: +worst.toFixed(4), window: worstAt }).toMatchObject({
      worstGap: expect.any(Number),
    });
    expect(worst).toBeLessThan(LIMIT);
  });

  it("labels every step but rules only the 1-2-5 spine", () => {
    // Labels are cheap — a numeral at the margin. Rules cost ink across the
    // measured volume, and the grid has to vanish before the traces do.
    const scale = filled();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    const ticks = layout.ticks();
    const ruled = ticks.filter((t) => t.ruled);
    expect(ruled.length).toBeGreaterThan(1);
    expect(ruled.length).toBeLessThan(ticks.length);
    for (const tick of ruled) {
      const mantissa = tick.gwei / 10 ** Math.floor(Math.log10(tick.gwei) + 1e-9);
      expect([0.1, 0.2, 0.5, 1, 2, 5]).toContainEqual(
        Math.round(mantissa * 10) / 10,
      );
    }
  });

  it("puts a tick at exactly the height an entity of that fee would take", () => {
    // The bug this prevents: `heightFor` and the tick placement computed the
    // same thing twice, and a mode change moved one and not the other. They
    // are one function now, and this is what says so.
    const scale = filled();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    for (const tick of layout.ticks()) {
      expect(layout.heightFor(tick.gwei * GWEI)).toBe(tick.height);
    }
  });

  it("emits no ticks before the window is ready", () => {
    const scale = createQuantileScale({ capacity: 64 });
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    // An axis labelled from an empty window is a set of numbers with no
    // referent, which is worse than no axis.
    expect(layout.ticks()).toEqual([]);
  });

  it("rescales when the window moves, but only on refresh", () => {
    const scale = createQuantileScale({ capacity: 200 });
    for (let i = 0; i < 200; i++) scale.push((1 + i * 0.01) * GWEI);
    scale.rebuild();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    const before = layout.heightFor(2 * GWEI);

    for (let i = 0; i < 200; i++) scale.push((100 + i) * GWEI);
    scale.rebuild();
    // Bounds are cached, so the height cannot move until the layout is told.
    expect(layout.heightFor(2 * GWEI)).toBe(before);
    layout.refresh();
    expect(layout.heightFor(2 * GWEI)).not.toBe(before);
    expect(layout.heightFor(2 * GWEI)).toBe(1 - FLOOR_BAND); // now below the window
  });
});

describe("the axis will not position anything it cannot justify", () => {
  /**
   * The startup transient this exists to prevent.
   *
   * With an empty window `valueAt` returns 0, the bounds collapse to a decade
   * every real tip sits above, and `heightFor` puts everything from 0.1 gwei
   * to 100 gwei at the top of the chamber. Measured against the default
   * generator, the maximum height error against a full window:
   *
   *     samples      0     16     64    128    256
   *     max error  98.1%  18.3%  18.3%   3.6%   1.9%
   *
   * Marks used to spawn into that and then glide to the truth over 900ms, so
   * for two or three seconds the whole population displayed a fee it did not
   * have — at the exact moment a first-time visitor arrives.
   */
  const GWEI = 1e9;

  function windowOf(n: number) {
    const scale = createQuantileScale({ capacity: 4096, minSamples: 1 });
    for (let i = 0; i < n; i++) {
      scale.push(Math.exp(Math.log(GWEI) + ((i % 97) / 97 - 0.5) * 6));
    }
    scale.rebuild();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    return layout;
  }

  it("reports itself uncalibrated below the threshold", () => {
    for (const n of [0, 1, 64, MIN_AXIS_SAMPLES - 1]) {
      expect(windowOf(n).calibrated()).toBe(false);
    }
    expect(windowOf(MIN_AXIS_SAMPLES).calibrated()).toBe(true);
    expect(windowOf(MIN_AXIS_SAMPLES).samples()).toBe(MIN_AXIS_SAMPLES);
  });

  it("outranks the window's own readiness, which is not enough", () => {
    // `minSamples` is 64 and governs whether the window can be asked. At 64
    // the axis is still 18% wrong, so being answerable is not being right.
    const scale = createQuantileScale({ capacity: 4096, minSamples: 64 });
    for (let i = 0; i < 64; i++) scale.push((i + 1) * GWEI);
    scale.rebuild();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    expect(scale.ready()).toBe(true);
    expect(layout.calibrated()).toBe(false);
  });

  it("labels no ticks until it is calibrated", () => {
    // A label names a height. Naming one on an 18%-wrong axis points at a
    // place the value does not sit.
    expect(windowOf(MIN_AXIS_SAMPLES - 1).ticks()).toEqual([]);
    expect(windowOf(MIN_AXIS_SAMPLES).ticks().length).toBeGreaterThan(0);
  });

  it("takes no arrivals into the field while uncalibrated", () => {
    const world = createWorld({ maxEntities: 50, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.axisCalibrated = false;
    enqueue(world, Array.from({ length: 200 }, () => tx()));
    step(world, 100, 1_700_000_000_000);
    // Not placed and corrected later — not placed at all.
    expect(world.entities).toHaveLength(0);
    // And not lost: they are still queued for when the axis means something.
    expect(world.inbox.length).toBe(200);

    world.axisCalibrated = true;
    step(world, 100, 1_700_000_000_100);
    expect(world.entities.length).toBeGreaterThan(0);
    expect(world.inbox).toHaveLength(0);
  });

  it("bounds the queue so an axis that never calibrates cannot grow it", () => {
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.axisCalibrated = false;
    for (let i = 0; i < 40; i++) {
      enqueue(world, Array.from({ length: 50 }, () => tx()));
    }
    expect(world.inbox.length).toBe(world.maxEntities * 8);
  });
});

describe("tick labels are printable", () => {
  it("carries no binary floating-point noise", () => {
    // The chrome prints `tick.gwei` verbatim. `1.5 * 10 ** -1` is
    // 0.15000000000000002, and a scale reading that is not a scale.
    const scale = filled();
    const layout = createFeeLayout(scale, "logValue");
    layout.refresh();
    for (const tick of layout.ticks()) {
      expect(String(tick.gwei).length).toBeLessThanOrEqual(6);
      expect(String(tick.gwei)).not.toContain("000000");
      expect(String(tick.gwei)).not.toContain("999999");
    }
  });
});

describe("the floor band", () => {
  /**
   * Most of a mainnet pool offers nothing above the base fee, and a log axis
   * clamps all of it to one rule. The band gives that population height to
   * spread into; the axis runs above it and never reaches inside.
   */
  it("keeps the axis above the band and puts the floor on its top edge", () => {
    const scale = createQuantileScale({ minSamples: 8 });
    for (let i = 0; i < MIN_AXIS_SAMPLES; i++) scale.push((0.01 + i * 0.01) * 1e9);
    scale.rebuild();
    const layout = createFeeLayout(scale);
    layout.refresh();
    expect(layout.heightFor(MIN_TIP_WEI)).toBe(1 - FLOOR_BAND);
    expect(layout.heightFor(0)).toBe(1 - FLOOR_BAND);
    expect(layout.heightFor(1e12)).toBeGreaterThanOrEqual(0);
    for (const tip of [2e6, 1e8, 1e9, 5e9]) {
      expect(layout.heightFor(tip)).toBeLessThanOrEqual(1 - FLOOR_BAND);
    }
    expect(atFloor(MIN_TIP_WEI)).toBe(true);
    expect(atFloor(MIN_TIP_WEI + 1)).toBe(false);
  });

  it("labels no tick inside the band", () => {
    const scale = createQuantileScale({ minSamples: 8 });
    for (let i = 0; i < MIN_AXIS_SAMPLES; i++) scale.push((0.001 + i * 0.05) * 1e9);
    scale.rebuild();
    const layout = createFeeLayout(scale);
    layout.refresh();
    const ticks = layout.ticks();
    expect(ticks.length).toBeGreaterThan(3);
    for (const tick of ticks) expect(tick.height).toBeLessThan(1 - FLOOR_BAND);
  });
});
