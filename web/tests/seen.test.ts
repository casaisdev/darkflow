import { describe, expect, it } from "vitest";
import {
  DEFAULT_TTL_MS,
  DEFAULT_WARMUP_BLOCKS,
  createSeenSet,
} from "@/lib/seen";
import { eip1559, hashOf, legacy, resetHashes, tx } from "./helpers";

/**
 * The file that decides whether the product tells the truth.
 *
 * A hash absent from this set is drawn in `--ghost` and counted as private
 * flow. Every way it can lose a hash it should have kept is a way the product
 * manufactures a claim about the Ethereum network that is simply false, so the
 * two mechanisms that drop entries — the TTL and the capacity cap — are tested
 * for what they drop *and* for whether they say so.
 */

describe("seen set", () => {
  it("classifies only hashes it has never been told about", () => {
    resetHashes();
    const seen = createSeenSet();
    const known = tx();
    seen.addMany([known]);
    expect(seen.isGhost(known.hash)).toBe(false);
    expect(seen.isGhost(hashOf(9999))).toBe(true);
  });

  it("keeps the first sighting when a hash is re-announced", () => {
    resetHashes();
    const seen = createSeenSet();
    const hash = hashOf(1);
    seen.addMany([tx({ hash, firstSeen: 1000 })]);
    seen.addMany([tx({ hash, firstSeen: 9000 })]);
    // Re-announcement is normal: the same transaction is gossiped repeatedly.
    // Taking the later timestamp would extend its life past the TTL and
    // silently change what the age-based eviction means.
    expect(seen.get(hash)?.firstSeen).toBe(1000);
    expect(seen.size()).toBe(1);
  });

  describe("TTL eviction", () => {
    it("drops entries older than the TTL and keeps the rest", () => {
      resetHashes();
      const seen = createSeenSet({ ttlMs: 1000 });
      seen.addMany([
        tx({ hash: hashOf(1), firstSeen: 0 }),
        tx({ hash: hashOf(2), firstSeen: 500 }),
        tx({ hash: hashOf(3), firstSeen: 900 }),
      ]);
      seen.prune(1500);
      expect(seen.has(hashOf(1))).toBe(false); // age 1500, past the TTL
      expect(seen.has(hashOf(2))).toBe(true); // age 1000, exactly at it
      expect(seen.has(hashOf(3))).toBe(true);
      expect(seen.size()).toBe(2);
    });

    it("stops the sweep at the first live entry", () => {
      // The map is insertion-ordered and insertion order is arrival order, so
      // `prune` may stop at the first survivor. If entries were ever inserted
      // out of order this would silently retain expired hashes, so the
      // property is asserted rather than trusted.
      resetHashes();
      const seen = createSeenSet({ ttlMs: 1000 });
      for (let i = 0; i < 50; i++) {
        seen.addMany([tx({ hash: hashOf(i), firstSeen: i * 100 })]);
      }
      seen.prune(3000);
      // Everything with firstSeen < 2000, i.e. i < 20, is gone.
      expect(seen.size()).toBe(30);
      expect(seen.has(hashOf(19))).toBe(false);
      expect(seen.has(hashOf(20))).toBe(true);
    });

    it("defaults to five minutes, long enough to outlive a pooled transaction", () => {
      // Measured, not chosen: at 36s the classifier reported 59.3% ghosts
      // against a generator producing 40%. A transaction can sit in the pool
      // for minutes, and a TTL under that manufactures ghosts.
      expect(DEFAULT_TTL_MS).toBe(300_000);
      // Twenty blocks of slack. A transaction is routinely outbid for that long.
      expect(DEFAULT_TTL_MS).toBeGreaterThan(20 * 12_000);
    });
  });

  describe("capacity eviction", () => {
    it("evicts the oldest entry and never does it silently", () => {
      resetHashes();
      const seen = createSeenSet({ maxEntries: 3 });
      for (let i = 0; i < 5; i++) {
        seen.addMany([tx({ hash: hashOf(i), firstSeen: i })]);
      }
      expect(seen.size()).toBe(3);
      expect(seen.has(hashOf(0))).toBe(false);
      expect(seen.has(hashOf(1))).toBe(false);
      expect(seen.has(hashOf(4))).toBe(true);
      // The count is the point. These two hashes will be reported as private
      // flow at the next block, and the only defence against believing that
      // number is knowing the cap fired.
      expect(seen.capacityEvictions()).toBe(2);
    });

    it("reports zero evictions when the cap is never reached", () => {
      resetHashes();
      const seen = createSeenSet({ maxEntries: 10 });
      for (let i = 0; i < 10; i++) seen.addMany([tx({ hash: hashOf(i) })]);
      expect(seen.size()).toBe(10);
      expect(seen.capacityEvictions()).toBe(0);
    });
  });

  describe("pending count", () => {
    it("tracks announced-but-not-included, through both eviction paths", () => {
      resetHashes();
      const seen = createSeenSet({ maxEntries: 4, ttlMs: 1000 });
      for (let i = 0; i < 4; i++) {
        seen.addMany([tx({ hash: hashOf(i), firstSeen: i * 100 })]);
      }
      expect(seen.pending()).toBe(4);

      seen.markIncluded(hashOf(3));
      expect(seen.pending()).toBe(3);
      // Idempotent: a hash included twice must not double-count.
      seen.markIncluded(hashOf(3));
      expect(seen.pending()).toBe(3);

      // Capacity eviction of a still-pending hash.
      seen.addMany([tx({ hash: hashOf(100), firstSeen: 400 })]);
      expect(seen.pending()).toBe(3);

      // Age eviction of an included hash must not decrement again.
      seen.prune(1150);
      expect(seen.pending()).toBe(2);
      expect(seen.pending()).toBe(seen.size() - 1);
    });

    it("returns a hash to pending when its block is withdrawn", () => {
      resetHashes();
      const seen = createSeenSet();
      seen.addMany([tx({ hash: hashOf(1) }), tx({ hash: hashOf(2) })]);
      seen.markIncluded(hashOf(1));
      expect(seen.pending()).toBe(1);

      // A reorg: the block that included hashOf(1) is orphaned.
      seen.unmarkIncluded(hashOf(1));
      expect(seen.pending()).toBe(2);
      expect(seen.get(hashOf(1))?.included).toBe(false);
      // The record survives, so the transaction is still not a ghost.
      expect(seen.isGhost(hashOf(1))).toBe(false);

      // Idempotent both ways, and a no-op on a hash never held: a ghost in
      // the orphaned block has nothing to return to.
      seen.unmarkIncluded(hashOf(1));
      seen.unmarkIncluded(hashOf(99));
      expect(seen.pending()).toBe(2);
      seen.markIncluded(hashOf(1));
      expect(seen.pending()).toBe(1);
    });
  });

  describe("calibration", () => {
    it("stays active until enough blocks have passed", () => {
      const seen = createSeenSet({ warmupBlocks: 3 });
      expect(seen.calibration()).toEqual({
        active: true,
        blocksObserved: 0,
        warmupBlocks: 3,
        closedBy: null,
      });
      seen.noteBlock();
      seen.noteBlock();
      expect(seen.isWarm()).toBe(false);
      seen.noteBlock();
      expect(seen.isWarm()).toBe(true);
      expect(seen.calibration().closedBy).toBe("blocks");
    });

    it("closes immediately on a snapshot, and says which one closed it", () => {
      resetHashes();
      const seen = createSeenSet({ warmupBlocks: 5 });
      seen.seedFromSnapshot([tx(), tx()]);
      expect(seen.isWarm()).toBe(true);
      expect(seen.seededBySnapshot()).toBe(true);
      expect(seen.calibration()).toEqual({
        active: false,
        blocksObserved: 0,
        warmupBlocks: 5,
        closedBy: "snapshot",
      });
    });

    it("warms up over five blocks, a minute of observation", () => {
      expect(DEFAULT_WARMUP_BLOCKS).toBe(5);
    });
  });

  describe("a snapshot that reconciles", () => {
    /**
     * The tab was hidden, the stream was dropped on purpose, and blocks
     * landed unseen. On return the record still counts transactions that were
     * mined or dropped while nobody was listening — for as long as the TTL,
     * which is minutes of a pending figure that describes the past. The
     * reconnection's snapshot is the pool now, and with `reconcile` it is
     * treated as the authority on it.
     */
    it("forgets what the snapshot no longer holds", () => {
      resetHashes();
      const seen = createSeenSet();
      const stays = tx();
      const gone = tx();
      seen.addMany([stays, gone]);
      expect(seen.pending()).toBe(2);

      seen.seedFromSnapshot([stays, tx()], { reconcile: true });
      expect(seen.pending()).toBe(2);
      expect(seen.has(stays.hash)).toBe(true);
      expect(seen.has(gone.hash)).toBe(false);
    });

    it("keeps included records, because a reorg may hand them back", () => {
      resetHashes();
      const seen = createSeenSet();
      const mined = tx();
      seen.addMany([mined]);
      seen.markIncluded(mined.hash);

      // Mined transactions are not in anyone's pool snapshot, and forgetting
      // them here would leave a later reorg's unmarkIncluded with no record
      // to return to pending — the transaction would land again as a ghost.
      seen.seedFromSnapshot([tx()], { reconcile: true });
      expect(seen.get(mined.hash)).toBeDefined();
      seen.unmarkIncluded(mined.hash);
      expect(seen.pending()).toBe(2);
    });

    it("does not reconcile unless asked", () => {
      // The opening snapshot of a fresh session seeds; only a reconnection's
      // snapshot reconciles. A seeding snapshot that quietly dropped records
      // would manufacture ghosts out of the announcements it discarded.
      resetHashes();
      const seen = createSeenSet();
      const before = tx();
      seen.addMany([before]);
      seen.seedFromSnapshot([tx()]);
      expect(seen.has(before.hash)).toBe(true);
    });
  });
});

describe("the pool at the floor", () => {
  /**
   * Two thirds of a mainnet pool offers nothing above the base fee. Measured
   * on the recording: 65.8% of announced transactions, 12.2% of them included
   * within five minutes against 78.4% of the rest. The axis clamps them to its
   * lowest bound; this count is what lets the panel say so.
   */
  it("counts pending records at or under a tip, at the given base fee", () => {
    resetHashes();
    const seen = createSeenSet();
    const base = 10e9;
    seen.addMany([
      tx({ fees: legacy(10) }), // tip 0 at base 10
      tx({ fees: eip1559(0.0005, 30) }), // tip 0.0005 gwei: under the floor
      tx({ fees: eip1559(2, 30) }), // a real bid
      tx({ fees: legacy(10.5) }), // tip 0.5 gwei
    ]);
    expect(seen.pendingAtOrBelow(1e6, base)).toBe(2);
    expect(seen.pending()).toBe(4);
  });

  it("stops counting a record once it is included", () => {
    resetHashes();
    const seen = createSeenSet();
    const zero = tx({ fees: legacy(10) });
    seen.addMany([zero, tx({ fees: eip1559(2, 30) })]);
    expect(seen.pendingAtOrBelow(1e6, 10e9)).toBe(1);
    seen.markIncluded(zero.hash);
    expect(seen.pendingAtOrBelow(1e6, 10e9)).toBe(0);
  });

  it("recomputes against the base fee it is given, not a cached tip", () => {
    // Base fee moves every block, and a tip is a function of it. A legacy
    // transaction at 10 gwei is a zero bid when base is 10 and a 2 gwei bid
    // when base is 8.
    resetHashes();
    const seen = createSeenSet();
    seen.addMany([tx({ fees: legacy(10) })]);
    expect(seen.pendingAtOrBelow(1e6, 10e9)).toBe(1);
    expect(seen.pendingAtOrBelow(1e6, 8e9)).toBe(0);
  });
});
