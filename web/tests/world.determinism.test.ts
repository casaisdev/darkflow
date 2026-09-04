import { describe, expect, it } from "vitest";
import {
  applyBlock,
  createWorld,
  enqueue,
  step,
  type BlockArrival,
  type WorldState,
} from "@/lib/canvas/world";
import type { BlockEvent } from "@/types/stream";
import { effectivePriorityFee, offeredFee } from "@/lib/fees";
import { FLOOR_BAND } from "@/lib/canvas/layout";
import { eip1559, hashOf, legacy, resetHashes, tx } from "./helpers";

/**
 * The most important test in the repo.
 *
 * Everything this project claims rests on the simulation being a pure function
 * of `(state, deltaMs, now)`. If it is not, then a measurement taken in a
 * hidden automation tab is not a measurement of what a user sees, and every
 * calibrated constant in `draw.ts` and `world.ts` was tuned against noise.
 *
 * "Bit-identical" is meant literally: positions are compared with `toBe`, not
 * with a tolerance. A float that differs in the last place is a dependency on
 * something outside the arguments, and a tolerance would hide exactly that.
 */

function drive(seed: number): WorldState {
  resetHashes();
  const world = createWorld({ maxEntities: 60, topQuota: 5 });
  // A fee-dependent height, so the drift, the migration and the layout all
  // participate rather than collapsing to a constant.
  world.heightFor = (tip) => 1 - Math.min(1, tip / 5e9);
  world.baseFeePerGas = 12e9;

  let now = 1_700_000_000_000;
  for (let frame = 0; frame < 40; frame++) {
    const batch = Array.from({ length: 7 }, (_, i) => {
      const n = seed * 1000 + frame * 10 + i;
      return tx({
        hash: hashOf(n),
        firstSeen: now,
        fees:
          n % 3 === 0
            ? legacy(12 + (n % 17))
            : eip1559(0.5 + (n % 11), 14 + (n % 23)),
        gas: 21000 + (n % 7) * 30000,
      });
    });
    enqueue(world, batch);
    // Uneven deltas on purpose: a step that is secretly frame-counting rather
    // than integrating would still pass a constant-delta replay.
    const delta = frame % 3 === 0 ? 33 : frame % 3 === 1 ? 8 : 100;
    step(world, delta, now);
    now += delta;

    if (frame === 20) {
      const hashes = world.entities.slice(0, 12).map((entity) => entity.hash);
      const block: BlockEvent = {
        number: 21_000_000,
        timestamp: now,
        baseFeePerGas: 13e9,
        hashes,
        gasUsed: hashes.map((_, i) => 21000 + i * 9000),
      };
      const arrivals: BlockArrival[] = hashes.map((hash, index) => ({
        hash,
        index,
        origin: index % 4 === 0 ? "ghost" : "seen",
        record:
          index % 4 === 0
            ? undefined
            : { firstSeen: now - 4000, fees: eip1559(2, 30), gas: 21000 },
        gasUsed: block.gasUsed[index],
      }));
      applyBlock(world, block, arrivals, () => 0.5);
    }
  }
  return world;
}

/** Everything that can move, flattened so a mismatch names the field. */
function fingerprint(world: WorldState): string {
  const rows = [...world.entities, ...world.block, ...world.previousBlock].map(
    (entity) =>
      [
        entity.hash,
        entity.phase,
        entity.origin,
        entity.slot,
        entity.slotIndex,
        entity.x,
        entity.y,
        entity.homeX,
        entity.homeY,
        entity.fromX,
        entity.fromY,
        entity.flightProgress,
        entity.phaseStartMs,
        entity.driftSeedA,
        entity.driftSeedB,
        entity.cullAtMs,
        entity.gas,
      ].join("|"),
  );
  return [
    `elapsed=${world.elapsedMs}`,
    `culled=${world.culledByAge}`,
    `notSampled=${world.notSampled}`,
    `evictedFromTop=${world.evictedFromTop}`,
    `blockMaxGas=${world.blockMaxGas}`,
    ...rows,
  ].join("\n");
}

describe("world determinism", () => {
  it("produces a bit-identical state from the same seed and step sequence", () => {
    const a = drive(1);
    const b = drive(1);
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it("compares every mutable field, so the fingerprint can actually fail", () => {
    const a = drive(1);
    const b = drive(2);
    // A different input stream must produce a different fingerprint. Without
    // this, a fingerprint that silently collapsed to a constant would make the
    // determinism test above vacuous.
    expect(fingerprint(b)).not.toBe(fingerprint(a));
  });

  it("integrates time rather than counting frames", () => {
    // One 800ms step and eight 100ms steps must land in the same place. This
    // is what makes the simulation independent of the frame rate, and what
    // lets a measurement taken at 4fps in a hidden tab describe 60fps.
    const coarse = createWorld({ maxEntities: 10, topQuota: 0 });
    const fine = createWorld({ maxEntities: 10, topQuota: 0 });
    for (const world of [coarse, fine]) {
      world.baseFeePerGas = 12e9;
      world.heightFor = () => 0.25;
      enqueue(world, [tx({ hash: hashOf(99), fees: eip1559(3, 40) })]);
      // Drain first, so both start from the same spawned entity. Intake is
      // metered per second, so a zero-length step admits nobody — the drain
      // needs enough time to earn one mark's worth of credit.
      step(world, 20, 1_700_000_000_000);
      expect(world.entities).toHaveLength(1);
      world.entities[0].homeY = 0.9;
    }
    step(coarse, 800, 1_700_000_000_820);
    for (let i = 0; i < 8; i++) {
      step(fine, 100, 1_700_000_000_020 + (i + 1) * 100);
    }
    // Exponential migration, so the two agree to within the discretisation of
    // the exponential, not exactly. The tolerance is on a 0..1 coordinate.
    expect(coarse.entities[0].y).toBeCloseTo(fine.entities[0].y, 3);
    expect(coarse.elapsedMs).toBe(fine.elapsedMs);
  });

  it("reads no clock of its own", async () => {
    // `step` takes `now` as a parameter. If it reached for `Date.now()` or
    // `performance.now()` anywhere, two runs separated in wall-clock time
    // would diverge — and the whole verification strategy would be invalid.
    const first = drive(3);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = drive(3);
    expect(fingerprint(second)).toBe(fingerprint(first));
  });
});

describe("the sample refills at a rate, not in a frame", () => {
  /**
   * A block removes every field mark it included, and the next frame used to
   * refill every freed slot at once. Measured on the running app: a block took
   * 28 marks out of the field, the pool fell from 300 to 258, and one 16ms
   * frame put 42 back — all at age zero, which is full brightness, fifteen of
   * them into the top quota where the block had just emptied. Every twelve
   * seconds the top of the chamber flashed.
   *
   * None of that was data. The pool is a rendering budget and how fast it
   * refills is a rendering decision.
   */
  function fill(world: ReturnType<typeof createWorld>, count: number) {
    resetHashes();
    enqueue(
      world,
      Array.from({ length: count }, (_, i) =>
        tx({ hash: hashOf(5000 + i), fees: eip1559(1 + (i % 9), 40) }),
      ),
    );
  }

  it("admits no more than the metered rate in one frame", () => {
    const world = createWorld({ maxEntities: 300, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    fill(world, 400);
    // One 16ms frame at 60 a second is under one mark; the credit carries.
    step(world, 16, 1_700_000_000_000);
    expect(world.entities.length).toBeLessThanOrEqual(1);
    // A hundred milliseconds is six.
    const before = world.entities.length;
    fill(world, 400);
    step(world, 100, 1_700_000_000_116);
    expect(world.entities.length - before).toBeLessThanOrEqual(6);
  });

  it("carries the fraction so sixty-hertz frames still fill the chamber", () => {
    // Flooring the allowance every frame without carrying the remainder would
    // admit nobody at all at 60fps, and the chamber would stay empty.
    const world = createWorld({ maxEntities: 300, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    let now = 1_700_000_000_000;
    for (let frame = 0; frame < 60; frame++) {
      fill(world, 20);
      step(world, 16, (now += 16));
    }
    // One second of frames at the metered rate.
    expect(world.entities.length).toBeGreaterThan(50);
    expect(world.entities.length).toBeLessThanOrEqual(62);
  });

  it("still fills an empty chamber in a few seconds", () => {
    const world = createWorld({ maxEntities: 300, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    let now = 1_700_000_000_000;
    for (let frame = 0; frame < 320; frame++) {
      fill(world, 20);
      step(world, 16, (now += 16));
    }
    expect(world.entities.length).toBe(300);
    expect(now - 1_700_000_000_000).toBeLessThan(6000);
  });
});

describe("the intake meter cannot bank an idle period", () => {
  it("spends only this step's allowance, however long it waited", () => {
    /**
     * The first version of the meter had no ceiling on the carried credit, so
     * a full pool accrued sixty marks a second for the twelve seconds between
     * blocks and then spent seven hundred at once. Measured on the running
     * app: 41 marks in one 16ms frame, exactly the behaviour the meter was
     * added to remove.
     */
    const world = createWorld({ maxEntities: 60, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    let now = 1_700_000_000_000;

    // Fill it, then idle with nothing to admit for a long while.
    resetHashes();
    for (let frame = 0; frame < 200; frame++) {
      enqueue(world, [tx({ hash: hashOf(9000 + frame), fees: eip1559(3, 40) })]);
      step(world, 16, (now += 16));
    }
    expect(world.entities.length).toBe(60);
    for (let frame = 0; frame < 600; frame++) {
      step(world, 16, (now += 16));
    }

    // Now free a lot of slots at once, as a block does, and offer a queue.
    world.entities.length = 20;
    enqueue(
      world,
      Array.from({ length: 200 }, (_, i) =>
        tx({ hash: hashOf(20_000 + i), fees: eip1559(3, 40) }),
      ),
    );
    const before = world.entities.length;
    step(world, 16, (now += 16));
    // Two steps' worth at most, not six hundred frames' worth.
    expect(world.entities.length - before).toBeLessThanOrEqual(2);
  });
});

describe("the top quota is metered too", () => {
  /**
   * The meter's first two versions left this half out, and it is the half that
   * matters: the top quota holds the highest fees, a block includes the highest
   * fees, so a block empties it systematically. Measured on the running app
   * after the meter was capped, fifteen marks — the entire quota — appeared in
   * one 16ms frame, all at age zero, all at the top of the chamber.
   */
  function fillPool(world: WorldState, frames: number, from: number) {
    let now = 1_700_000_000_000;
    for (let frame = 0; frame < frames; frame++) {
      enqueue(
        world,
        Array.from({ length: 8 }, (_, i) =>
          tx({
            hash: hashOf(from + frame * 8 + i),
            fees: eip1559(1 + ((frame * 8 + i) % 40), 90),
          }),
        ),
      );
      step(world, 16, (now += 16));
    }
    return now;
  }

  function topCount(world: WorldState) {
    return world.entities.filter((entity) => entity.slot === "top").length;
  }

  function emptied() {
    resetHashes();
    // The product's own proportions: the quota is a twentieth of the pool, and
    // the refill rate is that same twentieth of the intake. A test world with a
    // different ratio would measure a different refill and prove nothing about
    // what ships.
    const world = createWorld({ maxEntities: 300, topQuota: 15 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    const now = fillPool(world, 700, 30_000);
    expect(topCount(world)).toBe(15);
    // What a block does to this half: takes the highest fees out of the field.
    world.entities = world.entities.filter((entity) => entity.slot !== "top");
    return { world, now };
  }

  it("refills the emptied quota at a rate, not in one frame", () => {
    const { world, now } = emptied();
    enqueue(
      world,
      Array.from({ length: 120 }, (_, i) =>
        tx({ hash: hashOf(80_000 + i), fees: eip1559(60 + i, 400) }),
      ),
    );
    const before = world.entities.length;
    step(world, 16, now + 16);
    expect(world.entities.length - before).toBeLessThanOrEqual(2);
    expect(topCount(world)).toBeLessThanOrEqual(2);
  });

  it("lets a fee the top meter cannot afford compete in the sample", () => {
    /**
     * The rate limit is a rendering decision, so it must not also be a verdict
     * on the transaction. When the top meter is empty the arrival falls through
     * to the uniform draw like any other rather than being held back — holding
     * it would starve the sample every frame, because the top meter is empty
     * most frames by design.
     */
    const { world, now } = emptied();
    // Free sample room, so the only reason to miss would be a decision.
    world.entities.length = 10;
    const best = tx({ hash: hashOf(95_000), fees: eip1559(9000, 9000) });
    enqueue(world, [best]);
    for (let frame = 0; frame < 6; frame++) step(world, 16, now + 16 * frame);
    expect(world.entities.some((e) => e.hash === best.hash)).toBe(true);
  });

  it("keeps the allowance a quiet frame did not spend", () => {
    /**
     * Most frames have nothing worth promoting: the quota is full and no
     * arrival outbids its weakest member. Burning the allowance on those frames
     * would leave the meter at zero exactly when a record fee finally turns up,
     * and it would wait a fifth of a second to be shown for no reason anyone
     * chose. Spending is what costs; looking is free.
     */
    resetHashes();
    const world = createWorld({ maxEntities: 300, topQuota: 15 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    let now = fillPool(world, 700, 60_000);
    expect(topCount(world)).toBe(15);
    const weakest = Math.min(
      ...world.entities
        .filter((e) => e.slot === "top")
        .map((e) => effectivePriorityFee(e.fees, world.baseFeePerGas)),
    );
    // Long enough to earn several marks of allowance, with nothing to spend it
    // on: every arrival here is cheaper than the quota already holds.
    for (let frame = 0; frame < 200; frame++) {
      enqueue(world, [
        tx({ hash: hashOf(70_000 + frame), fees: eip1559(0.1, 1) }),
      ]);
      step(world, 16, (now += 16));
    }
    const evictedBefore = world.evictedFromTop;
    enqueue(world, [tx({ hash: hashOf(79_999), fees: eip1559(9000, 9000) })]);
    step(world, 16, (now += 16));
    expect(world.evictedFromTop).toBe(evictedBefore + 1);
    expect(
      world.entities.some(
        (e) => e.slot === "top" && e.hash === hashOf(79_999),
      ),
    ).toBe(true);
    expect(weakest).toBeGreaterThan(0);
  });

  it("refills the emptied quota over seconds, not over a quarter of one", () => {
    /**
     * The quota is a twentieth of the pool, so it gets a twentieth of the
     * intake: fifteen slots take about five seconds. Slower than the burst it
     * replaces by design, and still comfortably inside the twelve seconds
     * between blocks, so the quota is whole again before the next one lands.
     */
    const { world, now: begin } = emptied();
    let now = begin;
    let full = -1;
    for (let frame = 0; frame < 900; frame++) {
      enqueue(
        world,
        Array.from({ length: 4 }, (_, i) =>
          tx({ hash: hashOf(100_000 + frame * 4 + i), fees: eip1559(60 + i, 400) }),
        ),
      );
      step(world, 16, (now += 16));
      if (full < 0 && topCount(world) === 15) full = frame + 1;
    }
    // Slower than the 208ms burst it replaces...
    expect(full * 16).toBeGreaterThan(2000);
    // ...and whole again before the next block lands.
    expect(full * 16).toBeLessThan(12_000);
  });
});

describe("the field breathes only where nothing is written", () => {
  /**
   * `x` is packing space and carries nothing, so a mark may move in it. `y` is
   * the fee. Drift used to move both, and on the axis that means something it
   * was error, not atmosphere: measured on the running app over eight seconds
   * against a 2.13-decade axis, a median wander of 0.0085 of the chamber height
   * and a maximum of 0.0145 — 4.2% and 7.4% error on the tip.
   */
  function suspended(seconds: number) {
    resetHashes();
    const world = createWorld({ maxEntities: 40, topQuota: 0 });
    world.baseFeePerGas = 12e9;
    // A fee-dependent height, so a y that moved for any reason would show.
    world.heightFor = (tip) => 1 - Math.min(1, tip / 8e9);
    let now = 1_700_000_000_000;
    for (let i = 0; i < 40; i++) {
      enqueue(world, [
        tx({ hash: hashOf(600 + i), firstSeen: now, fees: eip1559(1 + i / 8, 60) }),
      ]);
      step(world, 40, (now += 40));
    }
    expect(world.entities.length).toBeGreaterThan(20);
    const start = world.entities.map((e) => ({ hash: e.hash, x: e.x, y: e.y }));
    for (let f = 0; f < (seconds * 1000) / 16; f++) step(world, 16, (now += 16));
    return { world, start };
  }

  it("never moves a mark off the height its fee bought", () => {
    const { world, start } = suspended(8);
    for (const entity of world.entities) {
      const was = start.find((s) => s.hash === entity.hash);
      if (!was) continue;
      expect(entity.y).toBe(was.y);
      expect(entity.y).toBe(entity.homeY);
    }
  });

  it("still moves them sideways, so the field is not frozen", () => {
    // Without this the test above passes on a world that stopped moving at all.
    const { world, start } = suspended(8);
    const moved = world.entities.filter((entity) => {
      const was = start.find((s) => s.hash === entity.hash);
      return was ? Math.abs(entity.x - was.x) > 0.002 : false;
    });
    expect(moved.length).toBeGreaterThan(10);
  });
});

describe("one quantity, called by one name", () => {
  /**
   * `lib/fees.ts` defines two numbers and the codebase used to call both of
   * them "the fee". The chamber positions every mark by `effectivePriorityFee`;
   * the reservation ranked by `offeredFee`, cached on the entity at spawn. Two
   * different orderings, so the half of the pool that was reserved was not the
   * half the picture puts at the top.
   *
   * Measured on a live pool of 300 before the fix: the fifteen reserved marks
   * were spread from the chamber's first decile to its eighth, only eight of
   * them were among the fifteen highest priority fees, and the single highest
   * priority fee in the pool — at the very top of the chamber, y 0.04 — was not
   * reserved at all.
   *
   * These fixtures are built so the two orderings disagree completely: every
   * EIP-1559 transaction offers more and tips less than every legacy one.
   */
  const BASE = 12e9;

  function contested() {
    resetHashes();
    const world = createWorld({ maxEntities: 40, topQuota: 5 });
    world.baseFeePerGas = BASE;
    world.heightFor = (tip) => 1 - Math.min(1, tip / 60e9);
    const batch = [
      // Offers a fortune, tips almost nothing. Wins on `offeredFee`.
      ...Array.from({ length: 10 }, (_, i) =>
        tx({ hash: hashOf(200 + i), fees: eip1559(0.1 + i / 100, 400) }),
      ),
      // Offers less, tips far more. Wins on `effectivePriorityFee`.
      ...Array.from({ length: 10 }, (_, i) =>
        tx({ hash: hashOf(300 + i), fees: legacy(30 + i) }),
      ),
    ];
    let now = 1_700_000_000_000;
    for (let frame = 0; frame < 400; frame++) {
      enqueue(world, batch);
      step(world, 16, (now += 16));
    }
    return world;
  }

  const tipOf = (entity: { fees: Parameters<typeof effectivePriorityFee>[0] }) =>
    effectivePriorityFee(entity.fees, BASE);

  it("reserves the highest priority fees, which is what the axis plots", () => {
    const world = contested();
    const reserved = world.entities.filter((e) => e.slot === "top");
    expect(reserved.length).toBe(5);
    // Every reserved mark out-tips every unreserved one.
    const worstReserved = Math.min(...reserved.map(tipOf));
    const bestUnreserved = Math.max(
      ...world.entities.filter((e) => e.slot !== "top").map(tipOf),
    );
    expect(worstReserved).toBeGreaterThanOrEqual(bestUnreserved);
  });

  it("does not reserve by what a transaction merely offers", () => {
    // Without this the test above passes on a world where the two orderings
    // happen to agree. Here they cannot: the biggest offers tip the least.
    const world = contested();
    const reserved = world.entities.filter((e) => e.slot === "top");
    const offers = reserved.map((e) => offeredFee(e.fees));
    const allOffers = world.entities.map((e) => offeredFee(e.fees));
    expect(Math.max(...offers)).toBeLessThan(Math.max(...allOffers));
  });

  it("puts the reserved marks at the top of the chamber", () => {
    // The claim the reservation exists to make, stated in the coordinate the
    // reader actually sees.
    const world = contested();
    const reserved = world.entities.filter((e) => e.slot === "top");
    const lowestReserved = Math.max(...reserved.map((e) => e.homeY));
    const highestUnreserved = Math.min(
      ...world.entities.filter((e) => e.slot !== "top").map((e) => e.homeY),
    );
    expect(lowestReserved).toBeLessThanOrEqual(highestUnreserved);
  });
});

describe("eviction from the reservation ranks by the same quantity", () => {
  /**
   * The other half of the reservation, and the half a full-pool fixture never
   * reaches: once the quota is full, which member does a better arrival push
   * out? Ranking that by `offeredFee` evicts a mark the picture had placed
   * higher than the one it keeps.
   *
   * The three sitting marks are built so the two orderings pick different
   * victims: the lowest priority fee is the one offering the most.
   */
  const BASE = 12e9;

  /**
   * Offers a transaction every frame until it is admitted, then stops.
   *
   * Intake is metered, and an arrival is offered exactly once — the first
   * attempt at this test enqueued three transactions on a frame when the meter
   * had no credit yet and all three were dropped, which is correct behaviour
   * and a broken fixture. Re-offering only what is missing also keeps a hash
   * from being admitted twice.
   */
  function admit(
    world: WorldState,
    wanted: readonly { hash: `0x${string}` }[],
    from: number,
    frames = 240,
  ) {
    let now = from;
    for (let frame = 0; frame < frames; frame++) {
      const have = new Set(world.entities.map((e) => e.hash));
      const missing = wanted.filter((t) => !have.has(t.hash));
      if (missing.length > 0) enqueue(world, missing as never);
      step(world, 16, (now += 16));
    }
    return now;
  }

  it("pushes out the lowest priority fee, not the smallest offer", () => {
    resetHashes();
    // No sample half at all, so the reservation is the only way in and the
    // test cannot pass by a mark slipping into a sample slot instead.
    const world = createWorld({ maxEntities: 3, topQuota: 3 });
    world.baseFeePerGas = BASE;
    world.heightFor = (tip) => 1 - Math.min(1, tip / 60e9);

    // tip 10 / offers 400 — the weakest by priority, the richest by offer.
    const weakestTip = tx({ hash: hashOf(500), fees: eip1559(10, 400) });
    const middle = tx({ hash: hashOf(501), fees: eip1559(20, 30) });
    const strongest = tx({ hash: hashOf(502), fees: eip1559(30, 35) });

    const now = admit(world, [weakestTip, middle, strongest], 1_700_000_000_000);
    expect(world.entities.filter((e) => e.slot === "top")).toHaveLength(3);

    // A contender that out-tips all three while offering less than the first.
    const contender = tx({ hash: hashOf(503), fees: eip1559(50, 60) });
    admit(world, [contender], now);

    const reserved = world.entities
      .filter((e) => e.slot === "top")
      .map((e) => e.hash);
    expect(reserved).toContain(contender.hash);
    expect(reserved).not.toContain(weakestTip.hash);
    // And the two it should not have touched are still there.
    expect(reserved).toContain(middle.hash);
    expect(reserved).toContain(strongest.hash);
    expect(world.evictedFromTop).toBeGreaterThan(0);
  });

  it("ranks by the fee at the moment of comparison, not the fee at arrival", () => {
    resetHashes();
    const world = createWorld({ maxEntities: 2, topQuota: 2 });
    world.baseFeePerGas = BASE;
    world.heightFor = (tip) => 1 - Math.min(1, tip / 60e9);

    // A legacy bid is a single price: its priority fee is whatever is left
    // over the base fee, so it moves every time the base fee does.
    const legacyBid = tx({ hash: hashOf(600), fees: legacy(42) }); // tip 30 now
    const typed = tx({ hash: hashOf(601), fees: eip1559(25, 100) }); // tip 25
    const now = admit(world, [legacyBid, typed], 1_700_000_000_000);
    expect(world.entities.filter((e) => e.slot === "top")).toHaveLength(2);

    // The base fee rises 20 gwei: the legacy bid is now the weaker of the two.
    world.baseFeePerGas = BASE + 20e9; // legacy tip 10, typed tip 25
    const contender = tx({ hash: hashOf(602), fees: eip1559(20, 100) }); // tip 20
    admit(world, [contender], now);

    const reserved = world.entities.filter((e) => e.slot === "top").map((e) => e.hash);
    expect(reserved).toContain(contender.hash);
    expect(reserved).toContain(typed.hash);
    expect(reserved).not.toContain(legacyBid.hash);
  });
});

describe("marks at the floor spread through the band", () => {
  /**
   * A floor mark's y inside the band is packing space, chosen by the mark's
   * own seed: deterministic, so a replay lands it in the same place and a
   * recalibration of the axis does not move it, and spread, so a population
   * reads as density rather than as one dot drawn three hundred times.
   */
  it("places floor tips below the axis and axis tips above it", () => {
    resetHashes();
    const world = createWorld({ maxEntities: 400, topQuota: 0 });
    world.baseFeePerGas = 10e9;
    world.heightFor = (tip) => (tip <= 1e6 ? 1 - FLOOR_BAND : 0.3);
    let now = 1_700_000_000_000;
    for (let i = 0; i < 300; i++) {
      enqueue(world, [
        tx({ hash: hashOf(3000 + i), fees: legacy(10) }), // tip 0: the floor
        tx({ hash: hashOf(4000 + i), fees: eip1559(2, 30) }), // a bid
      ]);
      step(world, 16, (now += 16));
    }
    const floor = world.entities.filter((e) => e.fees.kind === "legacy");
    const bids = world.entities.filter((e) => e.fees.kind === "eip1559");
    expect(floor.length).toBeGreaterThan(50);
    for (const e of floor) {
      expect(e.homeY).toBeGreaterThan(1 - FLOOR_BAND);
      expect(e.homeY).toBeLessThan(1);
    }
    for (const e of bids) expect(e.homeY).toBeLessThan(1 - FLOOR_BAND);
    // Spread, not stacked: the population reaches across most of the band,
    // and at a resolution finer than the band is tall the heights are many.
    const ys = floor.map((e) => e.homeY);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(FLOOR_BAND * 0.6);
    const distinct = new Set(ys.map((y) => y.toFixed(4)));
    expect(distinct.size).toBeGreaterThan(floor.length * 0.5);
  });

  it("keeps a floor mark where it is when the axis recalibrates", () => {
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.baseFeePerGas = 10e9;
    world.heightFor = () => 0.5;
    let now = 1_700_000_000_000;
    // An arrival is offered once and the meter only accrues while draining,
    // so it is re-offered each frame until the meter lets it in.
    const arrival = tx({ hash: hashOf(5000), fees: legacy(10) });
    for (let i = 0; i < 60 && world.entities.length === 0; i++) {
      enqueue(world, [arrival]);
      step(world, 16, (now += 16));
    }
    expect(world.entities).toHaveLength(1);
    const before = world.entities[0].homeY;
    world.heightFor = () => 0.1; // the axis moved
    for (let i = 0; i < 200; i++) step(world, 16, (now += 16));
    expect(world.entities[0].homeY).toBe(before);
  });
});
