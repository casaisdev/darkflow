import type { BlockEvent, Fees, Hex, PendingTx } from "../../types/stream";

/**
 * The recording format: a few minutes of mainnet, as the wire would have
 * carried it, on disk.
 *
 * ## Why this exists
 *
 * The ingest does not exist, and the synthetic generator — however carefully
 * shaped — is a claim about what mainnet traffic looks like rather than a
 * sample of it. A recording is the middle ground: real transactions, real
 * blocks, the real fraction of a block this vantage point never heard about,
 * with the one dishonesty being that it is not now. The status dot and the
 * About plate say so.
 *
 * ## Why one module for the capture script and the browser
 *
 * `scripts/capture-replay.mjs` writes this format and `lib/stream/replay.ts`
 * reads it. A format defined twice drifts, and a drift here is invisible in
 * the way this project's failures are always invisible: a field that shifts
 * meaning between writer and reader still parses, still renders, and still
 * looks like a mempool. So there is one definition, imported by both. It has
 * no path aliases and no runtime imports, because Node runs it with its own
 * type stripping and knows nothing of `@/`.
 *
 * ## Time
 *
 * Every time in a recording is **milliseconds since `meta.startedAt`**, the
 * moment capture began. Playback rebases them onto the moment playback begins,
 * so a transaction that was 40 seconds old when its block landed is 40
 * seconds old when its block lands again. Ages are preserved exactly; the
 * only invented quantity is the epoch, and it is invented by a constant.
 *
 * ## Size
 *
 * A transaction is a fixed-shape row rather than an object: at forty to sixty
 * a second over five minutes that is fifteen thousand rows, and a row of six
 * positional values is about a third the size of the same data keyed. The
 * hash is kept whole. Truncating it would save more than everything else
 * combined, and would turn every hash on the inspector into something that
 * cannot be looked up.
 */

export const RECORDING_FORMAT = 1;

export type RecordingMeta = {
  format: typeof RECORDING_FORMAT;
  chainId: number;
  /**
   * Where the pending transactions were heard and where the blocks came from.
   * Public endpoints, by URL, so the vantage point is not anonymous: "never
   * seen by this node" has to be able to say which node.
   */
  sources: { pending: string[]; blocks: string };
  /** ISO 8601, UTC. When capture began. */
  capturedAt: string;
  /** ms since epoch of t = 0. Every offset in `frames` is relative to this. */
  startedAt: number;
  durationMs: number;
  firstBlock: number;
  lastBlock: number;
  counts: { txs: number; blocks: number };
  /**
   * Transactions announced pending and then heard again from another source,
   * as a share of all announced. Not a claim about the chain; a description of
   * how much the vantage points overlap, kept because it is the one thing
   * about the recording that cannot be recomputed from it.
   */
  overlap?: number;
};

/**
 * One pending transaction, positional.
 *
 * `[hash, firstSeen offset ms, gas limit, fee kind, fee A, fee B]` where fee
 * kind 0 is legacy (`A` = gasPrice, `B` = 0) and 1 is EIP-1559 (`A` =
 * maxFeePerGas, `B` = maxPriorityFeePerGas). Wei as numbers: a fee cap of
 * even 10,000 gwei is 1e13, well inside a double's exact range.
 */
export type RecordedTx = [
  hash: Hex,
  firstSeenMs: number,
  gas: number,
  feeKind: 0 | 1,
  feeA: number,
  feeB: number,
];

export type RecordedFrame =
  | { t: number; kind: "txs"; txs: RecordedTx[] }
  | {
      t: number;
      kind: "block";
      number: number;
      /** ms offset, like every other time here. Chain seconds are converted. */
      timestamp: number;
      baseFeePerGas: number;
      hashes: Hex[];
      gasUsed: number[];
      /**
       * wei above the base fee each row paid, from its receipt — the same
       * optional, all-or-nothing field as `BlockEvent.tips`. Recordings made
       * before it existed have none, and play back with ghosts at the floor.
       */
      tips?: number[];
    };

export type Recording = {
  meta: RecordingMeta;
  /** Ascending by `t`. */
  frames: RecordedFrame[];
};

// ---------------------------------------------------------------------------
// Encoding, used by the capture script.

export function encodeTx(tx: PendingTx, startedAt: number): RecordedTx {
  const fees = tx.fees;
  return fees.kind === "legacy"
    ? [tx.hash, tx.firstSeen - startedAt, tx.gas, 0, fees.gasPrice, 0]
    : [
        tx.hash,
        tx.firstSeen - startedAt,
        tx.gas,
        1,
        fees.maxFeePerGas,
        fees.maxPriorityFeePerGas,
      ];
}

export function encodeBlock(
  block: BlockEvent,
  t: number,
  startedAt: number,
): Extract<RecordedFrame, { kind: "block" }> {
  return {
    t,
    kind: "block",
    number: block.number,
    timestamp: block.timestamp - startedAt,
    baseFeePerGas: block.baseFeePerGas,
    hashes: [...block.hashes],
    gasUsed: [...block.gasUsed],
    ...(block.tips ? { tips: [...block.tips] } : {}),
  };
}

// ---------------------------------------------------------------------------
// Decoding, used by playback. `epoch` is what t = 0 means on this clock.

export function decodeTx(row: RecordedTx, epoch: number): PendingTx {
  const [hash, firstSeenMs, gas, feeKind, feeA, feeB] = row;
  const fees: Fees =
    feeKind === 0
      ? { kind: "legacy", gasPrice: feeA }
      : { kind: "eip1559", maxFeePerGas: feeA, maxPriorityFeePerGas: feeB };
  return { hash, firstSeen: epoch + firstSeenMs, gas, fees };
}

export function decodeBlock(
  frame: Extract<RecordedFrame, { kind: "block" }>,
  epoch: number,
): BlockEvent {
  return {
    number: frame.number,
    timestamp: epoch + frame.timestamp,
    baseFeePerGas: frame.baseFeePerGas,
    hashes: frame.hashes,
    gasUsed: frame.gasUsed,
    ...(frame.tips ? { tips: frame.tips } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation. Playback refuses a recording it cannot vouch for, whole.

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const hex = (value: unknown): value is Hex =>
  typeof value === "string" && value.startsWith("0x") && value.length > 2;

function isRecordedTx(value: unknown): value is RecordedTx {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    hex(value[0]) &&
    finite(value[1]) &&
    finite(value[2]) &&
    (value[3] === 0 || value[3] === 1) &&
    finite(value[4]) &&
    finite(value[5])
  );
}

function isRecordedFrame(value: unknown): value is RecordedFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<RecordedFrame> & Record<string, unknown>;
  if (!finite(frame.t)) return false;
  if (frame.kind === "txs") {
    return Array.isArray(frame.txs) && frame.txs.every(isRecordedTx);
  }
  if (frame.kind === "block") {
    return (
      finite(frame.number) &&
      finite(frame.timestamp) &&
      finite(frame.baseFeePerGas) &&
      Array.isArray(frame.hashes) &&
      frame.hashes.every(hex) &&
      Array.isArray(frame.gasUsed) &&
      frame.gasUsed.length === frame.hashes.length &&
      frame.gasUsed.every(finite) &&
      (frame.tips === undefined ||
        (Array.isArray(frame.tips) &&
          frame.tips.length === frame.hashes.length &&
          frame.tips.every(finite)))
    );
  }
  return false;
}

function isRecordingMeta(value: unknown): value is RecordingMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<RecordingMeta>;
  return (
    meta.format === RECORDING_FORMAT &&
    finite(meta.chainId) &&
    typeof meta.sources === "object" &&
    meta.sources !== null &&
    Array.isArray(meta.sources.pending) &&
    meta.sources.pending.every((s) => typeof s === "string") &&
    typeof meta.sources.blocks === "string" &&
    typeof meta.capturedAt === "string" &&
    finite(meta.startedAt) &&
    finite(meta.durationMs) &&
    finite(meta.firstBlock) &&
    finite(meta.lastBlock) &&
    typeof meta.counts === "object" &&
    meta.counts !== null &&
    finite(meta.counts.txs) &&
    finite(meta.counts.blocks)
  );
}

/**
 * Whether this is a recording playback can trust. Frames must be in order:
 * playback schedules each one relative to the last, and a frame from the past
 * would either fire immediately, out of sequence, or be silently skipped.
 */
export function isRecording(value: unknown): value is Recording {
  if (typeof value !== "object" || value === null) return false;
  const recording = value as Partial<Recording>;
  if (!isRecordingMeta(recording.meta)) return false;
  if (!Array.isArray(recording.frames)) return false;
  let last = -Infinity;
  for (const frame of recording.frames) {
    if (!isRecordedFrame(frame)) return false;
    if (frame.t < last) return false;
    last = frame.t;
  }
  return true;
}

// ---------------------------------------------------------------------------
// From the node's JSON-RPC shapes. Used by the capture script; tested here.

/** Quantity as the node sends it: 0x-prefixed hex, or already a number. */
export function quantity(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
  const n = Number.parseInt(value, 16);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * A pending transaction from `eth_getTransactionByHash` or a full-body
 * `newPendingTransactions` notification, or `null` if it is not one we can
 * carry: a value field we do not keep, a fee shape we do not know.
 *
 * Type 0 and 1 carry `gasPrice`; 2, 3 and 4 carry the EIP-1559 pair. Some
 * nodes echo `gasPrice` on 1559 transactions as well; the type decides.
 */
export function txFromRpc(rpc: unknown, firstSeen: number): PendingTx | null {
  if (typeof rpc !== "object" || rpc === null) return null;
  const tx = rpc as Record<string, unknown>;
  if (!hex(tx.hash)) return null;
  const gas = quantity(tx.gas);
  if (gas === null) return null;
  const type = quantity(tx.type) ?? 0;

  let fees: Fees;
  if (type >= 2) {
    const maxFeePerGas = quantity(tx.maxFeePerGas);
    const maxPriorityFeePerGas = quantity(tx.maxPriorityFeePerGas);
    if (maxFeePerGas === null || maxPriorityFeePerGas === null) return null;
    fees = { kind: "eip1559", maxFeePerGas, maxPriorityFeePerGas };
  } else {
    const gasPrice = quantity(tx.gasPrice);
    if (gasPrice === null) return null;
    fees = { kind: "legacy", gasPrice };
  }

  const out: PendingTx = { hash: tx.hash, firstSeen, gas, fees };
  if (hex(tx.from)) out.from = tx.from;
  if (tx.to === null) out.to = null;
  else if (hex(tx.to)) out.to = tx.to;
  return out;
}

/**
 * A block from `eth_getBlockByHash(hash, false)` plus `eth_getBlockReceipts`.
 *
 * Gas used is matched by hash, not by position, and the block is refused if
 * any transaction lacks a receipt: `gasUsed` must have one entry per hash,
 * and a zero standing in for "receipt missing" would draw that row as
 * nothing, which is precisely the encoding this project refuses.
 */
export function blockFromRpc(block: unknown, receipts: unknown): BlockEvent | null {
  if (typeof block !== "object" || block === null) return null;
  const b = block as Record<string, unknown>;
  const number = quantity(b.number);
  const timestampS = quantity(b.timestamp);
  const baseFeePerGas = quantity(b.baseFeePerGas);
  if (number === null || timestampS === null || baseFeePerGas === null) return null;
  if (!Array.isArray(b.transactions) || !b.transactions.every(hex)) return null;
  if (!Array.isArray(receipts)) return null;

  const gasByHash = new Map<Hex, number>();
  // What each row paid above the base fee, from the receipt's effective
  // price. All or nothing, like the wire field: a receipt without it drops
  // the tips for the whole block rather than placing half of it.
  const tipByHash = new Map<Hex, number>();
  let tipsComplete = true;
  for (const receipt of receipts) {
    if (typeof receipt !== "object" || receipt === null) return null;
    const r = receipt as Record<string, unknown>;
    const used = quantity(r.gasUsed);
    if (!hex(r.transactionHash) || used === null) return null;
    gasByHash.set(r.transactionHash, used);
    const paid = quantity(r.effectiveGasPrice);
    if (paid === null) tipsComplete = false;
    else tipByHash.set(r.transactionHash, Math.max(0, paid - baseFeePerGas));
  }

  const hashes = b.transactions as Hex[];
  const gasUsed: number[] = [];
  const tips: number[] = [];
  for (const hash of hashes) {
    const used = gasByHash.get(hash);
    if (used === undefined) return null;
    gasUsed.push(used);
    const tip = tipByHash.get(hash);
    if (tip === undefined) tipsComplete = false;
    else tips.push(tip);
  }
  return {
    number,
    timestamp: timestampS * 1000,
    baseFeePerGas,
    hashes,
    gasUsed,
    ...(tipsComplete ? { tips } : {}),
  };
}
