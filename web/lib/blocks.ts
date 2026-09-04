import type { BlockEvent, Hex } from "@/types/stream";
import type { SeenSet } from "@/lib/seen";
import { applyBlock, type BlockArrival, type WorldState } from "@/lib/canvas/world";
import { RATIO_WINDOW_BLOCKS } from "@/lib/readout";

/**
 * What a block frame means, once the chain is allowed to change its mind.
 *
 * The chain does not only grow. A block the client has already classified can
 * be replaced by another at the same height — a reorg — and a client that only
 * ever appends will then hold a ratio for a block that no longer exists, a
 * record marking transactions included that are back in the pool, and a strip
 * labelled with a number the chain has withdrawn. None of that is visible: the
 * replacement lands, the panel updates, and the picture is plausible.
 *
 * So every block frame is judged before it is applied:
 *
 * - **new** — a number above the head. The ordinary case, including a gap
 *   (missed blocks are the feed's problem, not a reorg).
 * - **duplicate** — the head again, same hashes. The ingest re-sent a frame; it
 *   carries no information and is ignored entirely. It does not even count as
 *   evidence that the block feed is alive, because it is not a block.
 * - **replacement** — a number at or below the head with different hashes. The
 *   canonical chain changed. Everything the ledger held from that height up is
 *   withdrawn: the orphaned blocks' transactions that are not in the new block
 *   go back to pending, the ratio window forgets the withdrawn blocks, and the
 *   world discards the block on screen instead of demoting it to history.
 *
 * The ledger is bounded to `LEDGER_DEPTH` blocks. A reorg deeper than that
 * cannot be fully undone — the included hashes of older blocks are gone — and
 * is reported in `depth` so it is at least not silent. On mainnet a reorg of
 * more than one block is rare and more than two is an incident.
 */

/** Blocks kept for undoing. Deeper than any reorg the chain ordinarily has. */
export const LEDGER_DEPTH = Math.max(RATIO_WINDOW_BLOCKS, 32);

export type BlockVerdict =
  | { kind: "new" }
  | { kind: "duplicate" }
  | {
      kind: "replacement";
      /** Hashes included in withdrawn blocks and absent from the new one. */
      orphaned: Hex[];
      /** How many canonical blocks the replacement withdrew. */
      depth: number;
    };

type LedgerEntry = {
  number: number;
  hashes: Hex[];
  /** `null` for a block that landed cold and was never classified. */
  ratio: number | null;
};

export type BlockLedger = {
  /** What this frame is, against what the ledger holds. Does not mutate. */
  judge(block: BlockEvent): BlockVerdict;
  /**
   * Commits a block after it has been classified. On a replacement the
   * withdrawn entries are dropped first; on a duplicate nothing happens.
   */
  record(block: BlockEvent, ratio: number | null, verdict: BlockVerdict): void;
  /**
   * Ghost ratios of the canonical classified blocks, oldest first, at most
   * `RATIO_WINDOW_BLOCKS` of them. What the readout's range is built from.
   */
  ratios(): readonly number[];
  /** Replacements accepted so far. Non-zero is worth a reading on the panel. */
  reorgs(): number;
  /** Highest canonical block number held, or `null` before the first. */
  head(): number | null;
};

function sameHashes(a: readonly Hex[], b: readonly Hex[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function createBlockLedger(): BlockLedger {
  /** Canonical blocks, ascending by number. */
  const entries: LedgerEntry[] = [];
  let reorgCount = 0;

  function head(): number | null {
    return entries.length > 0 ? entries[entries.length - 1].number : null;
  }

  return {
    judge(block) {
      const top = head();
      if (top === null || block.number > top) return { kind: "new" };

      const withdrawn = entries.filter((entry) => entry.number >= block.number);
      if (
        block.number === top &&
        withdrawn.length === 1 &&
        sameHashes(withdrawn[0].hashes, block.hashes)
      ) {
        return { kind: "duplicate" };
      }

      const kept = new Set<Hex>(block.hashes);
      const orphaned: Hex[] = [];
      const seenOrphan = new Set<Hex>();
      for (const entry of withdrawn) {
        for (const hash of entry.hashes) {
          if (kept.has(hash) || seenOrphan.has(hash)) continue;
          seenOrphan.add(hash);
          orphaned.push(hash);
        }
      }
      return { kind: "replacement", orphaned, depth: withdrawn.length };
    },

    record(block, ratio, verdict) {
      if (verdict.kind === "duplicate") return;
      if (verdict.kind === "replacement") {
        let cut = entries.length;
        while (cut > 0 && entries[cut - 1].number >= block.number) cut -= 1;
        entries.length = cut;
        reorgCount += 1;
      }
      entries.push({ number: block.number, hashes: [...block.hashes], ratio });
      if (entries.length > LEDGER_DEPTH) entries.shift();
    },

    ratios() {
      const out: number[] = [];
      for (const entry of entries) if (entry.ratio !== null) out.push(entry.ratio);
      return out.length > RATIO_WINDOW_BLOCKS
        ? out.slice(out.length - RATIO_WINDOW_BLOCKS)
        : out;
    },

    reorgs: () => reorgCount,
    head,
  };
}

export type IngestBlockInputs = {
  block: BlockEvent;
  seen: SeenSet;
  world: WorldState;
  ledger: BlockLedger;
  /** Placement randomness for block marks. Seeded by the caller. */
  rand: () => number;
};

/**
 * A block arrives. The one path from a `block` frame to the screen.
 *
 * This used to be a closure inside `Viz`, which meant the only way to test it
 * was to reimplement it — and `tests/calibration.test.ts` did exactly that,
 * with a copy that could drift from the real one without anything noticing.
 * It is a pure function of its inputs now, and `Viz` is one caller of it.
 *
 * Classification happens here, not in the world: whether a hash was announced
 * is a data question. The world only places what it is told.
 *
 * `isGhost` is deliberately absent. During warm-up the classifier does not run
 * at all — not "runs and is hidden". Hiding the output would still leave the
 * verdict computed, and the point is that during warm-up there is no verdict
 * to have.
 *
 * @returns the verdict, so the caller can decide what the frame was evidence
 * of. A duplicate is evidence of nothing.
 */
export function ingestBlock({
  block,
  seen,
  world,
  ledger,
  rand,
}: IngestBlockInputs): BlockVerdict {
  const verdict = ledger.judge(block);
  if (verdict.kind === "duplicate") return verdict;

  seen.prune(block.timestamp);

  // The orphaned block's transactions are back in the pool. They keep their
  // record — it is still true that the mempool announced them — and stop being
  // counted as included, so if they land again they fly again.
  if (verdict.kind === "replacement") {
    for (const hash of verdict.orphaned) seen.unmarkIncluded(hash);
  }

  const warm = seen.isWarm();
  const arrivals: BlockArrival[] = block.hashes.map((hash, index) => {
    // Observed gas, which the block reports for every transaction — including
    // the ones the mempool never announced.
    const gasUsed = block.gasUsed[index] ?? 0;
    const record = seen.get(hash);
    if (record) {
      return { hash, index, origin: "seen" as const, record, gasUsed };
    }
    const arrival: BlockArrival = {
      hash,
      index,
      origin: warm ? ("ghost" as const) : ("unknown" as const),
      gasUsed,
    };
    // The receipt's tip, as the fee shape whose effective tip it is: a cap of
    // exactly base fee + tip yields the tip at this block's base fee.
    const tip = block.tips?.[index];
    if (tip !== undefined) {
      arrival.paid = { kind: "eip1559", maxPriorityFeePerGas: tip, maxFeePerGas: block.baseFeePerGas + tip };
    }
    return arrival;
  });
  for (const hash of block.hashes) seen.markIncluded(hash);
  applyBlock(world, block, arrivals, rand, {
    replacing: verdict.kind === "replacement",
  });

  // Only a block that was actually classified carries a ratio. The one that
  // closes the warm-up was judged cold, so its zero would drag the low end of
  // the range to a figure never measured.
  const ratio =
    warm && block.hashes.length > 0
      ? arrivals.filter((a) => a.origin === "ghost").length / block.hashes.length
      : null;
  ledger.record(block, ratio, verdict);

  // Counted after classifying, not before. "The first five blocks the app
  // cannot know" has to mean all five: counting first would let the fifth
  // block be judged on the strength of having just arrived.
  //
  // A replacement is not counted. Warm-up measures how long the pool has been
  // watched, and a block replaced at the same height adds no time to that.
  if (verdict.kind === "new") seen.noteBlock();

  return verdict;
}
