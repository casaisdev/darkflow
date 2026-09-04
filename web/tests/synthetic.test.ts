import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyntheticSource } from "@/lib/stream/synthetic";
import { createSeenSet } from "@/lib/seen";
import type { BlockEvent, PendingTx } from "@/types/stream";

/**
 * The generator, and the one number that proves the product is honest.
 *
 * The generator knows which hashes it never announced and publishes that on
 * `globalThis.__darkflowSyntheticTruth`. The consumer has to work it out from
 * its own record. Those two numbers agreeing, block after block, is the only
 * evidence that the classifier is right rather than merely plausible — a
 * classifier that is 95% right produces a headline figure that is wrong by
 * more than the effect it is measuring.
 *
 * Everything here runs on fake timers, because the generator is driven by
 * `setInterval` at twelve seconds a block.
 */

const BLOCK_MS = 12_000;
const BATCH_MS = 100;

type Collected = {
  txs: PendingTx[];
  snapshots: PendingTx[][];
  blocks: BlockEvent[];
  stop: () => void;
};

function run(
  blocks: number,
  options: Parameters<typeof createSyntheticSource>[0] = {},
): Collected {
  const txs: PendingTx[] = [];
  const snapshots: PendingTx[][] = [];
  const blocksOut: BlockEvent[] = [];
  const stop = createSyntheticSource(options)(
    (batch, meta) => {
      if (meta.snapshot) snapshots.push([...batch]);
      else txs.push(...batch);
    },
    (block) => blocksOut.push(block),
  );
  // The snapshot is deferred by a zero timeout so a subscriber can finish
  // setting up before it lands.
  vi.advanceTimersByTime(1);
  vi.advanceTimersByTime(blocks * BLOCK_MS);
  return { txs, snapshots, blocks: blocksOut, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  delete globalThis.__darkflowSyntheticTruth;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("synthetic source", () => {
  describe("wire contract", () => {
    it("announces gas on every pending transaction", () => {
      const { txs, snapshots, stop } = run(2);
      stop();
      const all = [...snapshots.flat(), ...txs];
      expect(all.length).toBeGreaterThan(1000);
      // A pending transaction with no gas would make the field's row width
      // meaningless the moment the ingest starts sending real data.
      expect(all.every((tx) => Number.isInteger(tx.gas) && tx.gas > 0)).toBe(
        true,
      );
      expect(all.every((tx) => tx.gas >= 21000)).toBe(true);
    });

    it("reports gasUsed for every hash in the block, ghosts included", () => {
      const { blocks, stop } = run(6);
      stop();
      expect(blocks.length).toBe(6);
      for (const block of blocks) {
        expect(block.hashes.length).toBe(150);
        // Parallel arrays, same length, no holes. This is the only gas figure
        // that exists for private flow, so a short array here would force the
        // renderer to invent a width for exactly the class it must not.
        expect(block.gasUsed.length).toBe(block.hashes.length);
        expect(block.gasUsed.every((g) => Number.isFinite(g) && g > 0)).toBe(
          true,
        );
      }
    });

    // The `value` precision test lived here. It went out with the field it
    // guarded — see the note in `types/stream.ts` for why the field went.

    it("prices fee caps above the base fee, so effective tips are not all zero", () => {
      const { txs, blocks, stop } = run(2);
      stop();
      const base = blocks[0].baseFeePerGas;
      const priced = txs.filter((tx) =>
        tx.fees.kind === "eip1559"
          ? tx.fees.maxFeePerGas > base
          : tx.fees.gasPrice > base,
      );
      // A generator whose caps sit below the base fee degenerates the whole
      // fee axis to zero — which happened once in a measurement harness here
      // and invalidated a day of captures.
      expect(priced.length / txs.length).toBeGreaterThan(0.95);
    });

    it("emits both fee shapes", () => {
      const { txs, stop } = run(2);
      stop();
      const legacy = txs.filter((tx) => tx.fees.kind === "legacy").length;
      expect(legacy).toBeGreaterThan(0);
      expect(legacy / txs.length).toBeLessThan(0.2);
    });

    it("stops emitting once unsubscribed", () => {
      const { blocks, stop } = run(2);
      const before = blocks.length;
      stop();
      vi.advanceTimersByTime(5 * BLOCK_MS);
      // Strict Mode remounts once in development. A source that keeps running
      // after teardown doubles the apparent traffic.
      expect(blocks.length).toBe(before);
    });

    it("batches rather than emitting one callback per transaction", () => {
      const calls: number[] = [];
      const stop = createSyntheticSource({ emitSnapshot: false })(
        (batch) => calls.push(batch.length),
        () => {},
      );
      vi.advanceTimersByTime(1000);
      stop();
      expect(calls.length).toBe(1000 / BATCH_MS);
      expect(calls.every((n) => n === 30)).toBe(true);
    });
  });

  describe("seen-set correctness", () => {
    it("shows zero drift against the generator's own truth over 20 blocks", () => {
      const seen = createSeenSet();
      const drift: { block: number; reported: number; intended: number }[] = [];
      const stop = createSyntheticSource()(
        (batch, meta) => {
          if (meta.snapshot) seen.seedFromSnapshot(batch);
          else seen.addMany(batch);
        },
        (block) => {
          // Classify before noting the block, exactly as `Viz` does.
          const reported = block.hashes.filter((h) => seen.isGhost(h)).length;
          seen.noteBlock();
          for (const hash of block.hashes) seen.markIncluded(hash);
          drift.push({
            block: block.number,
            reported,
            intended: globalThis.__darkflowSyntheticTruth?.intendedGhosts ?? -1,
          });
        },
      );
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(20 * BLOCK_MS);
      stop();

      expect(drift.length).toBe(20);
      // Not "close". Every block, exactly. Any mismatch is a transaction the
      // product would label as private flow when it was public, or the reverse.
      expect(drift.filter((d) => d.reported !== d.intended)).toEqual([]);
      // And the truth must be a real signal, not a constant zero.
      expect(drift.every((d) => d.intended > 0)).toBe(true);
    });

    it("manufactures ghosts when the TTL is too short — the failure it guards against", () => {
      // The mirror of the test above. With a TTL under a block interval the
      // record is gone before the block arrives, so the classifier reports
      // private flow that never existed. This is the bug that shipped once.
      const seen = createSeenSet({ ttlMs: 5_000 });
      let reported = 0;
      let intended = 0;
      const stop = createSyntheticSource()(
        (batch, meta) => {
          if (meta.snapshot) seen.seedFromSnapshot(batch);
          else seen.addMany(batch);
          seen.prune(Date.now());
        },
        (block) => {
          reported += block.hashes.filter((h) => seen.isGhost(h)).length;
          intended += globalThis.__darkflowSyntheticTruth?.intendedGhosts ?? 0;
        },
      );
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(10 * BLOCK_MS);
      stop();
      expect(reported).toBeGreaterThan(intended * 1.5);
    });
  });

  describe("gas ratio", () => {
    /** By-transaction and by-gas ghost share, averaged over `n` blocks. */
    function ratios(n: number, options: Parameters<typeof createSyntheticSource>[0]) {
      const seen = createSeenSet();
      let ghostTx = 0;
      let allTx = 0;
      let ghostGas = 0;
      let allGas = 0;
      const stop = createSyntheticSource(options)(
        (batch, meta) => {
          if (meta.snapshot) seen.seedFromSnapshot(batch);
          else seen.addMany(batch);
        },
        (block) => {
          block.hashes.forEach((hash, i) => {
            const gas = block.gasUsed[i];
            allTx += 1;
            allGas += gas;
            if (seen.isGhost(hash)) {
              ghostTx += 1;
              ghostGas += gas;
            }
          });
          for (const hash of block.hashes) seen.markIncluded(hash);
        },
      );
      vi.advanceTimersByTime(1);
      vi.advanceTimersByTime(n * BLOCK_MS);
      stop();
      return { byTx: ghostTx / allTx, byGas: ghostGas / allGas };
    }

    it("keeps the two ratios together by default", () => {
      const { byTx, byGas } = ratios(30, {});
      // The default gives private flow the same gas distribution as everything
      // else. That is the reference the visual constants were calibrated
      // against, and it must not drift: if this fails, every measured figure
      // in `draw.ts` and `world.ts` was taken against a different generator.
      expect(byTx).toBeGreaterThan(0.2);
      expect(byTx).toBeLessThan(0.35);
      expect(Math.abs(byGas - byTx)).toBeLessThan(0.05);
    });

    it("pushes gas well past transaction count under the MEV scenario", () => {
      const { byTx, byGas } = ratios(30, { ghostGasBias: "mev" });
      // Roughly 27% of the transactions on roughly 45% of the gas. The
      // transaction share is untouched — only the gas each ghost consumes
      // changes — which is what makes the two numbers on the panel diverge.
      expect(byTx).toBeGreaterThan(0.2);
      expect(byTx).toBeLessThan(0.35);
      expect(byGas).toBeGreaterThan(0.4);
      expect(byGas).toBeLessThan(0.5);
      expect(byGas - byTx).toBeGreaterThan(0.12);
    });

    it("moves the gas ratio and leaves the transaction ratio where it was", () => {
      // Not bit-identical, and deliberately not asserted as such: the MEV draw
      // takes a different number of values from the shared PRNG than the
      // default one, so the two sequences diverge even at the same seed.
      //
      // So the transaction share is checked against the generator's declared
      // parameter rather than against the other run. `ghostRatioRange` is
      // uniform on [0.1, 0.4]: mean 0.25, sd 0.3/sqrt(12) = 0.0866, and over
      // sixty blocks the standard error of the mean is 0.0112. A 0.05 band is
      // 4.5 standard errors, which fails on a broken flag and not on a seed.
      const EXPECTED = 0.25;
      const BAND = 0.05;
      const a = ratios(60, { seed: 4242 });
      const b = ratios(60, { seed: 4242, ghostGasBias: "mev" });
      expect(Math.abs(a.byTx - EXPECTED)).toBeLessThan(BAND);
      expect(Math.abs(b.byTx - EXPECTED)).toBeLessThan(BAND);
      // Only the gas moves, and it moves a great deal further than that band.
      expect(b.byGas - a.byGas).toBeGreaterThan(0.12);
      // And the divergence is created by the flag, not present without it.
      expect(Math.abs(a.byGas - a.byTx)).toBeLessThan(BAND);
    });
  });
});

describe("a block is ordered the way a builder orders one", () => {
  /**
   * A row's position in a block is the builder's ordering, and a builder orders
   * by what it is paid. This used to be a Fisher-Yates shuffle: the ghosts were
   * interleaved correctly and every ordering was destroyed with them.
   *
   * The consequence was not local to the generator. The block column shares its
   * top, its bottom and its extent with the chamber, whose vertical axis is the
   * priority fee — so the screen carried two identical vertical axes side by
   * side, one of which measured nothing, with nothing to say which.
   *
   * Checked from where a consumer stands: it cannot see a ghost's tip, because
   * a BlockEvent carries hashes, gas used and the base fee and nothing else. It
   * can see the tips of everything it was told about, and those must fall as
   * the block goes down.
   */
  function tipOf(tx: PendingTx, baseFeePerGas: number) {
    return tx.fees.kind === "legacy"
      ? tx.fees.gasPrice - baseFeePerGas
      : Math.min(
          tx.fees.maxPriorityFeePerGas,
          tx.fees.maxFeePerGas - baseFeePerGas,
        );
  }

  it("puts the announced rows in falling order of what they pay", () => {
    const { txs, snapshots, blocks, stop } = run(4);
    const known = new Map<string, PendingTx>();
    for (const tx of [...snapshots.flat(), ...txs]) known.set(tx.hash, tx);

    let checked = 0;
    for (const block of blocks) {
      const tips = block.hashes
        .map((hash) => known.get(hash))
        .filter((tx): tx is PendingTx => tx !== undefined)
        .map((tx) => tipOf(tx, block.baseFeePerGas));
      expect(tips.length).toBeGreaterThan(10);
      for (let i = 1; i < tips.length; i++) {
        expect(tips[i]).toBeLessThanOrEqual(tips[i - 1]);
      }
      checked += tips.length;
    }
    expect(checked).toBeGreaterThan(100);
    stop();
  });

  it("still spreads private flow through the block", () => {
    /**
     * The interleaving the shuffle was there for. Ghost tips are drawn from the
     * range of the tips actually included, not from the whole pool — drawing
     * from the pool would sink most of them below every public row and pile
     * them at the foot of every block, which is a different lie about where
     * private flow sits.
     */
    const { txs, snapshots, blocks, stop } = run(4);
    const known = new Set(
      [...snapshots.flat(), ...txs].map((tx) => tx.hash),
    );
    for (const block of blocks) {
      const ghostAt = block.hashes
        .map((hash, index) => (known.has(hash) ? -1 : index))
        .filter((index) => index >= 0);
      expect(ghostAt.length).toBeGreaterThan(5);
      const third = block.hashes.length / 3;
      const inThirds = [
        ghostAt.filter((i) => i < third).length,
        ghostAt.filter((i) => i >= third && i <= 2 * third).length,
        ghostAt.filter((i) => i > 2 * third).length,
      ];
      /**
       * Proportional, not merely present. "At least one in the top third and
       * one in the bottom" was the first version of this assertion and it
       * passed on a block carrying 39 ghosts in the top third against 1 in the
       * bottom — which is the pile-up it was written to catch, at the other
       * end of the column.
       */
      for (const count of inThirds) {
        expect(count / ghostAt.length).toBeGreaterThan(0.15);
      }
    }
    stop();
  });
});
