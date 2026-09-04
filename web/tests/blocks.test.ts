import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEDGER_DEPTH,
  createBlockLedger,
  ingestBlock,
  type BlockLedger,
} from "@/lib/blocks";
import { createSeenSet, type SeenSet } from "@/lib/seen";
import { createWorld, tipOf, type WorldState } from "@/lib/canvas/world";
import { RATIO_WINDOW_BLOCKS, readout } from "@/lib/readout";
import { createSyntheticSource } from "@/lib/stream/synthetic";
import type { BlockEvent, Hex, PendingTx } from "@/types/stream";
import { eip1559, hashOf, resetHashes } from "./helpers";

/**
 * The chain changing its mind, and the one path a block takes to the screen.
 *
 * A reorg is the failure shape this codebase is built to fear: nothing errors,
 * the replacement lands like any block, and every reading on the panel stays
 * plausible while three of them are wrong — a ratio for a block that no longer
 * exists, a record marking transactions included that are back in the pool,
 * and a strip labelled with a number the chain withdrew. Each assertion below
 * names which of those it is guarding against.
 *
 * `ingestBlock` is tested end to end rather than the ledger alone because the
 * ledger being right is not the claim. The claim is what the seen-set, the
 * world and the readout say afterwards.
 */

const NOW = 1_700_000_000_000;

function fresh() {
  resetHashes();
  const world = createWorld({ maxEntities: 10, topQuota: 0 });
  world.heightFor = () => 0.5;
  const seen = createSeenSet({ warmupBlocks: 1 });
  const ledger = createBlockLedger();
  return { world, seen, ledger };
}

function announce(seen: SeenSet, hashes: readonly Hex[]) {
  for (const hash of hashes) {
    seen.add(hash, {
      firstSeen: NOW - 5000,
      fees: eip1559(2, 30),
      gas: 21000,
      included: false,
    });
  }
}

function blockOf(number: number, hashes: Hex[], timestamp = NOW): BlockEvent {
  return {
    number,
    timestamp,
    baseFeePerGas: 12e9,
    hashes,
    gasUsed: hashes.map(() => 40_000),
  };
}

function land(
  { world, seen, ledger }: { world: WorldState; seen: SeenSet; ledger: BlockLedger },
  block: BlockEvent,
) {
  return ingestBlock({ block, seen, world, ledger, rand: () => 0.5 });
}

function warmUp(ctx: ReturnType<typeof fresh>) {
  // One cold block closes a one-block warm-up.
  land(ctx, blockOf(21_000_000, [hashOf(900)]));
  expect(ctx.seen.isWarm()).toBe(true);
}

describe("block ledger", () => {
  it("calls a higher number new, including across a gap", () => {
    const ledger = createBlockLedger();
    expect(ledger.judge(blockOf(10, [hashOf(1)]))).toEqual({ kind: "new" });
    ledger.record(blockOf(10, [hashOf(1)]), 0.2, { kind: "new" });
    // Missed blocks are the feed's failure, not a reorg.
    expect(ledger.judge(blockOf(13, [hashOf(2)]))).toEqual({ kind: "new" });
  });

  it("calls the head again with the same hashes a duplicate", () => {
    const ledger = createBlockLedger();
    const block = blockOf(10, [hashOf(1), hashOf(2)]);
    ledger.record(block, 0.5, { kind: "new" });
    expect(ledger.judge({ ...block, timestamp: NOW + 1 })).toEqual({
      kind: "duplicate",
    });
    // And records nothing for it: the ratio window must not count a block
    // twice because the ingest sent it twice.
    ledger.record(block, 0.5, { kind: "duplicate" });
    expect(ledger.ratios()).toEqual([0.5]);
  });

  it("calls the same height with different hashes a replacement, naming the orphans", () => {
    const ledger = createBlockLedger();
    ledger.record(blockOf(10, [hashOf(1), hashOf(2), hashOf(3)]), 0.5, {
      kind: "new",
    });
    // hashOf(2) survives into the replacement; 1 and 3 are orphaned.
    const verdict = ledger.judge(blockOf(10, [hashOf(2), hashOf(4)]));
    expect(verdict).toEqual({
      kind: "replacement",
      orphaned: [hashOf(1), hashOf(3)],
      depth: 1,
    });
  });

  it("withdraws every block from the replaced height up", () => {
    const ledger = createBlockLedger();
    ledger.record(blockOf(10, [hashOf(1)]), 0.1, { kind: "new" });
    ledger.record(blockOf(11, [hashOf(2)]), 0.2, { kind: "new" });
    ledger.record(blockOf(12, [hashOf(3)]), 0.3, { kind: "new" });
    const verdict = ledger.judge(blockOf(11, [hashOf(9)]));
    expect(verdict).toMatchObject({ kind: "replacement", depth: 2 });
    expect((verdict as { orphaned: Hex[] }).orphaned).toEqual([
      hashOf(2),
      hashOf(3),
    ]);
    ledger.record(blockOf(11, [hashOf(9)]), 0.9, verdict);
    // The ratio for block 12 is gone, not merely superseded: the window is a
    // statement about canonical blocks and 12 is not one any more.
    expect(ledger.ratios()).toEqual([0.1, 0.9]);
    expect(ledger.head()).toBe(11);
    expect(ledger.reorgs()).toBe(1);
  });

  it("keeps the ratio window to its size and skips unclassified blocks", () => {
    const ledger = createBlockLedger();
    ledger.record(blockOf(1, [hashOf(1)]), null, { kind: "new" });
    for (let n = 2; n <= RATIO_WINDOW_BLOCKS + 5; n++) {
      ledger.record(blockOf(n, [hashOf(n)]), n / 100, { kind: "new" });
    }
    const ratios = ledger.ratios();
    expect(ratios).toHaveLength(RATIO_WINDOW_BLOCKS);
    expect(ratios[0]).toBe(6 / 100);
    expect(ratios.at(-1)).toBe((RATIO_WINDOW_BLOCKS + 5) / 100);
  });

  it("is bounded, and says how deep a reorg it could not fully undo went", () => {
    const ledger = createBlockLedger();
    for (let n = 1; n <= LEDGER_DEPTH + 10; n++) {
      ledger.record(blockOf(n, [hashOf(n)]), 0.1, { kind: "new" });
    }
    // Below everything held: the whole ledger is withdrawn, and the depth
    // reports what was held, not what the chain actually replaced.
    const verdict = ledger.judge(blockOf(1, [hashOf(999)]));
    expect(verdict).toMatchObject({ kind: "replacement", depth: LEDGER_DEPTH });
  });
});

describe("ingesting a block", () => {
  it("classifies against the record and counts the block toward warm-up", () => {
    const ctx = fresh();
    warmUp(ctx);
    announce(ctx.seen, [hashOf(1), hashOf(2)]);
    const verdict = land(ctx, blockOf(21_000_001, [hashOf(1), hashOf(2), hashOf(3)]));
    expect(verdict).toEqual({ kind: "new" });
    const origins = ctx.world.block.map((mark) => mark.origin);
    expect(origins).toEqual(["seen", "seen", "ghost"]);
    expect(ctx.ledger.ratios()).toEqual([1 / 3]);
    expect(ctx.seen.blocksObserved()).toBe(2);
  });

  it("places a ghost by the tip the block says it paid, and a seen row by its own record", () => {
    const ctx = fresh();
    warmUp(ctx);
    announce(ctx.seen, [hashOf(1)]);
    const withTips = { ...blockOf(21_000_001, [hashOf(1), hashOf(2)]), tips: [7e9, 3e9] };
    land(ctx, withTips);
    const [seenMark, ghost] = ctx.world.block;
    expect(ghost!.origin).toBe("ghost");
    // The receipt's tip, at this block's base fee.
    expect(tipOf(ctx.world, ghost!)).toBe(3e9);
    // The seen row keeps what the mempool knew (a 2 gwei tip), not the 7 the block reports.
    expect(tipOf(ctx.world, seenMark!)).toBe(2e9);

    // Without tips a ghost has no bid to show and sits at zero — the old
    // behaviour, kept for an ingest that cannot send them.
    land(ctx, blockOf(21_000_002, [hashOf(3)]));
    const [bare] = ctx.world.block;
    expect(bare!.origin).toBe("ghost");
    expect(tipOf(ctx.world, bare!)).toBe(0);
  });

  it("ignores a duplicate frame completely", () => {
    const ctx = fresh();
    warmUp(ctx);
    announce(ctx.seen, [hashOf(1)]);
    const block = blockOf(21_000_001, [hashOf(1), hashOf(2)]);
    land(ctx, block);
    const before = {
      block: ctx.world.block,
      observed: ctx.seen.blocksObserved(),
      pending: ctx.seen.pending(),
      ratios: ctx.ledger.ratios(),
    };
    const verdict = land(ctx, { ...block, timestamp: NOW + 3000 });
    expect(verdict).toEqual({ kind: "duplicate" });
    // Same array, not an equal one: the world was not touched.
    expect(ctx.world.block).toBe(before.block);
    expect(ctx.seen.blocksObserved()).toBe(before.observed);
    expect(ctx.seen.pending()).toBe(before.pending);
    expect(ctx.ledger.ratios()).toEqual(before.ratios);
    expect(ctx.ledger.reorgs()).toBe(0);
  });

  describe("a replacement", () => {
    function replaced() {
      const ctx = fresh();
      warmUp(ctx);
      // Block A: two public, one private.
      announce(ctx.seen, [hashOf(1), hashOf(2)]);
      land(ctx, blockOf(21_000_001, [hashOf(1), hashOf(2), hashOf(3)]));
      const pendingAfterA = ctx.seen.pending();
      // Block A': hashOf(1) survives, hashOf(2) is orphaned, hashOf(4) is a
      // new ghost. Ratio goes from 1/3 to 1/2.
      const verdict = land(
        ctx,
        blockOf(21_000_001, [hashOf(1), hashOf(4)], NOW + 2000),
      );
      return { ctx, verdict, pendingAfterA };
    }

    it("is recognised as one", () => {
      const { verdict } = replaced();
      // Both hashes A held and A' does not. The ledger does not know that
      // hashOf(3) was a ghost — that is the seen-set's knowledge, and for a
      // ghost the return to pending is a no-op there.
      expect(verdict).toEqual({
        kind: "replacement",
        orphaned: [hashOf(2), hashOf(3)],
        depth: 1,
      });
    });

    it("returns the orphaned transaction to pending, keeping its record", () => {
      const { ctx, pendingAfterA } = replaced();
      // Guards: a record still marked included for a transaction that is back
      // in the pool. It would neither be counted as pending nor fly again.
      expect(ctx.seen.pending()).toBe(pendingAfterA + 1);
      expect(ctx.seen.get(hashOf(2))?.included).toBe(false);
      expect(ctx.seen.get(hashOf(1))?.included).toBe(true);
    });

    it("replaces the ratio instead of appending it", () => {
      const { ctx } = replaced();
      // Guards: a window holding a ratio for a block that no longer exists,
      // dragging the range with a figure the chain withdrew.
      expect(ctx.ledger.ratios()).toEqual([1 / 2]);
      expect(ctx.ledger.reorgs()).toBe(1);
    });

    it("discards the orphaned block rather than demoting it to the strip", () => {
      const { ctx } = replaced();
      // Guards: a strip labelled 21,000,001 beside a block labelled
      // 21,000,001 — history that did not happen, presented as history.
      expect(ctx.world.lastBlock?.number).toBe(21_000_001);
      expect(ctx.world.previousBlockNumber).toBe(21_000_000);
      expect(ctx.world.block.map((m) => m.hash)).toEqual([hashOf(1), hashOf(4)]);
    });

    it("does not count toward warm-up", () => {
      const { ctx } = replaced();
      // Two heights observed, three frames. A block replaced at the same
      // height added no time to how long the pool has been watched.
      expect(ctx.seen.blocksObserved()).toBe(2);
    });

    it("lets the orphaned transaction fly again when it lands later", () => {
      const { ctx } = replaced();
      land(ctx, blockOf(21_000_002, [hashOf(2)], NOW + 12_000));
      const mark = ctx.world.block[0];
      expect(mark.origin).toBe("seen");
      expect(ctx.seen.get(hashOf(2))?.included).toBe(true);
    });

    it("is reported on the readout", () => {
      const { ctx } = replaced();
      const out = readout({
        world: ctx.world,
        seen: ctx.seen,
        ticks: [],
        axisSamples: 0,
        axisBounds: null,
        view: { width: 1440, height: 900 },
        recentRatios: ctx.ledger.ratios(),
        reorgs: ctx.ledger.reorgs(),
        lastBlockAt: NOW,
        lastEventAt: NOW,
        subscribed: true,
        budgetReduced: false,
        now: NOW,
      });
      expect(out.reorgs).toBe(1);
      expect(out.ghostRatio).toBe(1 / 2);
    });
  });
});

describe("the generator can produce a reorg", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("re-issues a block number with different hashes, and the ingest handles it", () => {
    resetHashes();
    const blocks: BlockEvent[] = [];
    const txs: PendingTx[] = [];
    const stop = createSyntheticSource({
      reorgEveryBlocks: 2,
      emitSnapshot: false,
    })(
      (batch) => txs.push(...batch),
      (block) => blocks.push(block),
    );
    vi.advanceTimersByTime(12_000 * 3 + 5000);
    stop();

    const numbers = blocks.map((b) => b.number);
    // Three heights, and the second was issued twice.
    expect(numbers).toEqual([21_000_000, 21_000_001, 21_000_001, 21_000_002]);
    const [, first, second] = blocks;
    expect(second.hashes).not.toEqual(first.hashes);
    expect(second.hashes).toHaveLength(first.hashes.length);
    expect(second.gasUsed).toHaveLength(second.hashes.length);
    expect(second.timestamp).toBeGreaterThan(first.timestamp);

    // Now the real pipeline, fed exactly what the generator emitted.
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const seen = createSeenSet({ warmupBlocks: 1 });
    const ledger = createBlockLedger();
    seen.addMany(txs);
    const ingest = (block: BlockEvent) =>
      ingestBlock({ block, seen, world, ledger, rand: () => 0.5 });
    const verdicts = blocks.slice(0, 3).map(ingest);
    expect(verdicts.map((v) => v.kind)).toEqual(["new", "new", "replacement"]);
    expect(ledger.reorgs()).toBe(1);

    // The rows the replacement dropped went back to pending, so the pool did
    // not lose them: every hash the orphaned block included and the
    // replacement did not is still known and not included. Checked before
    // the next block lands, because those rows are the best-paying in the
    // pool and the next block takes them straight back.
    const orphaned = first.hashes.filter((h) => !second.hashes.includes(h));
    expect(orphaned.length).toBeGreaterThan(0);
    for (const hash of orphaned) {
      // Public rows by construction: the generator only withdraws announced
      // ones, so every orphan has a record and the assertion is never vacuous.
      expect(seen.get(hash)?.included).toBe(false);
    }

    expect(ingest(blocks[3]).kind).toBe("new");
    expect(ledger.head()).toBe(21_000_002);
    // Two classified canonical blocks after a one-block warm-up: 21_000_001
    // (replaced, one ratio) and 21_000_002.
    expect(ledger.ratios()).toHaveLength(2);
    // And the orphans that landed again flew again, as public flow.
    for (const mark of world.block) {
      if (orphaned.includes(mark.hash)) expect(mark.origin).toBe("seen");
    }
  });

  it("changes nothing when the option is off", () => {
    resetHashes();
    const run = (opts: { reorgEveryBlocks?: number }) => {
      const blocks: BlockEvent[] = [];
      const stop = createSyntheticSource({ ...opts, emitSnapshot: false })(
        () => {},
        (block) => blocks.push(block),
      );
      vi.advanceTimersByTime(12_000 * 3 + 5000);
      stop();
      return blocks;
    };
    // The reference generator is what every visual constant was calibrated
    // against; the option must not shift its sequence when it is not on.
    // Hashes, not whole blocks: timestamps come from the clock, which the
    // second run reads forty seconds later.
    const hashesOf = (blocks: BlockEvent[]) => blocks.map((b) => b.hashes);
    expect(hashesOf(run({}))).toEqual(hashesOf(run({ reorgEveryBlocks: 0 })));
  });
});
