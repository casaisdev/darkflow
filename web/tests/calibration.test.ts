import { describe, expect, it } from "vitest";
import {
  MIN_RATIO_WINDOW_BLOCKS,
  RATIO_WINDOW_BLOCKS,
  readout,
} from "@/lib/readout";
import { createSeenSet, type SeenSet } from "@/lib/seen";
import {
  applyBlock,
  createWorld,
  type BlockArrival,
  type WorldState,
} from "@/lib/canvas/world";
import type { BlockEvent } from "@/types/stream";
import { eip1559, hashOf, resetHashes } from "./helpers";

/**
 * The cold start, which is the second of the two ways this product could lie.
 *
 * A transaction can sit in the pool for minutes, so one that arrived before we
 * connected lands later and looks private when it was not. Until the seen-set
 * has either been seeded from a snapshot or watched enough blocks, there is no
 * claim to make — and the rule is that the claim is not *made*, not that it is
 * hidden. A hidden number is still a number that was computed; the whole point
 * is that nothing is computed.
 *
 * Which is why every ghost figure here is asserted to be `null` rather than
 * `0`. Zero would render as "0.0% never seen by this node", which is a
 * confident and false statement about the Ethereum network.
 */

const NOW = 1_700_000_000_000;

function landBlock(
  world: WorldState,
  seen: SeenSet,
  { ghosts, seenCount }: { ghosts: number; seenCount: number },
) {
  const total = ghosts + seenCount;
  const hashes = Array.from({ length: total }, (_, i) => hashOf(i));
  // Only the public ones were ever announced.
  for (let i = ghosts; i < total; i++) {
    seen.add(hashes[i], {
      firstSeen: NOW - 5000,
      fees: eip1559(2, 30),
      gas: 21000,
      included: false,
    });
  }
  const gasUsed = hashes.map((_, i) => (i < ghosts ? 120_000 : 40_000));
  const block: BlockEvent = {
    number: 21_000_000,
    timestamp: NOW,
    baseFeePerGas: 12e9,
    hashes,
    gasUsed,
  };
  const warm = seen.isWarm();
  const arrivals: BlockArrival[] = hashes.map((hash, index) => {
    const record = seen.get(hash);
    if (record) return { hash, index, origin: "seen", record, gasUsed: gasUsed[index] };
    // Exactly what `Viz` does: while cold, an unrecognised hash is `unknown`,
    // which is not the same thing as `ghost` and is not drawn as one.
    return {
      hash,
      index,
      origin: warm ? ("ghost" as const) : ("unknown" as const),
      gasUsed: gasUsed[index],
    };
  });
  applyBlock(world, block, arrivals, () => 0.5);
  seen.noteBlock();
  return block;
}

function fresh() {
  resetHashes();
  const world = createWorld({ maxEntities: 10, topQuota: 0 });
  world.heightFor = () => 0.5;
  return world;
}

const inputs = (world: WorldState, seen: SeenSet) => ({
  world,
  seen,
  ticks: [],
  recentRatios: [],
  axisSamples: 4096,
  axisBounds: { low: 1e8, high: 1e11 },
  view: { width: 1440, height: 900 },
  lastBlockAt: NOW,
  lastEventAt: NOW,
  subscribed: true,
  budgetReduced: false,
  now: NOW + 1500,
});

describe("calibration", () => {
  it("reports every ghost figure as null while cold, never as zero", () => {
    const world = fresh();
    const seen = createSeenSet({ warmupBlocks: 5 });
    landBlock(world, seen, { ghosts: 12, seenCount: 38 });

    const state = readout(inputs(world, seen));
    expect(state.calibration.active).toBe(true);
    expect(state.ghostCount).toBeNull();
    expect(state.ghostRatio).toBeNull();
    expect(state.ghostGasRatio).toBeNull();
    // Not merely falsy. `0` and `null` are both falsy and only one of them is
    // the truth, so identity is what is asserted.
    expect(state.ghostCount).not.toBe(0);
    expect(state.ghostGasRatio).not.toBe(0);
  });

  it("does not classify while cold — nothing carries the ghost origin", () => {
    const world = fresh();
    const seen = createSeenSet({ warmupBlocks: 5 });
    landBlock(world, seen, { ghosts: 12, seenCount: 38 });
    // The classification is not made, not made-and-hidden. There is no mark in
    // the world holding the answer for the chrome to filter out later.
    expect(world.block.filter((mark) => mark.origin === "ghost")).toEqual([]);
    expect(world.block.filter((mark) => mark.origin === "unknown").length).toBe(
      12,
    );
  });

  it("still reports everything it does know", () => {
    const world = fresh();
    const seen = createSeenSet({ warmupBlocks: 5 });
    landBlock(world, seen, { ghosts: 12, seenCount: 38 });
    const state = readout(inputs(world, seen));
    // Calibration withholds one claim, not the whole instrument. A panel that
    // went blank would read as a broken feed rather than as a warm-up.
    expect(state.blockNumber).toBe(21_000_000);
    expect(state.blockTxCount).toBe(50);
    expect(state.baseFeeGwei).toBe(12);
    expect(state.pending).toBe(38);
    expect(state.sinceBlockSeconds).toBe(1.5);
  });

  it("starts reporting once the warm-up closes, and the numbers are right", () => {
    const world = fresh();
    const seen = createSeenSet({ warmupBlocks: 1 });
    // The block that closes the warm-up was classified before it counted, so
    // it holds no classification. Calibration is over, and this block still
    // has no ratio — reporting one would print 0.0% for twelve seconds.
    landBlock(world, seen, { ghosts: 12, seenCount: 38 });
    expect(seen.isWarm()).toBe(true);
    expect(readout(inputs(world, seen)).calibration.active).toBe(false);
    expect(readout(inputs(world, seen)).ghostRatio).toBeNull();
    expect(readout(inputs(world, seen)).ghostCount).toBeNull();
    expect(readout(inputs(world, seen)).ghostGasRatio).toBeNull();

    const second = fresh();
    landBlock(second, seen, { ghosts: 12, seenCount: 38 });
    const state = readout(inputs(second, seen));
    expect(state.calibration.active).toBe(false);
    expect(state.ghostCount).toBe(12);
    expect(state.ghostRatio).toBeCloseTo(12 / 50, 10);
    // By gas, not by count: 12 rows at 120,000 against 38 at 40,000.
    expect(state.ghostGasRatio).toBeCloseTo(
      (12 * 120_000) / (12 * 120_000 + 38 * 40_000),
      10,
    );
    // And the two figures genuinely differ, or the test would prove nothing.
    expect(state.ghostGasRatio).toBeGreaterThan(state.ghostRatio! + 0.1);
  });

  it("reports a snapshot-closed calibration immediately", () => {
    resetHashes();
    const world = fresh();
    const seen = createSeenSet({ warmupBlocks: 5 });
    seen.seedFromSnapshot([]);
    landBlock(world, seen, { ghosts: 12, seenCount: 38 });
    const state = readout(inputs(world, seen));
    expect(state.calibration.closedBy).toBe("snapshot");
    expect(state.ghostRatio).toBeCloseTo(12 / 50, 10);
  });

  it("reports no block as null rather than as an empty one", () => {
    const world = fresh();
    const seen = createSeenSet();
    seen.seedFromSnapshot([]);
    const state = readout({ ...inputs(world, seen), lastBlockAt: null });
    expect(state.blockNumber).toBeNull();
    expect(state.blockTxCount).toBeNull();
    expect(state.baseFeeGwei).toBeNull();
    expect(state.sinceBlockSeconds).toBeNull();
    // Warm, but with nothing to report yet: still null, because a ratio over
    // an empty block is not zero, it is undefined.
    expect(state.ghostRatio).toBeNull();
    expect(state.ghostGasRatio).toBeNull();
  });

  it("calls a deliberately paused stream null, not stale", () => {
    const world = fresh();
    const seen = createSeenSet();
    // A hidden tab drops the subscription on purpose. Reporting the silence as
    // a dead stream told anyone glancing back at a tab that the app had failed.
    const paused = readout({ ...inputs(world, seen), subscribed: false });
    expect(paused.staleSeconds).toBeNull();
    const live = readout(inputs(world, seen));
    expect(live.staleSeconds).toBe(1.5);
  });

  describe("the scale the reading is taken against", () => {
    /** A window of `n` ratios spanning a full 10–40% spread. */
    const spread = (n: number) =>
      Array.from({ length: n }, (_, i) => 0.1 + (0.3 * i) / Math.max(1, n - 1));

    function withWindow(n: number) {
      const world = fresh();
      const seen = createSeenSet();
      seen.seedFromSnapshot([]);
      landBlock(world, seen, { ghosts: 12, seenCount: 38 });
      return readout({ ...inputs(world, seen), recentRatios: spread(n) });
    }

    it("draws no band below the threshold, however wide the samples are", () => {
      // The samples handed in below span the entire 10–40% range, so this is
      // not a case of there being nothing to show. It is refused because
      // min/max over a handful of blocks is a badly biased estimator of a
      // spread, and the band's width is read as the claim. Measured against
      // the default generator: two samples recover 32.8% of the true spread,
      // three recover 49.0%. A band that narrow does not read as thin evidence
      // — it reads as a figure that holds steady.
      for (let n = 0; n < MIN_RATIO_WINDOW_BLOCKS; n++) {
        const state = withWindow(n);
        expect(state.ghostRatioWindow).toBeNull();
        // And the shortfall is stated rather than left as a silent absence,
        // which would itself read as "no variation".
        expect(state.ratioSamples).toBe(n);
      }
    });

    it("draws the band from exactly the threshold on", () => {
      expect(withWindow(MIN_RATIO_WINDOW_BLOCKS - 1).ghostRatioWindow).toBeNull();
      const state = withWindow(MIN_RATIO_WINDOW_BLOCKS);
      expect(state.ghostRatioWindow).not.toBeNull();
      expect(state.ghostRatioWindow?.blocks).toBe(MIN_RATIO_WINDOW_BLOCKS);
    });

    it("labels the band with the count it was built from, never the capacity", () => {
      // The threshold governs how much authority the geometry may claim; the
      // label keeps it literally true meanwhile. A band from twelve blocks
      // that said "last 20 blocks" would be a second, quieter version of the
      // same lie.
      for (const n of [12, 15, RATIO_WINDOW_BLOCKS]) {
        expect(withWindow(n).ghostRatioWindow?.blocks).toBe(n);
      }
    });

    it("sits at twelve blocks, where the estimator stops materially understating", () => {
      // 82.1% of the true spread recovered, against 32.8% at two. Pinned so
      // the threshold cannot be quietly relaxed back toward a decorative band.
      expect(MIN_RATIO_WINDOW_BLOCKS).toBe(12);
      expect(MIN_RATIO_WINDOW_BLOCKS).toBeLessThanOrEqual(RATIO_WINDOW_BLOCKS);
    });

    it("reports the spread, not the order the blocks arrived in", () => {
      const world = fresh();
      const seen = createSeenSet();
      seen.seedFromSnapshot([]);
      landBlock(world, seen, { ghosts: 12, seenCount: 38 });
      const state = readout({
        ...inputs(world, seen),
        axisSamples: 4096,
  axisBounds: { low: 1e8, high: 1e11 },
  view: { width: 1440, height: 900 },
        recentRatios: [0.31, 0.19, 0.27, 0.4, 0.22, 0.3, 0.25, 0.33, 0.21, 0.28, 0.35, 0.24],
      });
      expect(state.ghostRatioWindow).toEqual({
        low: 0.19,
        high: 0.4,
        blocks: 12,
      });
    });
  });

  describe("the gas the block's widest row stands for", () => {
    it("reports the block maximum, which is what row width is normalised over", () => {
      const world = fresh();
      const seen = createSeenSet();
      seen.seedFromSnapshot([]);
      landBlock(world, seen, { ghosts: 12, seenCount: 38 });
      // 12 ghosts at 120,000 against 38 public at 40,000.
      expect(readout(inputs(world, seen)).blockMaxGas).toBe(120_000);
    });

    it("is null with no block, rather than zero", () => {
      const world = fresh();
      const seen = createSeenSet();
      seen.seedFromSnapshot([]);
      // Zero would label the scale "0 gas", which is a unit and a lie at once.
      expect(readout(inputs(world, seen)).blockMaxGas).toBeNull();
    });
  });

  it("reports the real pool, not the drawn sample", () => {
    const world = fresh();
    const seen = createSeenSet();
    seen.seedFromSnapshot([]);
    for (let i = 0; i < 5000; i++) {
      seen.add(hashOf(100_000 + i), {
        firstSeen: NOW,
        fees: eip1559(1, 30),
        gas: 21000,
        included: false,
      });
    }
    const state = readout(inputs(world, seen));
    // The render samples 300 of the pool. Reporting what was drawn would make
    // the counter a statement about the renderer rather than about the mempool.
    expect(state.pending).toBe(5000);
    expect(state.pending).toBeGreaterThan(world.maxEntities);
    expect(world.entities.length).toBe(0);
  });
});
