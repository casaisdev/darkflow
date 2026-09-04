import { describe, expect, it } from "vitest";
import { pick } from "@/lib/canvas/pick";
import {
  BLOCK_RIGHT,
  BLOCK_WIDTH,
  chamberX,
  chamberY,
  render,
  slotRect,
} from "@/lib/canvas/draw";
import {
  applyBlock,
  createWorld,
  step,
  type BlockArrival,
} from "@/lib/canvas/world";
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
 * Pointing at a transaction.
 *
 * The one requirement is that the answer matches the picture. A reader points
 * at a mark and is told what that mark is; if the hit test and the renderer
 * disagree by a few pixels the panel describes a different transaction and
 * nothing on screen would reveal it. So these tests check the pick against the
 * *recorded draw calls* where they can, rather than against a second copy of
 * the geometry.
 */

const NOW = 1_700_000_000_000;
const options = {
  showGhosts: true,
  feeScale: () => 0.5,
  now: NOW,
};

function worldWithBlock(count: number, ghostAt: (i: number) => boolean) {
  resetHashes();
  const world = createWorld({ maxEntities: 20, topQuota: 0 });
  world.heightFor = () => 0.5;
  world.baseFeePerGas = 12e9;
  const hashes = Array.from({ length: count }, (_, i) => hashOf(i));
  const gasUsed = hashes.map((_, i) => (i === 3 ? 200_000 : 60_000));
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
    origin: ghostAt(index) ? "ghost" : "seen",
    record: ghostAt(index)
      ? undefined
      : { firstSeen: NOW - 5000, fees: eip1559(2, 30), gas: 60_000 },
    gasUsed: gasUsed[index],
  }));
  applyBlock(world, block, arrivals, () => 0.5);
  step(world, 3000, NOW);
  return world;
}

describe("pointing at a block row", () => {
  it("names the row the renderer drew at that height", () => {
    const world = worldWithBlock(20, (i) => i % 2 === 1);
    // Every slot, checked against `slotRect` — which is what the renderer
    // positions rows with, so agreement here is agreement with the picture.
    for (let slot = 0; slot < 20; slot++) {
      const rect = slotRect(view, slot, 20, false);
      const hit = pick(
        world,
        view,
        { x: view.width * BLOCK_RIGHT - 10, y: rect.y + rect.height / 2 },
        options,
      );
      expect(hit?.where).toBe("block");
      expect(hit?.slotIndex).toBe(slot);
    }
  });

  it("reports the fee of private flow as unknown, never as zero", () => {
    // It has no pending record. The fee is not small, it is not known: a fee is
    // announced in the mempool and this transaction never was. The placeholder
    // the world spawns it with is zero, and printing that would be the same
    // lie as a zero ghost ratio.
    const world = worldWithBlock(20, (i) => i === 4);
    const rect = slotRect(view, 4, 20, false);
    const hit = pick(
      world,
      view,
      { x: view.width * BLOCK_RIGHT - 10, y: rect.y + rect.height / 2 },
      options,
    );
    expect(hit?.origin).toBe("ghost");
    expect(hit?.tipGwei).toBeNull();
    expect(hit?.offeredGwei).toBeNull();
    expect(hit?.feeKind).toBeNull();
    // Nor a moment it was first seen. The world spawns it with the block's
    // own timestamp so it has something finite to age by; printing that would
    // read as a transaction that waited a few seconds in a pool it never
    // entered.
    expect(hit?.ageSeconds).toBeNull();
    // Its gas is known, because the block reports it for everything included.
    expect(hit?.gas).toBe(60_000);
    expect(hit?.gasIsUsed).toBe(true);
  });

  it("reports a public row's fee, so the nulls above are not vacuous", () => {
    const world = worldWithBlock(20, (i) => i === 4);
    const rect = slotRect(view, 5, 20, false);
    const hit = pick(
      world,
      view,
      { x: view.width * BLOCK_RIGHT - 10, y: rect.y + rect.height / 2 },
      options,
    );
    expect(hit?.origin).toBe("seen");
    expect(hit?.tipGwei).toBeCloseTo(2, 6);
    expect(hit?.offeredGwei).toBeCloseTo(30, 6);
    expect(hit?.feeKind).toBe("eip1559");
    // And it does have a first sighting, so the null above is not vacuous.
    expect(hit?.ageSeconds).toBeCloseTo(5, 6);
  });

  it("says nothing about classification while calibrating", () => {
    // Rule 1: during warm-up the verdict is not computed, so the inspector has
    // none to report. It must not fall back to a guess.
    const world = worldWithBlock(20, (i) => i === 4);
    const rect = slotRect(view, 4, 20, false);
    const hit = pick(
      world,
      view,
      { x: view.width * BLOCK_RIGHT - 10, y: rect.y + rect.height / 2 },
      { ...options, showGhosts: false },
    );
    expect(hit?.origin).toBeNull();
  });

  it("misses when the pointer is outside the column", () => {
    const world = worldWithBlock(20, () => false);
    const rect = slotRect(view, 3, 20, false);
    const left = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
    expect(
      pick(world, view, { x: left - 40, y: rect.y + 1 }, options),
    ).toBeNull();
    expect(
      pick(
        world,
        view,
        { x: view.width * BLOCK_RIGHT + 20, y: rect.y + 1 },
        options,
      ),
    ).toBeNull();
  });
});

describe("pointing at a mark in the chamber", () => {
  function withMarks(positions: { x: number; y: number }[]) {
    resetHashes();
    const world = createWorld({ maxEntities: 20, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    positions.forEach((at, i) => {
      world.entities.push({
        hash: hashOf(400 + i),
        fees: eip1559(2 + i, 30),
        firstSeen: NOW - 4000,
        phase: "pending",
        origin: "unknown",
        slot: "sample",
        slotIndex: -1,
        gas: 21000,
        phaseStartMs: 0,
        flightProgress: 0,
        enteredInFlight: false,
        x: at.x,
        y: at.y,
        fromX: at.x,
        fromY: at.y,
        homeX: at.x,
        homeY: at.y,
        driftSeedA: 0,
        driftSeedB: 0,
        cullAtMs: Infinity,
      });
    });
    return world;
  }

  it("lands on the mark the renderer drew there", () => {
    const world = withMarks([{ x: 0.3, y: 0.4 }]);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: false,
    });
    const drawn = calls.find((c) => c.op === "arc");
    expect(drawn?.op).toBe("arc");
    if (drawn?.op !== "arc") return;

    const hit = pick(world, view, { x: drawn.x, y: drawn.y }, options);
    expect(hit?.where).toBe("mempool");
    expect(hit?.hash).toBe(hashOf(400));
    // The anchor is the mark's own centre, not wherever the pointer was, so a
    // panel attached to it does not drift under the cursor.
    expect(hit?.screen.x).toBeCloseTo(drawn.x, 6);
    expect(hit?.screen.y).toBeCloseTo(drawn.y, 6);
  });

  it("takes the nearest mark, not the first one in the pool", () => {
    const near = { x: 0.5, y: 0.5 };
    const world = withMarks([
      { x: 0.5, y: 0.5 + 0.008 },
      near,
      { x: 0.5, y: 0.5 - 0.02 },
    ]);
    const hit = pick(
      world,
      view,
      { x: chamberX(view, near.x), y: chamberY(view, near.y) },
      options,
    );
    expect(hit?.hash).toBe(hashOf(401));
  });

  /**
   * A mark drifts, and pointing at one means holding still while it walks
   * away. The mark that was answering keeps answering within twice the pick
   * reach, even past a nearer neighbour; beyond that it is let go.
   */
  describe("holding on to the mark that was answering", () => {
    const held = { x: 0.5, y: 0.5 };
    const neighbour = { x: 0.5, y: 0.5 - 0.02 };
    const at = (px: { x: number; y: number }, dx: number, dy: number) => ({
      x: chamberX(view, px.x) + dx,
      y: chamberY(view, px.y) + dy,
    });
    const nearNeighbour = () => {
      const p = at(neighbour, 3, 0);
      // The pointer is 3px from the neighbour and 20px from the held mark.
      const y = chamberY(view, held.y);
      expect(Math.abs(y - p.y)).toBeGreaterThan(12);
      expect(Math.abs(y - p.y)).toBeLessThan(24);
      return p;
    };

    it("keeps it while it is within twice the reach, past a nearer mark", () => {
      const world = withMarks([held, neighbour]);
      const pointer = nearNeighbour();
      const withHold = pick(world, view, pointer, { ...options, held: hashOf(400) });
      expect(withHold?.hash).toBe(hashOf(400));
      // The anchor follows the held mark, not the pointer.
      expect(withHold?.screen.y).toBeCloseTo(chamberY(view, held.y), 6);
      // Without a hold the same pointer means the neighbour: the hold is
      // what changed the answer, not the geometry.
      expect(pick(world, view, pointer, options)?.hash).toBe(hashOf(401));
    });

    it("lets go once it has drifted past twice the reach", () => {
      const world = withMarks([held, neighbour]);
      const pointer = at(held, 0, 25);
      expect(pick(world, view, pointer, { ...options, held: hashOf(400) })).toBeNull();
      const farNeighbour = at(neighbour, 0, -25);
      expect(
        pick(world, view, farNeighbour, { ...options, held: hashOf(400) }),
      ).toBeNull();
    });

    it("does not hold a mark that is no longer pending", () => {
      const world = withMarks([held]);
      world.entities[0]!.phase = "flying";
      const pointer = at(held, 0, 0);
      expect(pick(world, view, pointer, { ...options, held: hashOf(400) })).toBeNull();
    });

    it("never holds a row: a row does not move", () => {
      const world = worldWithBlock(20, () => false);
      const rect = slotRect(view, 4, 20, false);
      const hit = pick(
        world,
        view,
        { x: view.width * (BLOCK_RIGHT - BLOCK_WIDTH / 2), y: rect.y + rect.height / 2 },
        { ...options, held: hashOf(7) },
      );
      expect(hit?.where).toBe("block");
      expect(hit?.hash).toBe(hashOf(4));
    });
  });

  it("misses when nothing is within reach", () => {
    const world = withMarks([{ x: 0.2, y: 0.2 }]);
    expect(
      pick(
        world,
        view,
        { x: chamberX(view, 0.7), y: chamberY(view, 0.7) },
        options,
      ),
    ).toBeNull();
  });

  it("calls a pending transaction's gas a limit, not gas used", () => {
    // A limit is an intention; used gas is a measurement. Different
    // quantities, and the panel has to say which one it is showing.
    const world = withMarks([{ x: 0.3, y: 0.3 }]);
    const hit = pick(
      world,
      view,
      { x: chamberX(view, 0.3), y: chamberY(view, 0.3) },
      options,
    );
    expect(hit?.gasIsUsed).toBe(false);
    expect(hit?.gas).toBe(21000);
    expect(hit?.slotIndex).toBeNull();
    expect(hit?.ageSeconds).toBeCloseTo(4, 6);
  });
});
