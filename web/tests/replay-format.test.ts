import { describe, expect, it } from "vitest";
import {
  RECORDING_FORMAT,
  blockFromRpc,
  decodeBlock,
  decodeTx,
  encodeBlock,
  encodeTx,
  isRecording,
  quantity,
  txFromRpc,
  type RecordedFrame,
  type Recording,
} from "@/lib/replay/format";
import type { BlockEvent, PendingTx } from "@/types/stream";
import { eip1559, hashOf, legacy, resetHashes } from "./helpers";

/**
 * The recording format, at both ends.
 *
 * One module writes it from the node's JSON-RPC shapes and reads it back into
 * the wire types, so the tests here are the round trip and the two
 * conversions. A field that survives encode→decode with a different meaning
 * is the failure mode: it would still render as a mempool.
 */

const STARTED = 1_700_000_000_000;

const meta = (): Recording["meta"] => ({
  format: RECORDING_FORMAT,
  chainId: 1,
  sources: { pending: ["wss://a.example", "wss://b.example"], blocks: "wss://b.example" },
  capturedAt: new Date(STARTED).toISOString(),
  startedAt: STARTED,
  durationMs: 300_000,
  firstBlock: 21_000_000,
  lastBlock: 21_000_024,
  counts: { txs: 2, blocks: 1 },
});

describe("round trip", () => {
  it("carries a transaction through a row and back, with age intact", () => {
    resetHashes();
    const tx: PendingTx = {
      hash: hashOf(1),
      firstSeen: STARTED + 12_345,
      gas: 21000,
      fees: eip1559(2, 30),
    };
    const row = encodeTx(tx, STARTED);
    expect(row).toEqual([hashOf(1), 12_345, 21000, 1, 30e9, 2e9]);
    // Rebased onto a different epoch: the offset is what survives.
    const epoch = STARTED + 1_000_000;
    expect(decodeTx(row, epoch)).toEqual({ ...tx, firstSeen: epoch + 12_345 });
  });

  it("keeps the legacy fee shape distinct", () => {
    const tx: PendingTx = { hash: hashOf(2), firstSeen: STARTED, gas: 50_000, fees: legacy(15) };
    const row = encodeTx(tx, STARTED);
    expect(row[3]).toBe(0);
    expect(row[4]).toBe(15e9);
    expect(decodeTx(row, STARTED).fees).toEqual({ kind: "legacy", gasPrice: 15e9 });
  });

  it("carries a block with its timestamp as an offset", () => {
    const block: BlockEvent = {
      number: 21_000_000,
      timestamp: STARTED + 8000,
      baseFeePerGas: 12e9,
      hashes: [hashOf(1), hashOf(2)],
      gasUsed: [21000, 120_000],
    };
    const frame = encodeBlock(block, 8100, STARTED);
    expect(frame.t).toBe(8100);
    expect(frame.timestamp).toBe(8000);
    expect(decodeBlock(frame, STARTED + 5)).toEqual({ ...block, timestamp: STARTED + 5 + 8000 });
  });
});

describe("validation", () => {
  const good = (): Recording => ({
    meta: meta(),
    frames: [
      { t: 100, kind: "txs", txs: [[hashOf(1), 40, 21000, 1, 30e9, 2e9]] },
      {
        t: 12_000,
        kind: "block",
        number: 21_000_000,
        timestamp: 11_900,
        baseFeePerGas: 12e9,
        hashes: [hashOf(1)],
        gasUsed: [21000],
      },
    ],
  });

  it("accepts a well-formed recording", () => {
    expect(isRecording(good())).toBe(true);
  });

  it("refuses another format version", () => {
    const r = good();
    (r.meta as { format: number }).format = RECORDING_FORMAT + 1;
    expect(isRecording(r)).toBe(false);
  });

  it("refuses frames out of order", () => {
    const r = good();
    r.frames.reverse();
    // Playback schedules each frame after the last; a frame from the past
    // would fire at once and out of sequence.
    expect(isRecording(r)).toBe(false);
  });

  it("refuses a row with the wrong arity or a non-finite fee", () => {
    const r = good();
    (r.frames[0] as { txs: unknown[] }).txs = [[hashOf(1), 40, 21000, 1, 30e9]];
    expect(isRecording(r)).toBe(false);
    const s = good();
    (s.frames[0] as { txs: unknown[] }).txs = [[hashOf(1), 40, 21000, 1, NaN, 2e9]];
    expect(isRecording(s)).toBe(false);
  });

  it("refuses a block whose gas array does not match its hashes", () => {
    const r = good();
    (r.frames[1] as Extract<RecordedFrame, { kind: "block" }>).gasUsed = [];
    expect(isRecording(r)).toBe(false);
  });

  it("refuses a meta without its sources", () => {
    const r = good();
    (r.meta as { sources: unknown }).sources = { pending: [] };
    expect(isRecording(r)).toBe(false);
  });
});

describe("from the node", () => {
  it("parses quantities and refuses what is not one", () => {
    expect(quantity("0x5208")).toBe(21000);
    expect(quantity("0x0")).toBe(0);
    expect(quantity(7)).toBe(7);
    expect(quantity("5208")).toBeNull();
    expect(quantity("0x")).toBeNull();
    expect(quantity(null)).toBeNull();
    // Past 2^53: a value in wei this large cannot be a fee, and a wrong
    // number is worse than none.
    expect(quantity("0xffffffffffffffffff")).toBeNull();
  });

  it("reads an EIP-1559 transaction by its type, ignoring an echoed gasPrice", () => {
    const tx = txFromRpc(
      {
        hash: hashOf(3),
        type: "0x2",
        gas: "0x5208",
        gasPrice: "0x3b9aca00", // some nodes echo it; the type decides
        maxFeePerGas: "0x6fc23ac00",
        maxPriorityFeePerGas: "0x77359400",
        from: "0xabc",
        to: null,
      },
      STARTED,
    );
    expect(tx).toEqual({
      hash: hashOf(3),
      firstSeen: STARTED,
      gas: 21000,
      fees: { kind: "eip1559", maxFeePerGas: 30e9, maxPriorityFeePerGas: 2e9 },
      from: "0xabc",
      to: null,
    });
  });

  it("reads a legacy transaction, and a type-1 one as legacy", () => {
    const t0 = txFromRpc({ hash: hashOf(4), gas: "0x5208", gasPrice: "0x37e11d600" }, STARTED);
    expect(t0?.fees).toEqual({ kind: "legacy", gasPrice: 15e9 });
    const t1 = txFromRpc({ hash: hashOf(5), type: "0x1", gas: "0x5208", gasPrice: "0x37e11d600" }, STARTED);
    expect(t1?.fees).toEqual({ kind: "legacy", gasPrice: 15e9 });
  });

  it("refuses a transaction missing what the instrument draws", () => {
    expect(txFromRpc({ hash: hashOf(6), type: "0x2", gas: "0x5208" }, STARTED)).toBeNull();
    expect(txFromRpc({ hash: hashOf(7), gasPrice: "0x1" }, STARTED)).toBeNull();
    expect(txFromRpc({ type: "0x2", gas: "0x5208" }, STARTED)).toBeNull();
    expect(txFromRpc(null, STARTED)).toBeNull();
  });

  it("matches receipts to hashes by hash, not by position", () => {
    const block = {
      number: "0x1406f40",
      timestamp: "0x65432100",
      baseFeePerGas: "0x2cb417800",
      transactions: [hashOf(1), hashOf(2), hashOf(3)],
    };
    const receipts = [
      { transactionHash: hashOf(3), gasUsed: "0x3" },
      { transactionHash: hashOf(1), gasUsed: "0x1" },
      { transactionHash: hashOf(2), gasUsed: "0x2" },
    ];
    expect(blockFromRpc(block, receipts)).toEqual({
      number: 21_000_000,
      timestamp: 0x65432100 * 1000,
      baseFeePerGas: 12e9,
      hashes: [hashOf(1), hashOf(2), hashOf(3)],
      gasUsed: [1, 2, 3],
    });
  });

  it("refuses a block with a receipt missing rather than sizing that row at zero", () => {
    const block = {
      number: "0x1",
      timestamp: "0x1",
      baseFeePerGas: "0x1",
      transactions: [hashOf(1), hashOf(2)],
    };
    expect(blockFromRpc(block, [{ transactionHash: hashOf(1), gasUsed: "0x1" }])).toBeNull();
    expect(blockFromRpc(block, "not receipts")).toBeNull();
    expect(blockFromRpc({ ...block, baseFeePerGas: undefined }, [])).toBeNull();
  });
});

describe("tips, the optional column the wire grew after the first recording", () => {
  const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
  const rpcBlock = {
    number: "0x1406f40",
    timestamp: "0x6553f100",
    baseFeePerGas: "0x2540be400", // 10 gwei
    transactions: [H(1), H(2)],
  };
  const receipt = (hash: string, effectiveGasPrice?: string) => ({
    transactionHash: hash,
    gasUsed: "0x5208",
    ...(effectiveGasPrice ? { effectiveGasPrice } : {}),
  });

  it("reads each row's tip from its receipt, matched by hash, floored at zero", () => {
    const block = blockFromRpc(rpcBlock, [
      receipt(H(2), "0x2540be400"), // paid exactly the base fee: tip 0
      receipt(H(1), "0x2e90edd00"), // 12.5 gwei: tip 2.5 gwei
    ]);
    expect(block?.tips).toEqual([2.5e9, 0]);
  });

  it("drops the whole tips column when any receipt lacks the price, never half of it", () => {
    const block = blockFromRpc(rpcBlock, [receipt(H(1), "0x2e90edd00"), receipt(H(2))]);
    expect(block).not.toBeNull();
    expect(block && "tips" in block).toBe(false);
  });

  it("carries tips through encode and decode, and their absence too", () => {
    const withTips: BlockEvent = {
      number: 21_000_000,
      timestamp: STARTED + 8000,
      baseFeePerGas: 12e9,
      hashes: [hashOf(1), hashOf(2)],
      gasUsed: [21000, 120_000],
      tips: [1e9, 0],
    };
    expect(decodeBlock(encodeBlock(withTips, 8100, STARTED), STARTED).tips).toEqual([1e9, 0]);
    const without: BlockEvent = { ...withTips };
    delete without.tips;
    const frame = encodeBlock(without, 8100, STARTED);
    expect("tips" in frame).toBe(false);
    expect("tips" in decodeBlock(frame, STARTED)).toBe(false);
  });

  it("refuses a recording whose tips column is not whole", () => {
    const block: RecordedFrame = {
      t: 8100,
      kind: "block",
      number: 21_000_000,
      timestamp: 8000,
      baseFeePerGas: 12e9,
      hashes: [hashOf(1), hashOf(2)],
      gasUsed: [21000, 120_000],
      tips: [1e9],
    };
    const recording: Recording = { meta: meta(), frames: [block] };
    expect(isRecording(recording)).toBe(false);
    expect(isRecording({ meta: meta(), frames: [{ ...block, tips: [1e9, 0] }] })).toBe(true);
    expect(isRecording({ meta: meta(), frames: [{ ...block, tips: [1e9, "0"] }] })).toBe(false);
  });
});
