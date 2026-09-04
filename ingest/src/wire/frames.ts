/**
 * Raw provider objects → the wire contract, or a typed rejection. Pure.
 *
 * This is where "valid" is decided, once. A rejection carries a short, stable
 * reason so `/state` can count them by shape and a human can see a provider
 * change its dialect. Nothing here guesses: a field that
 * is not what the contract needs makes the entry — or the whole block —
 * a rejection, never a partial value.
 */
import {
  WIRE_VERSION,
  type BlockEvent,
  type Fees,
  type Hex,
  type PendingTx,
  type StreamEvent,
} from "../../../web/types/stream.ts";

export type Rejection = { ok: false; reason: string };
export type Parsed<T> = { ok: true; value: T } | Rejection;

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY = /^0x[0-9a-fA-F]+$/;

const reject = (reason: string): Rejection => ({ ok: false, reason });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A JSON-RPC quantity ("0x1a") as a finite number. */
function quantity(v: unknown): number | null {
  if (typeof v !== "string" || !QUANTITY.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A quantity that must survive as an exact integer (block numbers, indices). */
function exactInteger(v: unknown): number | null {
  const n = quantity(v);
  return n !== null && Number.isSafeInteger(n) ? n : null;
}

function hash(v: unknown): Hex | null {
  return typeof v === "string" && HASH.test(v) ? (v.toLowerCase() as Hex) : null;
}

function address(v: unknown): Hex | null {
  return typeof v === "string" && ADDRESS.test(v) ? (v.toLowerCase() as Hex) : null;
}

function fees(raw: Record<string, unknown>): Fees | null {
  const maxFee = raw.maxFeePerGas;
  const maxPriority = raw.maxPriorityFeePerGas;
  if (maxFee !== undefined && maxFee !== null && maxPriority !== undefined && maxPriority !== null) {
    const maxFeePerGas = quantity(maxFee);
    const maxPriorityFeePerGas = quantity(maxPriority);
    if (maxFeePerGas === null || maxPriorityFeePerGas === null) return null;
    return { kind: "eip1559", maxFeePerGas, maxPriorityFeePerGas };
  }
  const gasPrice = quantity(raw.gasPrice);
  if (gasPrice === null) return null;
  return { kind: "legacy", gasPrice };
}

/**
 * One announced transaction. `observedAt` is when this process saw it;
 * `now` is the clock it is clamped against, so a host clock ahead of the
 * viewers cannot send a mark that never fades (contract: `firstSeen`).
 */
export function pendingTx(raw: unknown, observedAt: number, now: number): Parsed<PendingTx> {
  if (!isRecord(raw)) return reject("not-object");
  const h = hash(raw.hash);
  if (h === null) return reject("hash");
  const gas = quantity(raw.gas);
  if (gas === null || gas <= 0) return reject("gas");
  const f = fees(raw);
  if (f === null) return reject("fees");
  if (!Number.isFinite(observedAt) || !Number.isFinite(now)) return reject("observedAt");

  const tx: PendingTx = { hash: h, firstSeen: Math.min(observedAt, now), gas, fees: f };
  const from = address(raw.from);
  if (from !== null) tx.from = from;
  if (raw.to === null) tx.to = null;
  else {
    const to = address(raw.to);
    if (to !== null) tx.to = to;
  }
  return { ok: true, value: tx };
}

/**
 * One landed block, from its head and its receipts. Rejected whole on any
 * inconsistency: the contract drops half-described blocks, and so does this,
 * one step earlier and with a reason.
 */
export function blockEvent(head: unknown, receipts: unknown): Parsed<BlockEvent> {
  if (!isRecord(head)) return reject("head-not-object");
  const number = exactInteger(head.number);
  if (number === null) return reject("head-number");
  const blockHash = hash(head.hash);
  if (blockHash === null) return reject("head-hash");
  const baseFeePerGas = quantity(head.baseFeePerGas);
  if (baseFeePerGas === null) return reject("head-basefee");
  const timestampS = exactInteger(head.timestamp);
  if (timestampS === null || timestampS <= 0) return reject("head-timestamp");

  if (!Array.isArray(receipts)) return reject("receipts-not-array");
  const rows: { index: number; hash: Hex; gasUsed: number; tip: number | null }[] = [];
  for (const r of receipts) {
    if (!isRecord(r)) return reject("receipt-not-object");
    const rh = hash(r.transactionHash);
    if (rh === null) return reject("receipt-hash");
    const index = exactInteger(r.transactionIndex);
    if (index === null) return reject("receipt-index");
    const gasUsed = quantity(r.gasUsed);
    if (gasUsed === null) return reject("receipt-gasused");
    const rb = hash(r.blockHash);
    if (rb !== blockHash) return reject("receipt-block-mismatch");
    // What this row paid above the base fee: the tip, for every row, private
    // flow included — the one place that figure exists for a ghost.
    const paid = quantity(r.effectiveGasPrice);
    const tip = paid === null ? null : Math.max(0, paid - baseFeePerGas);
    rows.push({ index, hash: rh, gasUsed, tip });
  }
  rows.sort((a, b) => a.index - b.index);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.index !== i) return reject("receipt-indices");
  }

  const block: BlockEvent = {
    number,
    timestamp: timestampS * 1000,
    baseFeePerGas,
    hashes: rows.map((r) => r.hash),
    gasUsed: rows.map((r) => r.gasUsed),
  };
  // Tips are all or nothing: a partial array would let the consumer size half
  // a block's heights from data and the other half from a default.
  if (rows.every((r) => r.tip !== null)) block.tips = rows.map((r) => r.tip!);
  return { ok: true, value: block };
}

export function txsFrame(txs: PendingTx[]): StreamEvent {
  return { v: WIRE_VERSION, kind: "txs", txs };
}

export function blockFrame(block: BlockEvent): StreamEvent {
  return { v: WIRE_VERSION, kind: "block", block };
}

/** One SSE message. The web's `EventSource` reads the default event only. */
export function serialize(event: StreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
