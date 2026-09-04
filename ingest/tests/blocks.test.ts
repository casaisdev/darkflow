import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlockPipeline, type BlockPipelineOptions } from "../src/blocks.ts";

const { head, receipts } = JSON.parse(readFileSync(new URL("../fixtures/receipts.json", import.meta.url), "utf8"));

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
/** A scripted chain: block n has hash H(n) and parent H(n-1). */
const chainHead = (n: number) => ({ ...head, number: `0x${n.toString(16)}`, hash: H(n), parentHash: H(n - 1) });
const chainReceipts = (n: number) => receipts.map((r: Record<string, unknown>) => ({ ...r, blockHash: H(n) }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function pipeline(overrides: Partial<BlockPipelineOptions> = {}) {
  const calls: string[] = [];
  const headers: string[] = [];
  const blocks: number[] = [];
  const misses: string[] = [];
  const rejects: string[] = [];
  const p = createBlockPipeline({
    fetchReceipts: async (hash) => {
      calls.push(hash);
      return chainReceipts(Number.parseInt(hash.slice(-4), 16));
    },
    fetchHeader: async (hash) => {
      headers.push(hash);
      return chainHead(Number.parseInt(hash.slice(-4), 16));
    },
    onBlock: (b) => blocks.push(b.number),
    onMiss: (_h, reason) => misses.push(reason),
    onReject: (r) => rejects.push(r),
    delayMs: 100,
    attempts: 3,
    backfillMax: 10,
    ...overrides,
  });
  return { p, calls, headers, blocks, misses, rejects };
}

describe("block pipeline", () => {
  it("waits, fetches receipts by the head's hash, and emits one block", async () => {
    const t = pipeline();
    t.p.onHead(chainHead(100));
    expect(t.p.inFlight()).toBe(1);
    await run(99);
    expect(t.calls).toEqual([]);
    await run(1);
    expect(t.calls).toEqual([H(100)]);
    expect(t.blocks).toEqual([100]);
    expect(t.p.inFlight()).toBe(0);
    expect(t.p.last()).toEqual({ number: 100, hash: H(100) });
  });

  it("retries with doubling delays and then counts a miss, sending nothing", async () => {
    let calls = 0;
    const t = pipeline({
      fetchReceipts: async () => {
        calls += 1;
        throw new Error("not indexed");
      },
    });
    t.p.onHead(chainHead(100));
    await run(100); // attempt 1
    await run(200); // attempt 2
    expect(calls).toBe(2);
    expect(t.misses).toEqual([]);
    await run(400); // attempt 3
    expect(calls).toBe(3);
    expect(t.misses).toEqual(["receipts: not indexed"]);
    expect(t.blocks).toEqual([]);
    expect(t.p.inFlight()).toBe(0);
    expect(t.p.last()).toBeNull();
  });

  it("retries when the receipts describe a different block, and succeeds when they match", async () => {
    let n = 0;
    const t = pipeline({
      fetchReceipts: async () => (n++ === 0 ? chainReceipts(999) : chainReceipts(100)),
      attempts: 2,
    });
    t.p.onHead(chainHead(100));
    await run(100);
    expect(t.blocks).toEqual([]);
    await run(200);
    expect(t.blocks).toEqual([100]);
  });

  it("rejects an invalid head at once, without a receipts call", async () => {
    const t = pipeline();
    t.p.onHead({ ...chainHead(100), hash: "0x12" });
    await run(1000);
    expect(t.rejects).toEqual(["head-hash"]);
    expect(t.calls).toEqual([]);
    expect(t.p.inFlight()).toBe(0);
  });

  it("emits blocks in arrival order even when an earlier one's receipts are slow", async () => {
    let first = true;
    const t = pipeline({
      fetchReceipts: async (hash) => {
        const n = Number.parseInt(hash.slice(-4), 16);
        if (n === 100 && first) {
          first = false;
          throw new Error("slow");
        }
        return chainReceipts(n);
      },
    });
    t.p.onHead(chainHead(100));
    t.p.onHead(chainHead(101));
    expect(t.p.inFlight()).toBe(2);
    await run(100); // 100 fails once
    await run(200); // 100 succeeds on retry
    await run(100); // then 101
    expect(t.blocks).toEqual([100, 101]);
    expect(t.p.inFlight()).toBe(0);
  });

  it("fills a gap behind a head from parent hashes, oldest first, and stops at a block already emitted", async () => {
    const t = pipeline();
    t.p.onHead(chainHead(100));
    await run(100);
    t.p.onHead(chainHead(104));
    await run(100 * 4);
    expect(t.headers).toEqual([H(103), H(102), H(101)]);
    expect(t.blocks).toEqual([100, 101, 102, 103, 104]);
    expect(t.p.backfilled()).toBe(3);
  });

  it("caps the walk at backfillMax and treats a replacement head as a normal block", async () => {
    const t = pipeline({ backfillMax: 2 });
    t.p.onHead(chainHead(100));
    await run(100);
    t.p.onHead(chainHead(110));
    await run(100 * 3);
    expect(t.blocks).toEqual([100, 108, 109, 110]);
    // A different block at the same height: emitted as-is; the web judges it.
    t.p.onHead({ ...chainHead(110), hash: H(9110), parentHash: H(109) });
    await run(100);
    expect(t.blocks.at(-1)).toBe(110);
    expect(t.p.last()!.hash).toBe(H(9110));
  });

  it("stops the walk with a counted miss when a header cannot be fetched, and still emits the head", async () => {
    const t = pipeline({
      fetchHeader: async (hash) => {
        if (hash === H(102)) throw new Error("unknown block");
        return chainHead(Number.parseInt(hash.slice(-4), 16));
      },
    });
    t.p.onHead(chainHead(100));
    await run(100);
    t.p.onHead(chainHead(104));
    await run(100 * 3);
    // 103 was fetched, 102 was not: the walk stops there; nothing is invented for 101 and 102.
    expect(t.blocks).toEqual([100, 103, 104]);
    expect(t.misses).toEqual(["header: unknown block"]);
  });

  it("does not walk when the parent is the last emitted block or backfill is off", async () => {
    const t = pipeline({ backfillMax: 0 });
    t.p.onHead(chainHead(100));
    await run(100);
    t.p.onHead(chainHead(105));
    await run(100);
    expect(t.headers).toEqual([]);
    expect(t.blocks).toEqual([100, 105]);
  });
});
