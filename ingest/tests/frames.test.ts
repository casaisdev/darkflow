import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WIRE_VERSION } from "../../web/types/stream.ts";
import { blockEvent, blockFrame, pendingTx, serialize, txsFrame } from "../src/wire/frames.ts";

/**
 * The fixtures are raw provider messages recorded by scripts/record-fixtures.mjs.
 * These tests parse what the provider actually sent; a hand-written example
 * would only prove the parser agrees with its author.
 */
const dir = new URL("../fixtures/", import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(new URL(name, dir), "utf8"));
const pending: Record<string, unknown>[] = read("pending.json");
const heads: Record<string, unknown>[] = read("heads.json");
const { head: receiptsHead, receipts } = read("receipts.json") as {
  head: Record<string, unknown>;
  receipts: Record<string, unknown>[];
};

const NOW = 1_800_000_000_000;

describe("pending transactions from the recorded feed", () => {
  it("parses every recorded object, and at least one of each fee shape", () => {
    const parsed = pending.map((raw) => pendingTx(raw, NOW, NOW));
    const rejected = parsed.filter((p) => !p.ok);
    expect(rejected, JSON.stringify(rejected.slice(0, 3))).toHaveLength(0);
    const kinds = new Set(parsed.map((p) => (p.ok ? p.value.fees.kind : "rejected")));
    expect(kinds.has("eip1559")).toBe(true);
    // The recording had legacy (type 0x0) transactions; if a future recording
    // has none this assertion tells us the fixture lost a shape, not the code.
    expect(kinds.has("legacy")).toBe(true);
  });

  it("converts quantities to numbers and lowercases hashes", () => {
    const raw = pending.find((p) => p.type === "0x2")!;
    const parsed = pendingTx(raw, NOW, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.hash).toBe(String(raw.hash).toLowerCase());
    expect(parsed.value.gas).toBe(Number(raw.gas));
    expect(parsed.value.fees).toEqual({
      kind: "eip1559",
      maxFeePerGas: Number(raw.maxFeePerGas),
      maxPriorityFeePerGas: Number(raw.maxPriorityFeePerGas),
    });
  });

  it("never stamps firstSeen ahead of the clock", () => {
    const raw = pending[0]!;
    const ahead = pendingTx(raw, NOW + 5_000, NOW);
    const behind = pendingTx(raw, NOW - 5_000, NOW);
    expect(ahead.ok && ahead.value.firstSeen).toBe(NOW);
    expect(behind.ok && behind.value.firstSeen).toBe(NOW - 5_000);
  });

  it("rejects what the contract cannot carry, with a reason", () => {
    const raw = pending[0]!;
    expect(pendingTx(null, NOW, NOW)).toEqual({ ok: false, reason: "not-object" });
    expect(pendingTx({ ...raw, hash: "0x12" }, NOW, NOW)).toEqual({ ok: false, reason: "hash" });
    expect(pendingTx({ ...raw, gas: "0x0" }, NOW, NOW)).toEqual({ ok: false, reason: "gas" });
    expect(pendingTx({ ...raw, gas: 21000 }, NOW, NOW)).toEqual({ ok: false, reason: "gas" });
    const { gasPrice: _g, maxFeePerGas: _m, maxPriorityFeePerGas: _p, ...noFees } = raw;
    expect(pendingTx(noFees, NOW, NOW)).toEqual({ ok: false, reason: "fees" });
    expect(pendingTx(raw, Number.NaN, NOW)).toEqual({ ok: false, reason: "observedAt" });
  });

  it("keeps a contract creation as to: null and drops a malformed sender", () => {
    const raw = { ...pending[0]!, to: null, from: "nonsense" };
    const parsed = pendingTx(raw, NOW, NOW);
    expect(parsed.ok && parsed.value.to).toBeNull();
    expect(parsed.ok && "from" in parsed.value).toBe(false);
  });
});

describe("blocks from a recorded head and its receipts", () => {
  it("builds the block in receipt order with one gasUsed per hash", () => {
    const parsed = blockEvent(receiptsHead, receipts);
    expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
    if (!parsed.ok) return;
    const block = parsed.value;
    expect(block.number).toBe(Number(receiptsHead.number));
    expect(block.timestamp).toBe(Number(receiptsHead.timestamp) * 1000);
    expect(block.baseFeePerGas).toBe(Number(receiptsHead.baseFeePerGas));
    expect(block.hashes).toHaveLength(receipts.length);
    expect(block.gasUsed).toHaveLength(receipts.length);
    expect(block.gasUsed.every((g) => Number.isFinite(g) && g > 0)).toBe(true);
    // Tips: what each row paid above the base fee, from the receipt.
    expect(block.tips).toHaveLength(receipts.length);
    expect(block.tips!.every((t) => Number.isFinite(t) && t >= 0)).toBe(true);
    const r0 = receipts.find((r) => Number(r.transactionIndex) === 0)!;
    expect(block.tips![0]).toBe(Math.max(0, Number(r0.effectiveGasPrice) - Number(receiptsHead.baseFeePerGas)));
    // Receipt order is transactionIndex order, whatever order they arrived in.
    const shuffled = [...receipts].reverse();
    const again = blockEvent(receiptsHead, shuffled);
    expect(again.ok && again.value.hashes).toEqual(block.hashes);
    expect(block.hashes[0]).toBe(String(receipts.find((r) => Number(r.transactionIndex) === 0)!.transactionHash).toLowerCase());
  });

  it("parses every recorded head as a valid (empty) block header", () => {
    for (const head of heads) {
      const parsed = blockEvent(head, []);
      expect(parsed.ok, JSON.stringify(head)).toBe(true);
    }
  });

  it("omits tips entirely when one receipt lacks effectiveGasPrice", () => {
    const partial = receipts.map((r, i) => (i === 1 ? { ...r, effectiveGasPrice: undefined } : r));
    const parsed = blockEvent(receiptsHead, partial);
    expect(parsed.ok && "tips" in parsed.value).toBe(false);
  });

  it("rejects receipts that belong to another block, whole", () => {
    const other = receipts.map((r, i) => (i === 3 ? { ...r, blockHash: "0x" + "ab".repeat(32) } : r));
    expect(blockEvent(receiptsHead, other)).toEqual({ ok: false, reason: "receipt-block-mismatch" });
  });

  it("rejects a gap or a duplicate in the indices", () => {
    const gap = receipts.filter((r) => Number(r.transactionIndex) !== 2);
    expect(blockEvent(receiptsHead, gap)).toEqual({ ok: false, reason: "receipt-indices" });
    const dup = [...receipts, receipts[1]!];
    expect(blockEvent(receiptsHead, dup)).toEqual({ ok: false, reason: "receipt-indices" });
  });

  it("rejects a head the chain could not have produced", () => {
    expect(blockEvent({ ...receiptsHead, number: "12" }, [])).toEqual({ ok: false, reason: "head-number" });
    expect(blockEvent({ ...receiptsHead, hash: "0x1" }, [])).toEqual({ ok: false, reason: "head-hash" });
    expect(blockEvent({ ...receiptsHead, baseFeePerGas: undefined }, [])).toEqual({ ok: false, reason: "head-basefee" });
    expect(blockEvent({ ...receiptsHead, timestamp: "0x0" }, [])).toEqual({ ok: false, reason: "head-timestamp" });
    expect(blockEvent(receiptsHead, "nope")).toEqual({ ok: false, reason: "receipts-not-array" });
    expect(blockEvent(receiptsHead, [{ ...receipts[0]!, gasUsed: 5 }])).toEqual({ ok: false, reason: "receipt-gasused" });
  });
});

describe("frames", () => {
  it("carry the wire version and serialise as one SSE message", () => {
    const tx = pendingTx(pending[0]!, NOW, NOW);
    if (!tx.ok) throw new Error("fixture");
    const frame = txsFrame([tx.value]);
    expect(frame).toMatchObject({ v: WIRE_VERSION, kind: "txs" });
    const text = serialize(frame);
    expect(text.startsWith("data: ")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(true);
    expect(JSON.parse(text.slice(6))).toEqual(frame);
    const block = blockEvent(receiptsHead, receipts);
    if (!block.ok) throw new Error("fixture");
    expect(blockFrame(block.value)).toMatchObject({ v: WIRE_VERSION, kind: "block" });
  });
});
