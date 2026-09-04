import type { QuantileScale } from "@/lib/quantile";

/**
 * How a priority fee becomes a place on screen and a place on the ramp.
 *
 * ## Two transforms of one quantity, and why they differ
 *
 * **Luminance takes the rank.** A transaction's brightness answers "how
 * expensive is this compared to what else is queued right now", so it must be
 * a percentile — otherwise the field is dim at 03:00 and blown out at 15:00
 * for reasons that have nothing to do with anything.
 *
 * **Height takes the value.** A rank is uniform by construction: map height to
 * percentile and the entities spread *evenly* up the screen, because that is
 * what percentiles are. The clustering we want — a dense band at the median,
 * expensive outliers alone at the top — is the shape of the fee distribution,
 * and ranking is precisely the operation that destroys that shape. So height
 * takes log(fee), normalised between the window's own p1 and p99 so it still
 * rescales with the market.
 *
 * Both are monotonic in fee, so they never disagree: higher is always brighter
 * and always further up. Only the spacing differs, and the spacing is the
 * information.
 */

export type LayoutMode = "rank" | "logValue";

/**
 * Samples the rolling window needs before a height means a fee.
 *
 * Below this the axis is not merely imprecise, it is degenerate. Measured
 * against the default generator, the maximum error in a mark's height against
 * a full window:
 *
 *     samples      0     16     32     64    128    256    512   1024
 *     max error  98.1%  18.3%  22.7%  18.3%   3.6%   1.9%   1.4%   1.4%
 *
 * At zero samples every probe from 0.1 gwei to 100 gwei lands at height 0.00 —
 * the top of the chamber — because `valueAt` returns 0 on an empty window and
 * the bounds collapse to a decade that every real tip sits above. A 0.1 gwei
 * transaction, which belongs at 0.98, is drawn where 20 gwei belongs.
 *
 * 256 rather than 128 because of what it is compared against: a mark's ambient
 * drift is DRIFT_AMPLITUDE_Y·1.4 = 1.54% of the chamber, and at 256 the axis
 * error is 1.9% — the same order, so a calibrated axis stops being
 * distinguishable from a settled one. At 128 the error is 3.6%, more than twice
 * the drift, and would read as marks sitting in the wrong place.
 *
 * It is not `QuantileScale.minSamples` (64). That threshold governs whether
 * the window can be *asked* a question; this one governs whether the answer is
 * worth drawing, and at 64 the axis is still 18% wrong.
 *
 * The cost is under a second: at a few hundred tx/s this fills in ~0.85s, and
 * an opening snapshot clears it in one batch.
 */
export const MIN_AXIS_SAMPLES = 256;

export type FeeLayout = {
  /** Vertical home, 0 at the top of the field where the expensive sit. */
  heightFor(tip: number): number;
  /** Position on the cold ramp, 0..1. Always the rank. */
  rampFor(tip: number): number;
  /** Recomputes cached bounds. Call whenever the scale is rebuilt. */
  refresh(): void;
  /**
   * Whether a height from this layout is a statement about a fee.
   *
   * Nothing may be positioned by it until this is true. See
   * `MIN_AXIS_SAMPLES`.
   */
  calibrated(): boolean;
  /** Samples behind the axis, whether or not there are enough. */
  samples(): number;
  /**
   * The tips at the top and bottom of the chamber, in wei.
   *
   * Exposed so the chrome can invert the axis — turn a pointer height back into
   * a fee — without a second copy of the mapping that could disagree with this
   * one about where a value sits.
   */
  bounds(): { low: number; high: number };
  mode(): LayoutMode;
  /** Switches mapping. Exists so the two can be measured, not to be toggled. */
  setMode(next: LayoutMode): void;
  /**
   * Tick marks for the fee axis: round gwei values and where they sit.
   *
   * The axis is what turns the field from scattered dots into readings. Ticks
   * are chosen at round values rather than at even heights, so the label says
   * "10 gwei" at whatever height 10 gwei happens to be — the number stays
   * meaningful while the axis rescales under it.
   */
  ticks(): readonly FeeTick[];
};

export type FeeTick = {
  /** Tip in gwei. */
  gwei: number;
  /** Normalised height, 0 at the top of the field. */
  height: number;
  /** Whether this one also carries a rule across the chamber. */
  ruled: boolean;
};

/**
 * Which ticks get a numeral at this chamber height.
 *
 * Ticks are chosen at round values, not at even heights, so their spacing in
 * pixels is whatever the chamber's height makes it. On a desktop the chamber
 * is 560px and the closest pair sits 33px apart; on a phone held sideways it
 * is 220px and the pair is 13px apart, which is less than a numeral is tall.
 * Measured at 844×390: nine pairs of numerals overlapping. The rules across
 * the chamber cost nothing to keep; the numerals must not touch. Ruled ticks
 * — the 1-2-5 spine — are placed first, then the rest wherever a gap of
 * `minGapPx` remains. The returned list keeps the axis order.
 */
export function thinTicks(
  ticks: readonly FeeTick[],
  chamberPx: number,
  minGapPx = 14,
): readonly FeeTick[] {
  const byPriority = [...ticks].sort((a, b) => Number(b.ruled) - Number(a.ruled));
  const kept: FeeTick[] = [];
  for (const tick of byPriority) {
    const y = tick.height * chamberPx;
    if (kept.every((k) => Math.abs(k.height * chamberPx - y) >= minGapPx)) kept.push(tick);
  }
  return kept.sort((a, b) => a.height - b.height);
}

/**
 * Round values worth labelling, per decade.
 *
 * A 1-2-5 sequence leaves consecutive candidates a factor of 2 or 2.5 apart,
 * and `refresh` only guarantees the window spans a factor of ten, so in the
 * worst case one gap was ln(2.5)/ln(10) = 40% of the chamber with nothing
 * labelled in it. Worse, which gap you got depended on where p1 happened to
 * fall against the nearest round number — measured once at 13.6% and reachable
 * at 40% without a single datum changing. An axis whose label density is
 * decided by luck is not an axis.
 *
 * This sequence never steps by more than 1.5x, so the worst gap is now
 * ln(1.5)/ln(10) = 17.6% of the chamber, whatever the window.
 */
const TICK_DECADE = [1, 1.5, 2, 3, 4, 5, 7];

/**
 * The subset that also gets a rule across the chamber.
 *
 * Every candidate gets a numeral, because a label costs a few pixels at the
 * margin. A rule costs ink across the measured volume, and the grid is meant to
 * disappear before the traces do when you squint — so ruling all fourteen would
 * turn the scale into a pattern. Rules stay on the 1-2-5 spine, roughly six of
 * them, exactly as before.
 */
const RULED_DECADE = new Set([1, 2, 5]);

/**
 * Every decade the axis can actually produce.
 *
 * Not "every decade the chain plausibly uses". `refresh` floors the low bound
 * at MIN_TIP_WEI (0.001 gwei) and puts no ceiling on the high one, so a
 * candidate list that stops early leaves the top of the axis unlabelled — and
 * the property test caught exactly that: a window reaching 100,000 gwei had its
 * top 38.3% bare because the list ended at 7,000. Ninety-one entries cost
 * nothing and the out-of-window ones are dropped on the first pass anyway.
 */
const TICK_CANDIDATES: { gwei: number; ruled: boolean }[] = [];
for (let decade = -3; decade <= 9; decade++) {
  for (const step of TICK_DECADE) {
    TICK_CANDIDATES.push({
      // Rounded at construction, not at the label. `1.5 * 10 ** -1` is
      // 0.15000000000000002 in binary floating point, and the chrome prints
      // this value verbatim — a scale reading "0.15000000000000002 gwei" is
      // not a scale. Two significant figures is exactly what the sequence
      // carries, so nothing is lost.
      gwei: Number((step * 10 ** decade).toPrecision(2)),
      ruled: RULED_DECADE.has(step),
    });
  }
}

/**
 * Closest two labels may sit before one is dropped.
 *
 * Only bites on very wide windows, where the dense sequence would print
 * numerals a couple of dozen pixels apart. Dropping one can widen a gap by at
 * most this much, so the guarantee above becomes 17.6% + 4% = 21.6% worst case.
 */
const MIN_TICK_SPACING = 0.04;

/**
 * How close to an edge a label may sit.
 *
 * Was 0.04, which dropped a candidate genuinely inside the window for being
 * near the end — and the end is where a reader most needs an anchor. A value
 * *outside* the window still cannot be labelled: `heightForTip` clamps, so it
 * lands on exactly 0 or 1 and is excluded here, because a label at the clamp
 * would name a height the value does not have.
 */
const TICK_EDGE_MARGIN = 0.02;

/** Guards against log(0) and against a degenerate window. */
export const MIN_TIP_WEI = 1e6; // 0.001 gwei

/**
 * The share of the chamber's height given to the transactions at the floor.
 *
 * On mainnet most of the pool offers nothing above the base fee — 65.8% of
 * what the recording announced, 89% of what was pending at one moment. The
 * axis clamped every one of them to its lowest rule, and since a rule is one
 * pixel tall they landed on the same line, on top of each other, fused by
 * additive blending into a row of twenty dots. The chamber's largest
 * population was its least visible.
 *
 * So the foot of the chamber is a band, not a line. A transaction at the
 * floor is placed somewhere inside it — its y within the band is packing
 * space, like x, and carries nothing — and the log axis runs above it. The
 * band's population is then legible as density, which is the only honest way
 * a count can be read off a picture. Eight percent: enough height for several
 * hundred marks to spread without stacking, small enough that the axis above
 * loses less than a tick's worth of room.
 */
export const FLOOR_BAND = 0.08;

/** Whether a tip lands in the floor band rather than on the axis. */
export function atFloor(tip: number): boolean {
  return tip <= MIN_TIP_WEI;
}

export function createFeeLayout(
  scale: QuantileScale,
  initialMode: LayoutMode = "logValue",
): FeeLayout {
  // Held in a closure variable, not as a property on the returned object: a
  // property would be read by nothing, because `heightFor` closes over this.
  let mode = initialMode;
  let logLow = Math.log(MIN_TIP_WEI);
  let logHigh = Math.log(MIN_TIP_WEI * 1000);

  function refresh(): void {
    // p1..p99 rather than min..max: two outliers must not squash everyone else
    // into a sliver in the middle of the screen.
    const low = Math.max(MIN_TIP_WEI, scale.valueAt(0.01));
    const high = Math.max(low * 10, scale.valueAt(0.99));
    logLow = Math.log(low);
    logHigh = Math.log(high);
  }

  function heightForTip(tip: number): number {
    // The floor is the band's *top*; the world spreads a floor mark below it.
    // Returned as the edge so a tick at the floor value labels the band's
    // boundary, and nothing on the axis ever sits inside the band.
    if (atFloor(tip)) return 1 - FLOOR_BAND;
    const axis = 1 - FLOOR_BAND;
    if (mode === "rank") return (1 - scale.percentile(tip)) * axis;
    const value = Math.log(Math.max(MIN_TIP_WEI, tip));
    const span = logHigh - logLow;
    const normalised = span > 0 ? (value - logLow) / span : 0.5;
    return (1 - Math.min(1, Math.max(0, normalised))) * axis;
  }

  return {
    mode: () => mode,
    setMode(next) {
      mode = next;
    },
    refresh,
    rampFor: (tip) => scale.percentile(tip),
    calibrated: () => scale.size() >= MIN_AXIS_SAMPLES,
    bounds: () => ({ low: Math.exp(logLow), high: Math.exp(logHigh) }),
    samples: () => scale.size(),
    ticks() {
      // Gated on calibration, not on `ready()`. At `ready()`'s 64 samples the
      // axis is still 18% wrong, so a label there names a height that is not
      // where that value sits.
      if (!scale.ready() || scale.size() < MIN_AXIS_SAMPLES) return [];
      const out: FeeTick[] = [];
      let lastHeight = Number.NEGATIVE_INFINITY;
      // Candidates run low gwei to high, so heights run bottom to top.
      // Walking them in descending height keeps the thinning stable from the
      // top down rather than depending on which end the list starts at.
      for (let i = TICK_CANDIDATES.length - 1; i >= 0; i--) {
        const { gwei, ruled } = TICK_CANDIDATES[i];
        const height = heightForTip(gwei * 1e9);
        // A clamped height means the value is outside the window: labelling it
        // would put a numeral where that value is not.
        // The axis ends at the band's top, so that is the edge here.
        if (
          height <= TICK_EDGE_MARGIN ||
          height >= 1 - FLOOR_BAND - TICK_EDGE_MARGIN
        ) {
          continue;
        }
        if (height - lastHeight < MIN_TICK_SPACING) continue;
        lastHeight = height;
        out.push({ gwei, height, ruled });
      }
      return out.reverse();
    },
    // Delegated, so a tick and an entity at the same fee cannot end up at
    // different heights.
    heightFor: heightForTip,
  };
}
