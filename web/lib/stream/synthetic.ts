import type {
  BlockEvent,
  Fees,
  Hex,
  PendingTx,
  StreamSource,
} from "@/types/stream";

/**
 * Fake but plausible L1 traffic, so the whole app can be built and judged
 * before `ingest/` exists.
 *
 * What it has to get right, because the visuals are calibrated against it:
 *
 * - **Volume.** A few hundred tx/s, batched, never one callback per tx.
 * - **Fee distribution with a long tail.** Log-normal, not uniform. A uniform
 *   distribution makes the percentile ramp look linear and hides the whole
 *   point of ranking by percentile.
 * - **Real ghosts.** 10–40% of each block is generated fresh at block time and
 *   was never announced as pending. These are the transactions the product
 *   exists to show, and they must be genuinely absent from the pending stream —
 *   not tagged, not flagged, just never mentioned.
 */

/**
 * Test seam. The generator knows which hashes it never announced; the consumer
 * has to work that out for itself. Publishing the truth here lets the probe
 * compare the two numbers exactly, which is the only way to know the classifier
 * is right rather than merely plausible.
 *
 * Nothing in the app may read this. Only `components/StreamProbe.tsx`.
 */
export type SyntheticTruth = {
  blockNumber: number;
  intendedGhosts: number;
  intendedSeen: number;
};

declare global {
  var __darkflowSyntheticTruth: SyntheticTruth | undefined;
}

/** Deterministic PRNG (mulberry32), so a reported ghost ratio is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, for the log-normal fee distribution. */
function gaussian(rand: () => number): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const GWEI = 1e9;

export type SyntheticOptions = {
  seed?: number;
  /** Transactions announced per second. */
  txPerSecond?: number;
  /** How often a batch is emitted. Batch size follows from the rate. */
  batchIntervalMs?: number;
  blockIntervalMs?: number;
  txPerBlock?: number;
  /** Fraction of each block that was never announced. */
  ghostRatioRange?: readonly [number, number];
  /** Emit an opening pool snapshot, exercising the cold-start path. */
  emitSnapshot?: boolean;
  snapshotSize?: number;
  /**
   * Draw ghost gas from a heavier distribution than the rest of the block.
   *
   * Off by default, and deliberately so: the default generator is the reference
   * every visual constant in this project was calibrated against, and moving it
   * would invalidate those measurements retroactively.
   *
   * It exists because the default is known to be wrong in one direction. It
   * gives private flow the same gas distribution as everything else, whereas
   * mainnet private flow is disproportionately MEV and arbitrage, which are
   * gas-heavy. The default therefore *understates* how far the by-gas ratio
   * diverges from the by-transaction one, and this scenario is how that
   * divergence gets exercised rather than assumed.
   */
  ghostGasBias?: "none" | "mev";
  /**
   * Re-issue every Nth block a moment after it lands, at the same height with
   * different hashes: a one-block reorg. Zero, the default, never does.
   *
   * The replacement withdraws the lowest-paying public rows of the block back
   * into the pool and fills their places with fresh private flow, which is
   * roughly what a competing builder's block looks like next to the first.
   * It exists so the client's reorg path — `lib/blocks.ts` — is exercised by
   * the generator rather than only by hand-built fixtures.
   *
   * Off, this draws nothing from `rand` and the reference sequence is
   * byte-identical. On, every draw after the first replacement shifts, as
   * with the MEV scenario.
   */
  reorgEveryBlocks?: number;
};

/** How long after a block its replacement lands, under `reorgEveryBlocks`. */
export const REORG_DELAY_MS = 1500;

/** Public rows a synthetic replacement withdraws, at most. */
const REORG_WITHDRAWN = 5;

export function createSyntheticSource(
  options: SyntheticOptions = {},
): StreamSource {
  const {
    seed = 0xda4f10,
    txPerSecond = 300,
    batchIntervalMs = 100,
    blockIntervalMs = 12_000,
    txPerBlock = 150,
    ghostRatioRange = [0.1, 0.4],
    emitSnapshot = true,
    snapshotSize = 400,
    ghostGasBias = "none",
    reorgEveryBlocks = 0,
  } = options;

  return (onTx, onBlock) => {
    const rand = mulberry32(seed);
    let blockNumber = 21_000_000;
    let baseFeePerGas = 12 * GWEI;

    /**
     * Hashes announced as pending and not yet included. The block builder draws
     * from here; anything it needs beyond this is minted fresh and is a ghost.
     */
    const announced = new Map<Hex, number>(); // hash -> effective-ish fee
    /** Full transactions, so the block can report the gas each one used. */
    const announcedTx = new Map<Hex, PendingTx>();

    function randomHash(): Hex {
      let hex = "";
      for (let i = 0; i < 8; i++) {
        hex += Math.floor(rand() * 0x100000000)
          .toString(16)
          .padStart(8, "0");
      }
      return `0x${hex}`;
    }

    /** Log-normal around ~1 gwei with a tail into the hundreds. */
    function randomTip(): number {
      return Math.max(0.01 * GWEI, Math.exp(Math.log(GWEI) + gaussian(rand)));
    }

    function randomFees(tip: number): Fees {
      // ~8% legacy, roughly matching mainnet's remaining legacy traffic.
      if (rand() < 0.08) {
        return { kind: "legacy", gasPrice: baseFeePerGas + tip };
      }
      return {
        kind: "eip1559",
        maxPriorityFeePerGas: tip,
        // Cap sits above base + tip, but sometimes tightly, so the effective
        // tip genuinely differs from the advertised one for part of the field.
        maxFeePerGas: baseFeePerGas * (1.1 + rand() * 1.5) + tip,
      };
    }

    /**
     * Gas limit with a mode at 21,000 and a long tail.
     *
     * A plain transfer is exactly 21,000 and is the single most common
     * transaction on the chain; everything else — swaps, mints, aggregator
     * routes — runs from there up to a few hundred thousand. A log-normal tail
     * off that floor reproduces the shape without pretending to model
     * contract semantics.
     */
    function randomGas(): number {
      if (rand() < 0.32) return 21000; // the plain transfer, exactly
      return Math.round(
        Math.min(500_000, 21000 * Math.exp(Math.abs(gaussian(rand)) * 0.95)),
      );
    }

    /**
     * Gas for a transaction that never touched the public mempool, under the
     * MEV scenario.
     *
     * No 21,000 mode: private order flow is not plain transfers. Centred an
     * order of magnitude up, which is what lands roughly 27% of transactions
     * on roughly 45% of the gas.
     *
     * Off the flag this delegates, so the default generator is untouched — but
     * the two scenarios are not the same run with one value swapped, and no
     * test should claim they are. This draw takes two values from `rand`
     * where `randomGas` takes one or three, so every later draw shifts and
     * the per-block ghost ratios differ between the two. Measured, over twenty
     * blocks: 23.6% of transactions against 23.1%. Pinning them together would
     * mean routing the default's ghost gas through a side stream too, which
     * changes the byte-exact output of the reference generator — a worse trade
     * than living with two sequences drawn from the same distribution.
     */
    function randomGhostGas(): number {
      if (ghostGasBias === "none") return randomGas();
      return Math.round(
        Math.min(
          1_000_000,
          Math.max(40_000, 80_000 * Math.exp(gaussian(rand) * 0.55)),
        ),
      );
    }

    function makeTx(now: number): PendingTx {
      const tip = randomTip();
      return {
        hash: randomHash(),
        firstSeen: now,
        gas: randomGas(),
        fees: randomFees(tip),
      };
    }

    /** Tip this transaction would actually pay at the current base fee. */
    function tipOf(tx: PendingTx): number {
      return tx.fees.kind === "legacy"
        ? tx.fees.gasPrice - baseFeePerGas
        : Math.min(
            tx.fees.maxPriorityFeePerGas,
            tx.fees.maxFeePerGas - baseFeePerGas,
          );
    }

    const timers: ReturnType<typeof setInterval>[] = [];
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    let stopped = false;
    let blocksEmitted = 0;

    if (emitSnapshot) {
      const now = Date.now();
      const snapshot: PendingTx[] = [];
      for (let i = 0; i < snapshotSize; i++) {
        // Backdated: these were already in the pool before we connected, which
        // is the whole reason a snapshot exists.
        const tx = makeTx(now - Math.floor(rand() * 90_000));
        snapshot.push(tx);
        announced.set(tx.hash, tipOf(tx));
        announcedTx.set(tx.hash, tx);
      }
      // Deferred so a subscriber that sets up state after calling subscribe()
      // still receives it.
      setTimeout(() => {
        if (!stopped) onTx(snapshot, { snapshot: true });
      }, 0);
    }

    const perBatch = Math.max(
      1,
      Math.round((txPerSecond * batchIntervalMs) / 1000),
    );

    timers.push(
      setInterval(() => {
        const now = Date.now();
        const batch: PendingTx[] = [];
        for (let i = 0; i < perBatch; i++) {
          const tx = makeTx(now);
          batch.push(tx);
          announced.set(tx.hash, tipOf(tx));
          announcedTx.set(tx.hash, tx);
        }
        onTx(batch, { snapshot: false });
      }, batchIntervalMs),
    );

    timers.push(
      setInterval(() => {
        const now = Date.now();
        baseFeePerGas = Math.max(
          GWEI,
          baseFeePerGas * (0.875 + rand() * 0.25), // EIP-1559-ish ±12.5%
        );

        const [lo, hi] = ghostRatioRange;
        const ghostRatio = lo + rand() * (hi - lo);
        const ghostCount = Math.round(txPerBlock * ghostRatio);
        const seenCount = txPerBlock - ghostCount;

        /**
         * Builders take the top of the pool by tip, so draw the seen portion
         * from the highest-paying announced transactions.
         *
         * Recomputed at this block's base fee, not read from the tip cached
         * when the transaction was announced. The base fee moves on the line
         * above, and an EIP-1559 tip is min(maxPriority, maxFee - baseFee) — a
         * clamp, so a base fee move does not shift every tip by the same amount
         * and the cached order is not the order any more. Caught by the block
         * coming out with two adjacent rows 0.18 gwei out of sequence.
         */
        const byTip = [...announced.keys()]
          .map((hash) => {
            const tx = announcedTx.get(hash);
            return [hash, tx ? tipOf(tx) : 0] as [Hex, number];
          })
          .sort((a, b) => b[1] - a[1]);
        const seenHashes = byTip.slice(0, seenCount).map(([hash]) => hash);
        for (const hash of seenHashes) announced.delete(hash);

        /**
         * Ghosts: minted now, never announced. Nothing marks them as special —
         * the consumer has to work it out from its own record.
         *
         * They are given a tip as well, and the consumer never sees it: a
         * BlockEvent carries hashes, gas used and the base fee, and nothing
         * else. The generator needs one anyway, because a row's position in a
         * block is the builder's ordering and a builder orders by what it is
         * paid. Without a tip there is nothing to order a ghost by.
         *
         * Drawn by resampling the tips actually included, not from the whole
         * pool and not uniformly across their range.
         *
         * Not the whole pool: private flow reaches a builder directly and pays
         * for its place, so it belongs among the included set — drawing from
         * the pool would sink most ghosts below every public row and pile them
         * at the foot of every block.
         *
         * Not uniform across the range either, which was the first attempt and
         * measured badly: included tips are the top of a log-normal pool, so
         * they crowd near the low end and reach far at the high end. A uniform
         * draw over [lowest, highest] therefore lands above most of them almost
         * every time. Measured on a live block, 39 ghosts in the top third of
         * the column against 1 in the bottom.
         *
         * Resampling an included tip gives the ghosts the same marginal
         * distribution as the rows they sit among, so they spread through the
         * block in proportion rather than by assertion.
         */
        const included = byTip.slice(0, seenCount);
        const ghosts: [Hex, number][] = [];
        for (let i = 0; i < ghostCount; i++) {
          const tip =
            included.length > 0
              ? included[Math.floor(rand() * included.length)][1]
              : randomTip();
          ghosts.push([randomHash(), tip]);
        }

        /**
         * One order for the whole block, and it is the tip.
         *
         * This used to be a Fisher-Yates shuffle of the two lists, which
         * interleaved the ghosts correctly and destroyed the ordering of
         * everything. The consequence was not local to this file: the block
         * column shares its top, its bottom and its extent with the chamber,
         * whose vertical axis is the priority fee, and next to it the block's
         * vertical axis meant nothing at all. Nothing on screen said so.
         *
         * Ghosts still spread through the block — that is what the draw above
         * is for — but now they spread because of a fee rather than instead of
         * one, and every row's height is the same statement in both columns.
         */
        const ordered = [...included, ...ghosts].sort((a, b) => b[1] - a[1]);
        const hashes = ordered.map(([hash]) => hash);

        // Drop stale announced entries so the generator does not grow forever.
        if (announced.size > 20_000) {
          const excess = announced.size - 20_000;
          let dropped = 0;
          for (const hash of announced.keys()) {
            announced.delete(hash);
            announcedTx.delete(hash);
            if (++dropped >= excess) break;
          }
        }

        // Gas used is observed from the block, so it exists for the ghosts
        // too — they were never announced, but they were certainly executed.
        const gasByHash = new Map<Hex, number>();
        for (const tx of announcedTx.values()) gasByHash.set(tx.hash, tx.gas);
        // A hash the generator never announced is a ghost, and under the MEV
        // scenario its gas comes from the heavier draw.
        const gasUsed = hashes.map(
          (hash) => gasByHash.get(hash) ?? randomGhostGas(),
        );

        const block: BlockEvent = {
          number: blockNumber++,
          timestamp: now,
          baseFeePerGas: Math.round(baseFeePerGas),
          hashes,
          gasUsed,
        };
        globalThis.__darkflowSyntheticTruth = {
          blockNumber: block.number,
          intendedGhosts: ghosts.length,
          intendedSeen: seenHashes.length,
        };
        onBlock(block);
        blocksEmitted += 1;

        if (reorgEveryBlocks > 0 && blocksEmitted % reorgEveryBlocks === 0) {
          // The competing block: the same height, most of the same rows, the
          // cheapest public ones swapped for private flow that was not in the
          // first. Withdrawn rows go back to the pool as announced, which is
          // where an orphaned transaction actually ends up.
          const withdrawn = included.slice(-REORG_WITHDRAWN);
          for (const [hash, tip] of withdrawn) announced.set(hash, tip);
          const kept = included.slice(0, included.length - withdrawn.length);
          const replacementGhosts: [Hex, number][] = [...ghosts];
          for (let i = 0; i < withdrawn.length; i++) {
            const tip =
              included.length > 0
                ? included[Math.floor(rand() * included.length)][1]
                : randomTip();
            replacementGhosts.push([randomHash(), tip]);
          }
          const reordered = [...kept, ...replacementGhosts].sort(
            (a, b) => b[1] - a[1],
          );
          const replacementHashes = reordered.map(([hash]) => hash);
          const replacementGas = replacementHashes.map(
            (hash) => gasByHash.get(hash) ?? randomGhostGas(),
          );
          const replacement: BlockEvent = {
            number: block.number,
            timestamp: now + REORG_DELAY_MS,
            baseFeePerGas: block.baseFeePerGas,
            hashes: replacementHashes,
            gasUsed: replacementGas,
          };
          const truth: SyntheticTruth = {
            blockNumber: replacement.number,
            intendedGhosts: replacementGhosts.length,
            intendedSeen: kept.length,
          };
          timeouts.push(
            setTimeout(() => {
              if (stopped) return;
              globalThis.__darkflowSyntheticTruth = truth;
              onBlock(replacement);
            }, REORG_DELAY_MS),
          );
        }
      }, blockIntervalMs),
    );

    return () => {
      stopped = true;
      for (const timer of timers) clearInterval(timer);
      for (const timeout of timeouts) clearTimeout(timeout);
      timers.length = 0;
      timeouts.length = 0;
    };
  };
}
