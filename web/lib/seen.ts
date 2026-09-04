import type { Fees, Hex, PendingTx } from "@/types/stream";
import { effectivePriorityFee } from "@/lib/fees";

/**
 * The record of every transaction hash the stream has announced as pending.
 *
 * ## This is not the render pool
 *
 * The render pool is capped at 300 entities and evicts the lowest fee. This map
 * is bounded by **age** and evicts oldest first. Conflating them is the single
 * most damaging mistake available in this codebase: a 150-transaction block
 * checked against a 300-entity render window barely overlaps, so nearly every
 * transaction would be reported as private flow. That is precisely the lie the
 * calibration phase exists to prevent — except permanent instead of during
 * warm-up.
 *
 * Nothing here knows about drawing, and nothing that draws may write to it.
 *
 * ## Sizing
 *
 * A mainnet firehose runs a few hundred tx/s. At 300/s with a 36s window that
 * is ~11k hashes; at 66 bytes per hash plus Map overhead, comfortably under a
 * megabyte. The window is deliberately several block times long, because a
 * transaction that entered the pool three blocks ago and lands now is not a
 * ghost.
 *
 * ## Why it stores fees and not just hashes
 *
 * The render pool samples 300 of the tens of thousands of pending transactions,
 * so when a block lands only about 12% of its seen transactions have a mark on
 * screen — and, measured, those turn out to be exactly the reserved top quota,
 * every block. A flight animation sourced from the render pool would therefore
 * show the same fifteen expensive transactions each time and leave 88% of the
 * seen ones with no trajectory at all, which reads as private flow. The claim
 * the product exists to make would be wrong.
 *
 * So the seen-set is the source for flights, and it has to carry enough to
 * place a mark honestly: the fee decides its height, `firstSeen` decides its
 * alpha. Only x is invented, and x is packing space that carries no meaning by
 * design.
 */

/**
 * How long a hash is remembered.
 *
 * Every eviction is a potential false ghost: forget a transaction that is still
 * pending, watch it land, and the app reports private flow where there was
 * none. So this is sized against mempool *residence*, not against block time.
 * Three block times was the first guess and it was measurably wrong — the probe
 * showed blocks reporting 59% ghosts against a source generating at most 40%,
 * entirely from transactions the set had forgotten while they were still in the
 * pool.
 *
 * Five minutes covers the ordinary residence distribution with room to spare.
 * The long tail (underpriced transactions sitting for hours) is not covered and
 * cannot be, which is why `MAX_ENTRIES` eviction is logged rather than silent.
 */
export const DEFAULT_TTL_MS = 300_000;

/**
 * Hard bound on the map, so a traffic spike cannot exhaust memory before the
 * TTL gets a chance to bite. At a few hundred tx/s the TTL binds first and this
 * never triggers; when it does, it is reported.
 */
export const DEFAULT_MAX_ENTRIES = 150_000;

/** Blocks to observe before trusting classification, absent a snapshot. */
export const DEFAULT_WARMUP_BLOCKS = 5;

export type SeenSetOptions = {
  ttlMs?: number;
  maxEntries?: number;
  warmupBlocks?: number;
};

/** What the mempool knew about a transaction, kept for the flight. */
export type SeenRecord = {
  firstSeen: number;
  fees: Fees;
  /** Gas limit as announced. See `PendingTx.gas`. */
  gas: number;
  /** Set once the hash turns up in a block. Kept for classification either way. */
  included: boolean;
};

export type SeenSet = {
  /** Records a transaction if new. Re-announcing does not refresh its age. */
  add(hash: Hex, record: SeenRecord): void;
  addMany(txs: readonly PendingTx[]): void;
  /**
   * Seeds from the pool snapshot the stream sends on open, and marks the set
   * warm. This is what actually closes the cold start: block counting only
   * narrows it, because a transaction can sit in the pool for minutes and land
   * long after we connected, looking private when it never was.
   *
   * With `reconcile`, the snapshot is also the authority on what is still
   * pending: every record not yet included and absent from it is forgotten.
   * For a tab coming back after minutes away — the stream was dropped on
   * purpose, blocks landed unseen — the pending count would otherwise carry
   * transactions that were mined or dropped while nobody was listening, for
   * as long as the TTL. Records that were included stay, so a reorg that
   * returns one of them to the pool still finds its record.
   */
  seedFromSnapshot(
    txs: readonly PendingTx[],
    options?: { reconcile?: boolean },
  ): void;
  has(hash: Hex): boolean;
  /** What was known about this hash, if anything. */
  get(hash: Hex): SeenRecord | undefined;
  /**
   * The product's central claim: this hash landed in a block without the public
   * mempool ever announcing it.
   *
   * Only meaningful once `isWarm()`. Before that it reports our own ignorance,
   * which is a true statement about us and a false one about the chain — so the
   * caller gates on warmth rather than trusting this alone.
   */
  isGhost(hash: Hex): boolean;
  /** Drops everything older than the TTL. Cheap: the Map is in insert order. */
  prune(now: number): void;
  /**
   * Hashes dropped because the size cap bound before the TTL did. Any non-zero
   * value means the set is forgetting live transactions, so some share of the
   * reported ghosts are this bug rather than private flow. Surface it.
   */
  capacityEvictions(): number;
  /**
   * Marks a hash as included in a block. Does not forget it — the record is
   * still needed to classify, and to fly the transaction that owns it.
   */
  markIncluded(hash: Hex): void;
  /**
   * Reverses `markIncluded`: the block that included this hash was replaced
   * and the transaction is back in the pool. Its record is kept — it is still
   * true that the mempool announced it — so if it lands again it flies again.
   * A hash the set does not hold, a ghost or one it has forgotten, is a no-op.
   */
  unmarkIncluded(hash: Hex): void;
  /**
   * Transactions announced and not yet seen in a block.
   *
   * This is the number the instrument reports, and it is deliberately not the
   * entity count: the render pool samples 300 of these, and reporting what was
   * drawn instead of what exists would make the counter a statement about the
   * renderer. The render is sampled; the datum never is.
   *
   * Bounded below by the TTL: a transaction pending longer than the window is
   * pruned and stops being counted, so this under-reports the long tail.
   */
  pending(): number;
  /**
   * Pending transactions whose effective priority fee, at `baseFeePerGas`, is
   * at or under `tipWei`.
   *
   * The instrument's fee axis has a floor, and on mainnet most of the pool is
   * on it: measured on the recording, 65.8% of announced transactions offered
   * nothing above the base fee. The axis clamps them to its lowest bound and
   * they pile there as a row of dots — the largest single reading in the
   * chamber, presented as a heap. This counts them so the panel can say so.
   */
  pendingAtOrBelow(tipWei: number, baseFeePerGas: number): number;
  /** Call once per observed block so warm-up can advance. */
  noteBlock(): void;
  isWarm(): boolean;
  blocksObserved(): number;
  warmupBlocks(): number;
  seededBySnapshot(): boolean;
  size(): number;
  /** Everything the instrument needs to report the warm-up honestly. */
  calibration(): CalibrationState;
};

/**
 * How the app is doing at working out what it does not know.
 *
 * `closedBy` matters to the reader: a snapshot means the ingest handed over the
 * pool and the answer is trustworthy immediately; counting blocks means we
 * simply waited and the long tail of old pending transactions may still produce
 * a false ghost or two. Those are different kinds of confidence and the
 * instrument should not present them as the same thing.
 */
export type CalibrationState = {
  active: boolean;
  blocksObserved: number;
  warmupBlocks: number;
  closedBy: "snapshot" | "blocks" | null;
};

export function createSeenSet(options: SeenSetOptions = {}): SeenSet {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const warmupTarget = options.warmupBlocks ?? DEFAULT_WARMUP_BLOCKS;

  /**
   * Insertion-ordered by construction: `Map.set` on an existing key keeps its
   * original position, so re-announcements never push a hash to the back and
   * the front of the map is always the oldest entry. That is what makes
   * `prune` an O(expired) sweep instead of a full scan.
   */
  const recordByHash = new Map<Hex, SeenRecord>();
  let blocks = 0;
  let seeded = false;
  let capacityEvicted = 0;

  let pendingCount = 0;

  function forget(hash: Hex): void {
    const record = recordByHash.get(hash);
    if (record && !record.included) pendingCount -= 1;
    recordByHash.delete(hash);
  }

  function add(hash: Hex, record: SeenRecord): void {
    if (recordByHash.has(hash)) return;
    recordByHash.set(hash, record);
    pendingCount += 1;
    if (recordByHash.size > maxEntries) {
      // Oldest first. This is the eviction that manufactures false ghosts, so
      // it is counted rather than done quietly.
      const oldest = recordByHash.keys().next();
      if (!oldest.done) {
        forget(oldest.value);
        capacityEvicted += 1;
      }
    }
  }

  function addMany(txs: readonly PendingTx[]): void {
    // `fees` is the object off the wire, held by reference: no copy, and the
    // effective tip stays recomputable against whatever the base fee becomes.
    for (const tx of txs) {
      add(tx.hash, {
        firstSeen: tx.firstSeen,
        fees: tx.fees,
        gas: tx.gas,
        included: false,
      });
    }
  }

  return {
    add,
    addMany,
    seedFromSnapshot(txs, options) {
      if (options?.reconcile) {
        const inSnapshot = new Set<Hex>();
        for (const tx of txs) inSnapshot.add(tx.hash);
        for (const [hash, record] of recordByHash) {
          if (!record.included && !inSnapshot.has(hash)) forget(hash);
        }
      }
      addMany(txs);
      seeded = true;
    },
    has: (hash) => recordByHash.has(hash),
    get: (hash) => recordByHash.get(hash),
    isGhost: (hash) => !recordByHash.has(hash),
    prune(now) {
      const cutoff = now - ttlMs;
      for (const [hash, record] of recordByHash) {
        if (record.firstSeen >= cutoff) break; // oldest-first ends the sweep
        forget(hash);
      }
    },
    markIncluded(hash) {
      const record = recordByHash.get(hash);
      if (record && !record.included) {
        record.included = true;
        pendingCount -= 1;
      }
    },
    unmarkIncluded(hash) {
      const record = recordByHash.get(hash);
      if (record && record.included) {
        record.included = false;
        pendingCount += 1;
      }
    },
    pending: () => pendingCount,
    pendingAtOrBelow(tipWei, baseFeePerGas) {
      let n = 0;
      for (const record of recordByHash.values()) {
        if (record.included) continue;
        if (effectivePriorityFee(record.fees, baseFeePerGas) <= tipWei) n += 1;
      }
      return n;
    },
    capacityEvictions: () => capacityEvicted,
    noteBlock() {
      blocks += 1;
    },
    isWarm: () => seeded || blocks >= warmupTarget,
    blocksObserved: () => blocks,
    warmupBlocks: () => warmupTarget,
    seededBySnapshot: () => seeded,
    size: () => recordByHash.size,
    calibration: () => ({
      active: !(seeded || blocks >= warmupTarget),
      blocksObserved: blocks,
      warmupBlocks: warmupTarget,
      closedBy: seeded ? "snapshot" : blocks >= warmupTarget ? "blocks" : null,
    }),
  };
}
