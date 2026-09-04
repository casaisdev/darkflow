import { describe, expect, it } from "vitest";
import {
  BLOCK_EXTENT,
  BLOCK_RIGHT,
  BLOCK_WIDTH,
  gasWidthFraction,
  STRIP_RIGHT,
  STRIP_WIDTH,
  TOP_SLOT_TAB,
  render,
  slotRect,
  widthForGas,
} from "@/lib/canvas/draw";
import {
  applyBlock,
  createWorld,
  step,
  type BlockArrival,
} from "@/lib/canvas/world";
import { MIN_RATIO_WINDOW_BLOCKS, readout } from "@/lib/readout";
import { createSeenSet } from "@/lib/seen";
import type { BlockEvent } from "@/types/stream";
import {
  eip1559,
  hashOf,
  palette,
  recordingContext,
  resetHashes,
  view,
} from "./helpers";

/**
 * Does the picture agree with the number?
 *
 * The panel prints two figures — the share of transactions that never touched
 * the mempool, and the share of the gas they consumed — and the block draws a
 * stack of rows in which class is the tone and gas is the width. The warm area
 * of that stack is what a reader actually perceives, so it has to be a figure
 * the panel also prints, and not a third one nobody can name.
 *
 * What it is, exactly:
 *
 *     warm area / total area = Σ_ghost w(gas) / Σ_all w(gas)
 *     where w(gas) = MIN_ROW_WIDTH + (1 - MIN_ROW_WIDTH) · √(gas/maxGas)
 *
 * So the area is the gas share *compressed toward the transaction share* by the
 * 18% floor and by the root (see `gasWidthFraction` for why the root). When the two classes consume gas alike the two collapse into one
 * number and the area equals the transaction ratio — which is the case the
 * default generator produces and which every visual constant was calibrated
 * against. When they diverge, the area sits between the two printed figures,
 * nearer the count. It is never a number the panel does not carry.
 */

const NOW = 1_700_000_000_000;

/**
 * How closely a measured area may be expected to match a predicted one.
 *
 * Derived rather than observed, because it moved once already: rows are snapped
 * to whole device pixels, so at this pitch each row is one of two heights, and
 * a periodic ghost pattern can correlate with that alternation.
 *
 * One device pixel out of the slot pitch is (1/dpr)/pitch of a row's height.
 * At 160 rows over BLOCK_EXTENT on a 900px view at dpr 2 that is 0.5/3.94 =
 * 12.7%. In the worst case every warm row is short and every cold one tall, so
 * the warm share moves by at most 0.127 x share x (1 - share), which at a 25%
 * warm share is 0.024.
 *
 * Raising BLOCK_TOP to make room for the region header shrank the pitch and
 * pushed the real skew from 0.001 to 0.018, which the old hand-fitted bound of
 * 0.005 caught. Hence a derived bound: it tracks the geometry instead of the
 * last measurement.
 */
const SNAP_TOLERANCE = 0.025;
const options = {
  showGhosts: true,
  ticks: [],
  recentRatios: [],
  markScale: 1,
  reducedMotion: false,
};

/** Builds a landed block and measures the warm fraction of the drawn area. */
function measure(spec: { ghostGas: number; seenGas: number; ghosts: number; total: number }) {
  resetHashes();
  const world = createWorld({ maxEntities: 10, topQuota: 0 });
  world.heightFor = () => 0.5;
  const seen = createSeenSet();
  seen.seedFromSnapshot([]);

  const hashes = Array.from({ length: spec.total }, (_, i) => hashOf(i));
  // Interleaved, as private flow is in a real block.
  const isGhost = (i: number) => i % Math.round(spec.total / spec.ghosts) === 0;
  const gasUsed = hashes.map((_, i) => (isGhost(i) ? spec.ghostGas : spec.seenGas));
  const block: BlockEvent = {
    number: 21_000_000,
    timestamp: NOW,
    baseFeePerGas: 12e9,
    hashes,
    gasUsed,
  };
  const arrivals: BlockArrival[] = hashes.map((hash, index) => ({
    hash,
    index,
    origin: isGhost(index) ? "ghost" : "seen",
    record: isGhost(index)
      ? undefined
      : { firstSeen: NOW - 5000, fees: eip1559(2, 30), gas: spec.seenGas },
    gasUsed: gasUsed[index],
  }));
  applyBlock(world, block, arrivals, () => 0.5);
  seen.noteBlock();
  step(world, 3000, NOW); // settle, so nothing is flashing or flying

  const { ctx, calls } = recordingContext();
  render(ctx, world, palette, view, NOW, () => 0.5, options);

  const left = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
  const right = view.width * BLOCK_RIGHT;
  const pitch = (view.height * BLOCK_EXTENT) / spec.total;
  const rows = calls.filter(
    (call) =>
      call.op === "fillRect" &&
      call.x >= left - TOP_SLOT_TAB - 1 &&
      call.x + call.w <= right + 1 &&
      // 0.6 rather than 0.5: at some pitches the 2px block cap clears half a
        // slot and gets counted as a row, which it is not.
        call.h > pitch * 0.6,
  );
  expect(rows.length).toBe(spec.total);

  const warmFill = `rgba(${palette.ghostSettled.r}, ${palette.ghostSettled.g}, ${palette.ghostSettled.b}`;
  let warm = 0;
  let total = 0;
  rows.forEach((row) => {
    if (row.op !== "fillRect") return;
    const area = row.w * row.h;
    total += area;
    if (row.fill.startsWith(warmFill)) warm += area;
  });

  const state = readout({
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
    now: NOW,
  });

  const ghostCount = hashes.filter((_, i) => isGhost(i)).length;
  return {
    warmArea: warm / total,
    byTx: state.ghostRatio!,
    byGas: state.ghostGasRatio!,
    ghostCount,
  };
}

describe("what the block draws against what the panel says", () => {
  it("matches the transaction ratio when the classes consume gas alike", () => {
    // The default generator's case, and the one every visual constant in this
    // repo was calibrated against. Measured in the browser at 27.2% warm area
    // against 26.7% of transactions; here the same relation holds exactly,
    // because with one gas figure the width term cancels out of the ratio.
    const { warmArea, byTx, byGas } = measure({
      ghostGas: 60_000,
      seenGas: 60_000,
      ghosts: 40,
      total: 160,
    });
    expect(byGas).toBeCloseTo(byTx, 10);
    expect(Math.abs(warmArea - byTx)).toBeLessThan(SNAP_TOLERANCE);
  });

  it("moves toward the gas ratio when the classes diverge, and stops between", () => {
    // The MEV scenario's case: private flow at twice the gas of everything
    // else. The area must move — a picture that ignored gas while the panel
    // reported it would be a meter disagreeing with its own instrument — but
    // it is compressed by the 18% floor, so it lands between the two figures
    // rather than on the gas one.
    const { warmArea, byTx, byGas } = measure({
      ghostGas: 140_000,
      seenGas: 50_000,
      ghosts: 40,
      total: 160,
    });
    expect(byGas).toBeGreaterThan(byTx + 0.15);
    expect(warmArea).toBeGreaterThan(byTx);
    expect(warmArea).toBeLessThan(byGas);
    // And it is not a third, unnamed number: it is exactly the width formula,
    // which is the only thing width has ever encoded here.
    const w = gasWidthFraction;
    const predicted =
      (40 * w(140_000, 140_000)) /
      (40 * w(140_000, 140_000) + 120 * w(50_000, 140_000));
    expect(Math.abs(warmArea - predicted)).toBeLessThan(SNAP_TOLERANCE);
  });

  it("shares width exactly in proportion to gas, snapping aside", () => {
    // The area assertions carry a tolerance because row *heights* are snapped
    // to device pixels. Width is not snapped and is the channel actually under
    // test, so this one is exact to ten places.
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const total = 160;
    const hashes = Array.from({ length: total }, (_, i) => hashOf(i));
    const isGhost = (i: number) => i % 4 === 0;
    const gasUsed = hashes.map((_, i) => (isGhost(i) ? 140_000 : 50_000));
    applyBlock(
      world,
      {
        number: 1,
        timestamp: NOW,
        baseFeePerGas: 12e9,
        hashes,
        gasUsed,
      },
      hashes.map((hash, index) => ({
        hash,
        index,
        origin: isGhost(index) ? ("ghost" as const) : ("seen" as const),
        record: isGhost(index)
          ? undefined
          : { firstSeen: NOW - 5000, fees: eip1559(2, 30), gas: 50_000 },
        gasUsed: gasUsed[index],
      })),
      () => 0.5,
    );
    step(world, 3000, NOW);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW, () => 0.5, options);
    const warmFill = `rgba(${palette.ghostSettled.r}, ${palette.ghostSettled.g}, ${palette.ghostSettled.b}`;
    const left = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
    const right = view.width * BLOCK_RIGHT;
    const pitch = (view.height * BLOCK_EXTENT) / total;
    const rows = calls.filter(
      (c) =>
        c.op === "fillRect" &&
        c.x + c.w <= right + 1 &&
        c.x > left - TOP_SLOT_TAB - 1 &&
        c.h > pitch * 0.6,
    );
    expect(rows).toHaveLength(total);
    let warm = 0;
    let all = 0;
    for (const row of rows) {
      if (row.op !== "fillRect") continue;
      all += row.w;
      if (row.fill.startsWith(warmFill)) warm += row.w;
    }
    const w = gasWidthFraction;
    const predicted =
      (40 * w(140_000, 140_000)) /
      (40 * w(140_000, 140_000) + 120 * w(50_000, 140_000));
    // Slot 0 is a ghost here and carries the tab, which is position and not
    // gas, so it is discounted from the warm total.
    expect((warm - TOP_SLOT_TAB) / (all - TOP_SLOT_TAB)).toBeCloseTo(
      predicted,
      10,
    );
  });

  it("computes the gas ratio from gasUsed, not from the pending gas limit", () => {
    // Private flow was never announced, so it has no `PendingTx.gas`. Sizing a
    // block row by the pending figure would render every ghost at a default
    // width, encoding "we do not know" as "small" — which is precisely the
    // class of lie this codebase spends most of its effort avoiding.
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const hashes = Array.from({ length: 4 }, (_, i) => hashOf(i));
    const gasUsed = [300_000, 50_000, 50_000, 50_000];
    const block: BlockEvent = {
      number: 1,
      timestamp: NOW,
      baseFeePerGas: 12e9,
      hashes,
      gasUsed,
    };
    const arrivals: BlockArrival[] = hashes.map((hash, index) => ({
      hash,
      index,
      origin: index === 0 ? "ghost" : "seen",
      // The seen records carry a gas *limit* that disagrees with what was used.
      record:
        index === 0
          ? undefined
          : { firstSeen: NOW, fees: eip1559(2, 30), gas: 999_999 },
      gasUsed: gasUsed[index],
    }));
    applyBlock(world, block, arrivals, () => 0.5);

    // The marks carry the block's figure, not the announced one.
    expect(world.block.map((mark) => mark.gas)).toEqual(gasUsed);
    expect(world.blockMaxGas).toBe(300_000);

    const seen = createSeenSet();
    seen.seedFromSnapshot([]);
    const state = readout({
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
      now: NOW,
    });
    expect(state.ghostGasRatio).toBeCloseTo(300_000 / 450_000, 10);
    // Had it used the announced limits, the ghost would have had none and the
    // three public rows would have carried 999,999 apiece.
    expect(state.ghostGasRatio).not.toBeCloseTo(0, 2);
  });

  it("normalises row width over the block's own maximum", () => {
    // The widest row in a block is always the full column, whatever the
    // absolute gas figures are. A fixed scale would make a quiet block render
    // as a column of slivers.
    const small = measure({ ghostGas: 30_000, seenGas: 21_000, ghosts: 40, total: 160 });
    const large = measure({ ghostGas: 300_000, seenGas: 210_000, ghosts: 40, total: 160 });
    expect(small.warmArea).toBeCloseTo(large.warmArea, 6);
  });

  it("draws warm area in proportion to the ghosts there actually are", () => {
    // Monotone, and materially so: a block with more private flow must look
    // like one. Without this the two tests above would pass on a constant.
    const few = measure({ ghostGas: 60_000, seenGas: 60_000, ghosts: 16, total: 160 });
    const many = measure({ ghostGas: 60_000, seenGas: 60_000, ghosts: 80, total: 160 });
    expect(few.warmArea).toBeLessThan(many.warmArea);
    expect(many.warmArea - few.warmArea).toBeGreaterThan(0.3);
  });
});

describe("the strip and the block measure the same quantity", () => {
  /**
   * The compressed strip exists for one purpose: so a reader can hold two
   * blocks side by side and ask whether this one is unusual, or whether a
   * quarter of every block is private flow.
   *
   * That question only has an answer if both columns encode the same thing.
   * The strip used to draw every row at the full column width while the live
   * block sized each row by gas, so the two warm areas answered different
   * questions with nothing on screen to say so — measured on two blocks of
   * identical composition, 42.6% against 25.4%.
   */
  const NOW2 = 1_700_000_000_000;
  const opts = {
    showGhosts: true,
    ticks: [],
    markScale: 1,
    reducedMotion: false,
  };

  /** Lands a block whose ghosts consume three times the gas of everything else. */
  function land(world: ReturnType<typeof createWorld>, n: number, seed: number) {
    const hashes = Array.from({ length: n }, (_, i) => hashOf(seed * 1000 + i));
    const isGhost = (i: number) => i % 4 === 0;
    const gasUsed = hashes.map((_, i) => (isGhost(i) ? 150_000 : 50_000));
    const block: BlockEvent = {
      number: seed,
      timestamp: NOW2,
      baseFeePerGas: 12e9,
      hashes,
      gasUsed,
    };
    applyBlock(
      world,
      block,
      hashes.map((hash, index) => ({
        hash,
        index,
        origin: isGhost(index) ? ("ghost" as const) : ("seen" as const),
        record: isGhost(index)
          ? undefined
          : { firstSeen: NOW2 - 5000, fees: eip1559(2, 30), gas: 50_000 },
        gasUsed: gasUsed[index],
      })),
      () => 0.5,
    );
  }

  /** Row widths in a column, as fractions of that column, deduplicated. */
  function widthFractions(
    calls: ReturnType<typeof recordingContext>["calls"],
    right: number,
    colFraction: number,
    warm: boolean,
  ) {
    const warmFill = `rgba(${palette.ghostSettled.r}, ${palette.ghostSettled.g}, ${palette.ghostSettled.b}`;
    const colWidth = view.width * colFraction;
    const r = view.width * right;
    const l = r - colWidth;
    return [
      ...new Set(
        calls
          .filter(
            (c) =>
              c.op === "fillRect" &&
              c.x >= l - TOP_SLOT_TAB - 1 &&
              c.x + c.w <= r + 1 &&
              c.h > 1 &&
              c.h < 20 &&
              c.fill.startsWith(warmFill) === warm &&
              // Drop slot 0, which carries a protruding tab in the live column
              // and would otherwise look like a third width.
              c.w <= colWidth + 0.001,
          )
          .map((c) => +((c.op === "fillRect" ? c.w : 0) / colWidth).toFixed(4)),
      ),
    ].sort((a, b) => a - b);
  }

  function bothColumns() {
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    resetHashes();
    land(world, 150, 1); // becomes PREV
    step(world, 3000, NOW2);
    land(world, 150, 2); // the live block
    step(world, 3000, NOW2);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW2, () => 0.5, opts);
    return calls;
  }

  it("sizes a strip row by gas, exactly as the block does", () => {
    const calls = bothColumns();
    for (const warm of [true, false]) {
      const block = widthFractions(calls, BLOCK_RIGHT, BLOCK_WIDTH, warm);
      const strip = widthFractions(calls, STRIP_RIGHT, STRIP_WIDTH, warm);
      expect(strip).toEqual(block);
    }
  });

  it("does not draw every strip row at the full column width", () => {
    // The specific regression. Without this the assertion above would pass if
    // both columns went flat.
    const calls = bothColumns();
    const seen = widthFractions(calls, STRIP_RIGHT, STRIP_WIDTH, false);
    expect(seen).toHaveLength(1);
    // 0.75, not the linear 0.6: the root lifts a 50k row against 140k from
    // 0.47 to 0.67 of the column. The regression this guards is a strip drawn
    // flat, which is 1.0, and a flat strip still fails here.
    expect(seen[0]).toBeLessThan(0.75);
    const ghost = widthFractions(calls, STRIP_RIGHT, STRIP_WIDTH, true);
    expect(ghost[0]).toBeGreaterThan(seen[0] + 0.3);
  });

  it("keeps the narrowest strip row a mark rather than a hairline", () => {
    // The old justification for the flat strip was that a 50px column could not
    // afford a second variable. The floor is what makes that false.
    const strip = slotRect(view, 0, 150, true);
    const narrowest = widthForGas(strip.width, 21_000, 400_000);
    expect(narrowest).toBeGreaterThan(8);
  });
});

describe("only one thing on the page claims to know a population", () => {
  /**
   * The two-standards check.
   *
   * The band under the primary reading refuses to draw below
   * `MIN_RATIO_WINDOW_BLOCKS`, because min/max over a short sample understates
   * the spread badly — 32.8% of it at two blocks, measured. The strip beside
   * the block answers the same question by eye, from a sample of two, with no
   * threshold at all.
   *
   * There is no shared constant here because there is no second threshold to
   * share it with: the strip stopped claiming to answer that question. Growing
   * it to twelve columns was measured and rejected — 14.6px each, narrowest row
   * 2.6px, against an 8px floor, and consuming the whole crossing the flight
   * needs. So what is asserted instead is that the strip cannot become a
   * population claim by accident: it is one block deep, permanently.
   */
  const NOW3 = 1_700_000_000_000;

  it("keeps the strip one block deep no matter how many land", () => {
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    for (let n = 0; n < 30; n++) {
      const hashes = Array.from({ length: 20 }, (_, i) => hashOf(n * 100 + i));
      applyBlock(
        world,
        {
          number: 21_000_000 + n,
          timestamp: NOW3,
          baseFeePerGas: 12e9,
          hashes,
          gasUsed: hashes.map(() => 50_000),
        },
        hashes.map((hash, index) => ({
          hash,
          index,
          origin: "ghost" as const,
          gasUsed: 50_000,
        })),
        () => 0.5,
      );
      step(world, 3000, NOW3);
      // History never accumulates. If it ever did, the page would grow a
      // population claim with no threshold behind it.
      expect(world.previousBlock.length).toBeLessThanOrEqual(20);
    }
    expect(world.previousBlockNumber).toBe(21_000_028);
  });

  it("gates the one multi-block figure the readout reports", () => {
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const seen = createSeenSet();
    seen.seedFromSnapshot([]);
    const at = (n: number) =>
      readout({
        world,
        seen,
        ticks: [],
        axisSamples: 4096,
  axisBounds: { low: 1e8, high: 1e11 },
  view: { width: 1440, height: 900 },
        recentRatios: Array.from({ length: n }, (_, i) => 0.1 + i * 0.02),
        lastBlockAt: NOW3,
        lastEventAt: NOW3,
        subscribed: true,
        budgetReduced: false,
        now: NOW3,
      });
    // Everything else the readout carries describes one block, or the pool as
    // it stands. This is the only figure that speaks about several, and it is
    // the only one with a threshold — which is the whole point.
    expect(at(MIN_RATIO_WINDOW_BLOCKS - 1).ghostRatioWindow).toBeNull();
    expect(at(MIN_RATIO_WINDOW_BLOCKS).ghostRatioWindow).not.toBeNull();
    expect(at(MIN_RATIO_WINDOW_BLOCKS).previousBlockNumber).toBeNull();
  });
});

describe("the block occupies the space the chrome reserves for it", () => {
  it("fills its column from the top of the field to the panel band", () => {
    const first = slotRect(view, 0, 150, false);
    const last = slotRect(view, 149, 150, false);
    const drawn = last.y + last.height - first.y;
    const reserved = view.height * BLOCK_EXTENT;
    // Within the snapping slack of one device pixel per end.
    expect(Math.abs(drawn - reserved)).toBeLessThanOrEqual(2 / view.dpr);
  });
});
