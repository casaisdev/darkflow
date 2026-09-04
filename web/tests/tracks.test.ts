import { describe, expect, it } from "vitest";
import {
  BLOCK_RIGHT,
  BLOCK_WIDTH,
  TRACK_BUDGET_ROWS,
  TRACK_LIFE_MS,
  trackBudgetScale,
  chamberX,
  entryDepth,
  chamberY,
  render,
  slotRect,
  widthForGas,
} from "@/lib/canvas/draw";
import {
  applyBlock,
  createWorld,
  enqueue,
  step,
  type BlockArrival,
  type WorldState,
} from "@/lib/canvas/world";
import type { BlockEvent } from "@/types/stream";
import { eip1559, hashOf, palette, recordingContext, resetHashes, tx, view } from "./helpers";

/**
 * The tracks: the record of which rows in the block came from the mempool.
 *
 * What is asserted is the claim, not the picture. A track exists for every
 * public transaction and for no private one; it runs from where the mark was
 * to the row it became; it dims with time since landing and is still above
 * nothing at the end of its life. A track on a ghost row, or a missing track
 * on a public one, is the product's claim inverted — and it would look like a
 * perfectly good cloud chamber.
 */

const NOW = 1_700_000_000_000;
const GAS = 60_000;

function landed(count: number, ghostAt: (i: number) => boolean) {
  resetHashes();
  const world = createWorld({ maxEntities: 10, topQuota: 0 });
  world.heightFor = () => 0.5;
  const hashes = Array.from({ length: count }, (_, i) => hashOf(i));
  // Row 0 is four times the others, so every other row's left edge sits
  // inside the column: a track ending at the column's edge instead of the
  // row's would be measurably wrong.
  const gasOf = (i: number) => (i === 0 ? 4 * GAS : GAS);
  const block: BlockEvent = {
    number: 21_000_000,
    timestamp: NOW,
    baseFeePerGas: 12e9,
    hashes,
    gasUsed: hashes.map((_, i) => gasOf(i)),
  };
  const arrivals: BlockArrival[] = hashes.map((hash, index) => ({
    hash,
    index,
    origin: ghostAt(index) ? "ghost" : "seen",
    record: ghostAt(index)
      ? undefined
      : { firstSeen: NOW - 5000, fees: eip1559(2, 30), gas: gasOf(index) },
    gasUsed: gasOf(index),
  }));
  applyBlock(world, block, arrivals, () => 0.5);
  return world;
}

/**
 * Tracks are the lines drawn at a partial alpha that reach the block column:
 * the strip's gas datum is also faded in, and it is a vertical rule; a track's
 * lead-in segment ends mid-crossing and is not the track.
 */
/**
 * The render budget can hold the tracks to the pointed-at row.
 *
 * The governor that cuts the entity cap cuts these too: a device that could
 * not keep frames up with fewer marks is not given a block's worth of lines
 * on top. What must survive the cut is the answer to a question — the
 * pointed-at row keeps its track, because that one is not atmosphere.
 */
function tracksUnder(
  world: WorldState,
  atMs: number,
  options: { tracks: "all" | "lit"; highlight?: { hash: `0x${string}`; where: "block" } },
) {
  const { ctx, calls } = recordingContext();
  render(ctx, world, palette, view, NOW + atMs, () => 0.5, {
    showGhosts: true,
    ticks: [],
    markScale: 1,
    reducedMotion: false,
    tracks: options.tracks,
    highlight: options.highlight ?? null,
  });
  const columnLeft = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
  return calls.filter(
    (c): c is Extract<typeof c, { op: "line" }> =>
      c.op === "line" &&
      c.alpha > 0 &&
      c.alpha < 1 &&
      c.x1 !== c.x2 &&
      c.x2 >= columnLeft,
  );
}

function tracksOf(world: WorldState, atMs: number) {
  const { ctx, calls } = recordingContext();
  render(ctx, world, palette, view, NOW + atMs, () => 0.5);
  const columnLeft = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
  return calls.filter(
    (c): c is Extract<typeof c, { op: "line" }> =>
      c.op === "line" &&
      c.alpha > 0 &&
      c.alpha < 1 &&
      c.x1 !== c.x2 &&
      c.x2 >= columnLeft,
  );
}

/** Every partial-alpha, non-vertical line, lead-ins included. */
function segmentsOf(world: WorldState, atMs: number) {
  const { ctx, calls } = recordingContext();
  render(ctx, world, palette, view, NOW + atMs, () => 0.5);
  return calls.filter(
    (c): c is Extract<typeof c, { op: "line" }> =>
      c.op === "line" && c.alpha > 0 && c.alpha < 1 && c.x1 !== c.x2,
  );
}

function settle(world: WorldState, ms: number) {
  // Past every stagger and every flight. Stepped in frames, as the loop does.
  for (let t = 0; t < ms; t += 100) step(world, 100, NOW + t);
}

describe("tracks", () => {
  it("draws one for every public transaction and none for private flow", () => {
    const world = landed(12, (i) => i % 3 === 0); // 4 ghosts, 8 seen
    settle(world, 4000);
    const tracks = tracksOf(world, 4000);
    expect(tracks).toHaveLength(8);
  });

  it("ends at the left edge of the row, never inside it", () => {
    const world = landed(4, () => false);
    settle(world, 4000);
    const tracks = tracksOf(world, 4000);
    expect(tracks).toHaveLength(4);
    for (const mark of world.block) {
      const slot = slotRect(view, mark.slotIndex, 4, false);
      const rowLeft =
        slot.x + slot.width - widthForGas(slot.width, mark.gas, world.blockMaxGas);
      const track = tracks.find((t) => Math.abs(t.y2 - (slot.y + slot.height / 2)) < 0.01);
      expect(track).toBeDefined();
      expect(track!.x2).toBeCloseTo(rowLeft, 6);
      expect(track!.x2).toBeLessThanOrEqual(view.width * BLOCK_RIGHT);
      expect(track!.x2).toBeGreaterThanOrEqual(view.width * (BLOCK_RIGHT - BLOCK_WIDTH));
      // For every row but the widest, that edge is inside the column.
      if (mark.slotIndex !== 0) expect(track!.x2).toBeGreaterThan(slot.x + 1);
    }
  });

  it("starts where the mark was seen: its field position, or its own entry depth", () => {
    // One mark really in the field before the block lands; the rest were
    // known but never drawn, and enter at the chamber's edge.
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.axisCalibrated = true;
    const inField = tx({ hash: hashOf(0), firstSeen: NOW - 5000, fees: eip1559(2, 30) });
    enqueue(world, [inField]);
    step(world, 100, NOW);
    const drawn = world.entities.find((e) => e.hash === hashOf(0));
    expect(drawn).toBeDefined();
    const fieldX = drawn!.x;
    const fieldY = drawn!.y;
    expect(fieldX).toBeLessThan(1);

    const hashes = [hashOf(0), hashOf(1), hashOf(2)];
    const block: BlockEvent = {
      number: 21_000_000,
      timestamp: NOW,
      baseFeePerGas: 12e9,
      hashes,
      gasUsed: hashes.map(() => GAS),
    };
    applyBlock(
      world,
      block,
      hashes.map((hash, index) => ({
        hash,
        index,
        origin: "seen" as const,
        record: { firstSeen: NOW - 5000, fees: eip1559(2, 30), gas: GAS },
        gasUsed: GAS,
      })),
      () => 0.5,
    );
    settle(world, 4000);
    const tracks = tracksOf(world, 4000);
    expect(tracks).toHaveLength(3);

    const own = world.block.find((m) => m.hash === hashOf(0))!;
    const ownSlot = slotRect(view, own.slotIndex, 3, false);
    const ownTrack = tracks.find((t) => Math.abs(t.y2 - (ownSlot.y + ownSlot.height / 2)) < 0.01)!;
    // From exactly where it was drawn. Nothing invented.
    expect(own.enteredInFlight).toBe(false);
    expect(ownTrack.x1).toBeCloseTo(chamberX(view, fieldX), 6);
    expect(ownTrack.y1).toBeCloseTo(chamberY(view, fieldY), 6);

    for (const mark of world.block.filter((m) => m.hash !== hashOf(0))) {
      expect(mark.enteredInFlight).toBe(true);
      const slot = slotRect(view, mark.slotIndex, 3, false);
      const track = tracks.find((t) => Math.abs(t.y2 - (slot.y + slot.height / 2)) < 0.01)!;
      // Not from the edge, where it was never visible: from its entry
      // depth, where its flight reached full brightness.
      const edgeX = chamberX(view, 1);
      const depth = entryDepth(mark);
      expect(depth).toBeGreaterThan(0.1);
      expect(depth).toBeLessThan(0.6);
      expect(track.x1).toBeCloseTo(edgeX + (track.x2 - edgeX) * depth, 4);
      // With a fainter lead-in over the eighth before that, and nothing
      // before the lead-in.
      const segments = segmentsOf(world, 4000).filter(
        (s) => Math.abs(s.y2 - track.y1) < 0.01 || Math.abs(s.y2 - track.y2) < 0.01,
      );
      const leadIn = segments.find((s) => s.x2 < track.x2 && Math.abs(s.x2 - track.x1) < 0.01);
      expect(leadIn).toBeDefined();
      expect(leadIn!.alpha).toBeCloseTo(track.alpha / 2, 6);
      expect(leadIn!.x1).toBeGreaterThan(edgeX);
    }
  });

  it("does not exist until the mark has landed", () => {
    const world = landed(6, () => false);
    // Nothing has moved yet: every mark is still waiting its turn or flying.
    expect(tracksOf(world, 0)).toHaveLength(0);
  });

  it("dims with time since landing and is still there at the end of its life", () => {
    const world = landed(3, () => false);
    settle(world, 4000);
    const fresh = tracksOf(world, 4000).map((t) => t.alpha);
    settle(world, TRACK_LIFE_MS / 2);
    const mid = tracksOf(world, 4000 + TRACK_LIFE_MS / 2).map((t) => t.alpha);
    settle(world, TRACK_LIFE_MS);
    const spent = tracksOf(world, 4000 + TRACK_LIFE_MS * 1.5).map((t) => t.alpha);
    expect(fresh).toHaveLength(3);
    expect(mid).toHaveLength(3);
    expect(spent).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(mid[i]).toBeLessThan(fresh[i]);
      expect(spent[i]).toBeLessThan(mid[i]);
      // Alpha, not luminance — but it is the same colour throughout, so a
      // strictly positive alpha is a strictly visible track.
      expect(spent[i]).toBeGreaterThan(0);
    }
  });

  it("gives each mark its own entry depth, inside the near half of the crossing", () => {
    // Per mark, from its seed: two seeds, two depths. One depth for all is
    // the beam from a point that this exists to prevent.
    const depths = [0, 1, 2, 3, 4, 5, 6].map((seed) => entryDepth({ driftSeedA: seed }));
    expect(new Set(depths.map((d) => d.toFixed(3))).size).toBe(depths.length);
    for (const d of depths) {
      expect(d).toBeGreaterThanOrEqual(0.15);
      expect(d).toBeLessThanOrEqual(0.55);
    }

    // And end to end, with seeds that actually vary: the tracks of marks that
    // entered crossing do not all start at one x.
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const hashes = Array.from({ length: 6 }, (_, i) => hashOf(i));
    const block: BlockEvent = {
      number: 21_000_000,
      timestamp: NOW,
      baseFeePerGas: 12e9,
      hashes,
      gasUsed: hashes.map(() => GAS),
    };
    let a = 7;
    const rand = () => ((a = (a * 48271) % 2147483647) / 2147483647);
    applyBlock(
      world,
      block,
      hashes.map((hash, index) => ({
        hash,
        index,
        origin: "seen" as const,
        record: { firstSeen: NOW - 5000, fees: eip1559(2, 30), gas: GAS },
        gasUsed: GAS,
      })),
      rand,
    );
    settle(world, 4000);
    const starts = new Set(tracksOf(world, 4000).map((t) => t.x1.toFixed(1)));
    expect(starts.size).toBeGreaterThan(1);
  });

  it("is gone with the block it belongs to", () => {
    const world = landed(4, () => false);
    settle(world, 4000);
    expect(tracksOf(world, 4000)).toHaveLength(4);
    // The next block lands: the old rows are history in the strip, and the
    // strip carries no tracks — those were a record of this block's crossing.
    const next: BlockEvent = {
      number: 21_000_001,
      timestamp: NOW + 12_000,
      baseFeePerGas: 12e9,
      hashes: [hashOf(90)],
      gasUsed: [GAS],
    };
    applyBlock(world, next, [{ hash: hashOf(90), index: 0, origin: "ghost", gasUsed: GAS }], () => 0.5);
    settle(world, 4000);
    expect(tracksOf(world, 8000)).toHaveLength(0);
    expect(world.previousBlock).toHaveLength(4);
  });
});

describe("the tracks under a reduced render budget", () => {
  it("holds every track but the pointed-at one", () => {
    const world = landed(8, (i) => i === 3);
    // Flights settle by simulation time, not by the render clock.
    step(world, 3000, NOW + 3000);
    const lit = world.block[5].hash;
    const kept = tracksUnder(world, 3000, {
      tracks: "lit",
      highlight: { hash: lit, where: "block" },
    });
    // One row's track survives the cut — the one that is an answer to a
    // question. Everything else is atmosphere and the budget may take it.
    expect(kept.length).toBeGreaterThan(0);
    const all = tracksUnder(world, 3000, { tracks: "all" });
    expect(all.length).toBeGreaterThan(kept.length);
  });

  it("draws nothing at all when cut with nothing pointed at", () => {
    const world = landed(8, () => false);
    step(world, 3000, NOW + 3000);
    expect(tracksUnder(world, 3000, { tracks: "lit" })).toHaveLength(0);
  });

  it("defaults to all of them", () => {
    // The cut is the governor's decision, never the default: a healthy
    // device shows the record.
    const world = landed(8, () => false);
    step(world, 3000, NOW + 3000);
    const explicit = tracksUnder(world, 3000, { tracks: "all" });
    const bare = tracksOf(world, 3000);
    expect(bare.length).toBe(explicit.length);
    expect(bare.length).toBeGreaterThan(0);
  });
});

describe("the track ink budget", () => {
  /**
   * Measured on a real block of 369 rows, 89 public: tracks were 48.8% of the
   * chamber's ink — as much as the whole field. Above the budget each track
   * dims by the root of the excess, never below half, and the pointed-at one
   * is exempt because it is an answer rather than atmosphere.
   */
  it("leaves small blocks alone and dims large ones by the root", () => {
    expect(trackBudgetScale(TRACK_BUDGET_ROWS)).toBe(1);
    expect(trackBudgetScale(1)).toBe(1);
    expect(trackBudgetScale(TRACK_BUDGET_ROWS * 4)).toBeCloseTo(0.5, 6);
    expect(trackBudgetScale(TRACK_BUDGET_ROWS * 2.25)).toBeCloseTo(1 / 1.5, 6);
  });

  it("never dims below half, whatever the block", () => {
    expect(trackBudgetScale(10_000)).toBe(0.5);
  });

  it("draws a big block's tracks dimmer than a small block's, per track", () => {
    const small = landed(8, () => false);
    step(small, 3000, NOW + 3000);
    const big = landed(TRACK_BUDGET_ROWS * 4, () => false);
    step(big, 3000, NOW + 3000);
    const alphaOf = (world: WorldState) => {
      const tracks = tracksOf(world, 3000);
      expect(tracks.length).toBeGreaterThan(0);
      return Math.max(...tracks.map((t) => t.alpha));
    };
    const ratio = alphaOf(big) / alphaOf(small);
    expect(ratio).toBeCloseTo(0.5, 2);
  });

  it("exempts the pointed-at track from the budget", () => {
    /**
     * The same row, lit and unlit, in one big block. Lit, a track is drawn at
     * 3x emphasis; budgeted, at the block's scale. With the exemption the lit
     * one is 3x the *unbudgeted* strength, so the ratio to its own unlit self
     * is 3 / scale; if the budget wrongly applied to it too, the ratio would
     * collapse to 3. Compared against itself rather than its neighbours,
     * because the stagger gives every row a different age and therefore a
     * different decay.
     */
    const rows = TRACK_BUDGET_ROWS * 4;
    const world = landed(rows, () => false);
    step(world, 3000, NOW + 3000);
    const lit = world.block[3].hash;
    const slot = slotRect(view, 3, rows, false);
    const yMid = slot.y + slot.height / 2;
    const ownTrack = (tracks: ReturnType<typeof tracksUnder>) =>
      tracks.reduce((best, t) =>
        Math.abs(t.y2 - yMid) < Math.abs(best.y2 - yMid) ? t : best,
      );
    const unlit = ownTrack(tracksUnder(world, 3000, { tracks: "all" })).alpha;
    const litAlpha = ownTrack(
      tracksUnder(world, 3000, { tracks: "all", highlight: { hash: lit, where: "block" } }),
    ).alpha;
    expect(litAlpha / unlit).toBeCloseTo(3 / trackBudgetScale(rows), 2);
  });
});
