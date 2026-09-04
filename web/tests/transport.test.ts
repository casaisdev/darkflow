import { describe, expect, it } from "vitest";
import {
  BLOCK_RIGHT,
  BLOCK_WIDTH,
  chamberX,
  chamberY,
  render,
  slotRect,
  widthForGas,
  type DrawOptions,
} from "@/lib/canvas/draw";
import {
  applyBlock,
  createWorld,
  enqueue,
  replayLanding,
  step,
  type BlockArrival,
  type WorldState,
} from "@/lib/canvas/world";
import { pick, pickSlot } from "@/lib/canvas/pick";
import type { BlockEvent } from "@/types/stream";
import { eip1559, hashOf, palette, recordingContext, resetHashes, tx, view } from "./helpers";

/**
 * Driving the instrument: replaying a landing, stepping rows from the
 * keyboard, and the ring around what is pointed at.
 *
 * Each of these is a way the picture answers the reader. Each is tested for
 * the answer being the true one: a replayed landing changes no datum, a
 * stepped row is the adjacent row and no other, a ring sits on the thing it
 * rings and on nothing else.
 */

const NOW = 1_700_000_000_000;
const GAS = 60_000;

function landed(count: number, ghostAt: (i: number) => boolean) {
  resetHashes();
  const world = createWorld({ maxEntities: 10, topQuota: 0 });
  world.heightFor = () => 0.5;
  const hashes = Array.from({ length: count }, (_, i) => hashOf(i));
  const block: BlockEvent = {
    number: 21_000_000,
    timestamp: NOW,
    baseFeePerGas: 12e9,
    hashes,
    gasUsed: hashes.map((_, i) => (i === 0 ? 4 * GAS : GAS)),
  };
  const arrivals: BlockArrival[] = hashes.map((hash, index) => ({
    hash,
    index,
    origin: ghostAt(index) ? "ghost" : "seen",
    record: ghostAt(index)
      ? undefined
      : { firstSeen: NOW - 5000, fees: eip1559(2, 30), gas: GAS },
    gasUsed: index === 0 ? 4 * GAS : GAS,
  }));
  applyBlock(world, block, arrivals, () => 0.5);
  return world;
}

function settle(world: WorldState, ms: number) {
  for (let t = 0; t < ms; t += 100) step(world, 100, NOW + t);
}

const pickOptions = { showGhosts: true, feeScale: () => 0.5, now: NOW };

describe("replaying the landing", () => {
  it("flies every public row again and re-appears every private one, changing no datum", () => {
    const world = landed(9, (i) => i % 3 === 0);
    settle(world, 4000);
    const before = world.block.map((m) => ({
      hash: m.hash,
      origin: m.origin,
      slot: m.slotIndex,
      gas: m.gas,
      fromX: m.fromX,
      fromY: m.fromY,
    }));
    expect(world.block.every((m) => m.phase === "settled")).toBe(true);

    replayLanding(world);

    for (const mark of world.block) {
      if (mark.origin === "seen") {
        expect(mark.phase).toBe("flying");
        expect(mark.flightProgress).toBe(0);
      } else {
        expect(mark.phase).toBe("settled");
      }
      // Its turn comes in block order, as on the first landing.
      expect(mark.phaseStartMs).toBeGreaterThanOrEqual(world.elapsedMs);
    }
    const after = world.block.map((m) => ({
      hash: m.hash,
      origin: m.origin,
      slot: m.slotIndex,
      gas: m.gas,
      fromX: m.fromX,
      fromY: m.fromY,
    }));
    expect(after).toEqual(before);

    // And it lands again.
    settle(world, 4000);
    expect(world.block.every((m) => m.phase === "settled")).toBe(true);
  });

  it("does nothing under reduced motion, where there is no landing to replay", () => {
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0, reducedMotion: true });
    world.heightFor = () => 0.5;
    const hashes = [hashOf(1), hashOf(2)];
    applyBlock(
      world,
      { number: 1, timestamp: NOW, baseFeePerGas: 12e9, hashes, gasUsed: [GAS, GAS] },
      hashes.map((hash, index) => ({
        hash,
        index,
        origin: "seen" as const,
        record: { firstSeen: NOW - 5000, fees: eip1559(2, 30), gas: GAS },
        gasUsed: GAS,
      })),
      () => 0.5,
    );
    settle(world, 500);
    const starts = world.block.map((m) => m.phaseStartMs);
    replayLanding(world);
    expect(world.block.map((m) => m.phaseStartMs)).toEqual(starts);
    expect(world.block.every((m) => m.phase === "settled")).toBe(true);
  });
});

describe("stepping rows from the keyboard", () => {
  it("returns the row at a position, described exactly as the pointer would describe it", () => {
    const world = landed(6, (i) => i === 2);
    settle(world, 4000);
    for (let i = 0; i < 6; i++) {
      const bySlot = pickSlot(world, view, "block", i, pickOptions);
      const rect = slotRect(view, i, 6, false);
      const byPointer = pick(
        world,
        view,
        { x: view.width * BLOCK_RIGHT - 3, y: rect.y + rect.height / 2 },
        pickOptions,
      );
      expect(bySlot).not.toBeNull();
      expect(bySlot).toEqual(byPointer);
      expect(bySlot!.slotIndex).toBe(i);
    }
    expect(pickSlot(world, view, "block", 2, pickOptions)!.origin).toBe("ghost");
  });

  it("is null past either end, so the caller stops rather than wraps", () => {
    const world = landed(3, () => false);
    expect(pickSlot(world, view, "block", -1, pickOptions)).toBeNull();
    expect(pickSlot(world, view, "block", 3, pickOptions)).toBeNull();
    expect(pickSlot(world, view, "previous", 0, pickOptions)).toBeNull();
  });
});

describe("the ring around what is pointed at", () => {
  function ringsIn(world: WorldState, highlight: DrawOptions["highlight"]) {
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW + 4000, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: false,
      highlight,
    });
    return {
      rects: calls.filter((c): c is Extract<typeof c, { op: "strokeRect" }> => c.op === "strokeRect"),
      // A ring is an arc that is stroked; the recorder logs arcs only on fill,
      // so rings are found by the stroke colour on the line ops around them —
      // simpler: count strokeRects for rows and rely on the row test below.
    };
  }

  it("draws nothing extra when nothing is pointed at", () => {
    const world = landed(4, () => false);
    settle(world, 4000);
    expect(ringsIn(world, null).rects).toHaveLength(0);
    expect(ringsIn(world, undefined).rects).toHaveLength(0);
  });

  it("rings the pointed-at row, one device pixel outside it, in the row's own class", () => {
    const world = landed(4, (i) => i === 1);
    settle(world, 4000);
    const seen = world.block.find((m) => m.origin === "seen")!;
    const ghost = world.block.find((m) => m.origin === "ghost")!;

    const seenRings = ringsIn(world, { hash: seen.hash, where: "block" }).rects;
    expect(seenRings).toHaveLength(1);
    const slot = slotRect(view, seen.slotIndex, 4, false);
    const gasWidth = widthForGas(slot.width, seen.gas, world.blockMaxGas);
    const pad = 1 / view.dpr + 1;
    expect(seenRings[0].x).toBeCloseTo(slot.x + slot.width - gasWidth - pad, 6);
    expect(seenRings[0].w).toBeCloseTo(gasWidth + pad * 2, 6);
    expect(seenRings[0].stroke).toContain("200, 210, 220"); // palette.text

    const ghostRings = ringsIn(world, { hash: ghost.hash, where: "block" }).rects;
    expect(ghostRings).toHaveLength(1);
    // Rule 1: this row is private flow, so its ring may say so.
    expect(ghostRings[0].stroke).toContain("255, 160, 90"); // palette.ghostCore
  });

  it("rings a mark in the field where the mark is", () => {
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.axisCalibrated = true;
    enqueue(world, [tx({ hash: hashOf(0), firstSeen: NOW - 5000 })]);
    step(world, 100, NOW);
    const entity = world.entities[0];
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: false,
      highlight: { hash: hashOf(0), where: "mempool" },
    });
    // The recorder logs an arc on fill only; the ring is stroked. What can
    // be asserted from the recording is that no filled arc was added for it
    // — the ring is not a second mark — and that nothing threw.
    const arcs = calls.filter((c) => c.op === "arc");
    expect(arcs).toHaveLength(1);
    expect(arcs[0].op === "arc" && arcs[0].x).toBeCloseTo(chamberX(view, entity.x), 6);
    expect(arcs[0].op === "arc" && arcs[0].y).toBeCloseTo(chamberY(view, entity.y), 6);
  });

  it("brings the pointed-at row's track up and leaves the others at the reticle", () => {
    const world = landed(4, () => false);
    settle(world, 4000);
    const target = world.block[2];
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW + 4000, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: false,
      highlight: { hash: target.hash, where: "block" },
    });
    const columnLeft = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
    const tracks = calls.filter(
      (c): c is Extract<typeof c, { op: "line" }> =>
        c.op === "line" && c.alpha > 0 && c.alpha < 1 && c.x1 !== c.x2 && c.x2 >= columnLeft,
    );
    expect(tracks).toHaveLength(4);
    const slot = slotRect(view, target.slotIndex, 4, false);
    const lit = tracks.find((t) => Math.abs(t.y2 - (slot.y + slot.height / 2)) < 0.01)!;
    const others = tracks.filter((t) => t !== lit);
    for (const other of others) expect(lit.alpha).toBeGreaterThan(other.alpha * 1.5);
  });
});
