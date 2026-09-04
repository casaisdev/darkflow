/**
 * The block path: head → wait → receipts by hash →
 * frame, with retries, a counted miss when the receipts never come, and the
 * gap behind a head filled in from its parent hashes.
 *
 * Heads are processed **one at a time, in arrival order**. Blocks therefore
 * leave in the order the chain produced them even when one block's receipts
 * take longer than the next block's; the web's ledger reads order as
 * meaning, and a later block overtaking an earlier one would read as a
 * replacement that never happened.
 *
 * A public endpoint can push a head before it has indexed the block's
 * receipts, so the first call waits `delayMs`; each retry doubles it. After
 * `attempts` the block is a miss: **no frame is sent**, because a block frame
 * the chain did not fully describe is the failure the contract exists to
 * prevent.
 *
 * When a head's number is more than one past the last block emitted — after
 * a reconnect, typically — the missing blocks are walked back through
 * `parentHash`, up to `backfillMax` of them, and emitted first. A walk that
 * reaches a block we already emitted stops there; one that cannot fetch a
 * header stops and reports the miss. The web sees a complete chain or an
 * honest gap, never a silent one.
 *
 * Heads that fail validation are rejected at once — there is nothing to
 * retry — and reported as such.
 */
import type { BlockEvent, Hex } from "../../web/types/stream.ts";
import type { RawHead, RawReceipt } from "./source/types.ts";
import { blockEvent } from "./wire/frames.ts";

export type BlockPipelineOptions = {
  fetchReceipts(blockHash: Hex): Promise<RawReceipt[]>;
  fetchHeader(blockHash: Hex): Promise<RawHead>;
  onBlock(block: BlockEvent, meta: { attempts: number; latencyMs: number; backfilled: boolean }): void;
  onMiss(head: { number: number | null; hash: string | null }, reason: string): void;
  onReject(reason: string): void;
  delayMs: number;
  attempts: number;
  backfillMax: number;
  now?: () => number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
};

export type BlockPipeline = {
  onHead(raw: RawHead): void;
  /** Heads waiting or being processed. */
  inFlight(): number;
  /** The last block emitted, if any. */
  last(): { number: number; hash: Hex } | null;
  backfilled(): number;
};

const HASH = /^0x[0-9a-fA-F]{64}$/;

function headHash(raw: RawHead): Hex | null {
  const h = typeof raw.hash === "string" && HASH.test(raw.hash) ? (raw.hash.toLowerCase() as Hex) : null;
  return h;
}

function parentHash(raw: RawHead): Hex | null {
  const h = typeof raw.parentHash === "string" && HASH.test(raw.parentHash) ? (raw.parentHash.toLowerCase() as Hex) : null;
  return h;
}

export function createBlockPipeline(options: BlockPipelineOptions): BlockPipeline {
  const {
    fetchReceipts,
    fetchHeader,
    onBlock,
    onMiss,
    onReject,
    delayMs,
    attempts,
    backfillMax,
    now = Date.now,
    setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
  } = options;

  const queue: { raw: RawHead; hash: Hex; number: number }[] = [];
  let processing = false;
  let last: { number: number; hash: Hex } | null = null;
  let backfilled = 0;

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeoutImpl(resolve, ms));

  /** Receipts with retries. Resolves to the block or to the reason it is a miss. */
  async function build(raw: RawHead, hash: Hex): Promise<{ block: BlockEvent; attempts: number } | { miss: string }> {
    let reason = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await sleep(delayMs * 2 ** (attempt - 1));
      try {
        const receipts = await fetchReceipts(hash);
        const parsed = blockEvent(raw, receipts);
        if (parsed.ok) return { block: parsed.value, attempts: attempt };
        reason = parsed.reason;
      } catch (error) {
        reason = `receipts: ${(error as Error).message}`;
      }
    }
    return { miss: reason };
  }

  /** The headers missing between `last` and this head, oldest first. */
  async function gap(head: { raw: RawHead; number: number }): Promise<{ raw: RawHead; hash: Hex; number: number }[]> {
    if (last === null || backfillMax === 0 || head.number <= last.number + 1) return [];
    const missing: { raw: RawHead; hash: Hex; number: number }[] = [];
    let cursor = parentHash(head.raw);
    let number = head.number - 1;
    while (cursor !== null && number > last.number && missing.length < backfillMax) {
      if (cursor === last.hash) break;
      let raw: RawHead;
      try {
        raw = await fetchHeader(cursor);
      } catch (error) {
        onMiss({ number, hash: cursor }, `header: ${(error as Error).message}`);
        break;
      }
      const probe = blockEvent(raw, []);
      const hash = headHash(raw);
      if (!probe.ok || hash === null || probe.value.number !== number) {
        onMiss({ number, hash: cursor }, probe.ok ? "header-mismatch" : probe.reason);
        break;
      }
      missing.push({ raw, hash, number });
      cursor = parentHash(raw);
      number -= 1;
    }
    return missing.reverse();
  }

  async function emit(item: { raw: RawHead; hash: Hex; number: number }, backfill: boolean): Promise<void> {
    const startedAt = now();
    const built = await build(item.raw, item.hash);
    if ("miss" in built) {
      onMiss({ number: item.number, hash: item.hash }, built.miss);
      return;
    }
    last = { number: item.number, hash: item.hash };
    if (backfill) backfilled += 1;
    onBlock(built.block, { attempts: built.attempts, latencyMs: now() - startedAt, backfilled: backfill });
  }

  async function drain(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const item = queue[0]!;
        const missing = await gap(item);
        for (const m of missing) await emit(m, true);
        await emit(item, false);
        queue.shift();
      }
    } finally {
      processing = false;
    }
  }

  return {
    onHead(raw) {
      // The head itself is validated first, against an empty receipts list:
      // a head that cannot be a block is a rejection, not a retry.
      const probe = blockEvent(raw, []);
      if (!probe.ok) {
        onReject(probe.reason);
        return;
      }
      const hash = headHash(raw);
      if (hash === null) {
        onReject("head-hash");
        return;
      }
      queue.push({ raw, hash, number: probe.value.number });
      void drain();
    },
    inFlight: () => queue.length,
    last: () => last,
    backfilled: () => backfilled,
  };
}
