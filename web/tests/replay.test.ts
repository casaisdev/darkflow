import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPLAY_TAIL_MS, createReplaySource } from "@/lib/stream/replay";
import { RECORDING_FORMAT, type Recording } from "@/lib/replay/format";
import type {
  BlockEvent,
  PendingTx,
  SourceControls,
  SourceInfo,
  SourceProgress,
} from "@/types/stream";
import { hashOf, resetHashes } from "./helpers";

/**
 * Playback of a recording: cadence, rebasing, ending, refusal.
 *
 * The failure this guards is the quiet one: a recording that plays with every
 * age shifted, or a frame skipped, or a loop that reads as a reorg, still
 * looks like a mempool. So the assertions are about time and count, against
 * fake timers, with the fetch stubbed to return a fixture built here.
 */

const CAPTURED = 1_700_000_000_000;

function recording(overrides: Partial<Recording["meta"]> = {}): Recording {
  resetHashes();
  return {
    meta: {
      format: RECORDING_FORMAT,
      chainId: 1,
      sources: { pending: ["wss://a.example"], blocks: "wss://a.example" },
      capturedAt: new Date(CAPTURED).toISOString(),
      startedAt: CAPTURED,
      durationMs: 1000,
      firstBlock: 21_000_000,
      lastBlock: 21_000_000,
      counts: { txs: 3, blocks: 1 },
      ...overrides,
    },
    frames: [
      { t: 100, kind: "txs", txs: [[hashOf(1), 40, 21000, 1, 30e9, 2e9], [hashOf(2), 90, 21000, 0, 15e9, 0]] },
      { t: 300, kind: "txs", txs: [[hashOf(3), 250, 50_000, 1, 30e9, 1e9]] },
      {
        t: 700,
        kind: "block",
        number: 21_000_000,
        timestamp: 650,
        baseFeePerGas: 12e9,
        hashes: [hashOf(1), hashOf(9)],
        gasUsed: [21000, 80_000],
      },
    ],
  };
}

function fetchOf(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({ ok, status: ok ? 200 : 404, json: async () => body }) as Response) as typeof fetch;
}

function start(fetchImpl: typeof fetch, url = "/replay/test.json") {
  const batches: PendingTx[][] = [];
  const blocks: BlockEvent[] = [];
  const described: SourceInfo[] = [];
  let ended = 0;
  const stop = createReplaySource(url, { fetchImpl })(
    (txs) => batches.push([...txs]),
    (block) => blocks.push(block),
    { onDescribe: (info) => described.push(info), onEnd: () => (ended += 1) },
  );
  return { batches, blocks, described, ended: () => ended, stop };
}

/** Lets the stubbed fetch resolve. Two microtask hops: response, then json. */
const settle = async () => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => vi.useFakeTimers({ now: 2_000_000_000_000 }));
afterEach(() => vi.useRealTimers());

describe("replay", () => {
  it("plays frames at their recorded offsets, batches intact", async () => {
    const r = start(fetchOf(recording()));
    await settle();
    expect(r.batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(99);
    expect(r.batches).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.batches).toHaveLength(1);
    expect(r.batches[0]).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(r.batches).toHaveLength(2);
    expect(r.blocks).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(r.blocks).toHaveLength(1);
    r.stop();
  });

  it("rebases every time onto the moment playback began, preserving ages", async () => {
    const r = start(fetchOf(recording()));
    await settle();
    const epoch = Date.now();
    await vi.advanceTimersByTimeAsync(700);
    // firstSeen offsets 40 and 90 from the recording's start become the same
    // offsets from playback's start: a transaction that was 610ms old when
    // its block landed is 610ms old when it lands again.
    expect(r.batches[0].map((tx) => tx.firstSeen)).toEqual([epoch + 40, epoch + 90]);
    expect(r.blocks[0].timestamp).toBe(epoch + 650);
    expect(r.blocks[0].timestamp - r.batches[0][0].firstSeen).toBe(610);
    // And nothing from the recording's own era leaks through.
    for (const tx of r.batches.flat()) expect(tx.firstSeen).toBeGreaterThan(CAPTURED + 1e9);
    r.stop();
  });

  it("decodes fee shapes and gas faithfully", async () => {
    const r = start(fetchOf(recording()));
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.batches[0][0].fees).toEqual({ kind: "eip1559", maxFeePerGas: 30e9, maxPriorityFeePerGas: 2e9 });
    expect(r.batches[0][1].fees).toEqual({ kind: "legacy", gasPrice: 15e9 });
    expect(r.batches[0][1].gas).toBe(21000);
    r.stop();
  });

  it("describes the recording once it has loaded, before any frame", async () => {
    const r = start(fetchOf(recording({ lastBlock: 21_000_024, durationMs: 300_000 })));
    expect(r.described).toHaveLength(0);
    await settle();
    expect(r.described).toEqual([
      {
        kind: "recording",
        chainId: 1,
        capturedAt: new Date(CAPTURED).toISOString(),
        durationMs: 300_000,
        firstBlock: 21_000_000,
        lastBlock: 21_000_024,
        sources: { pending: ["wss://a.example"], blocks: "wss://a.example" },
        txs: 3,
        blocks: 1,
      },
    ]);
    expect(r.batches).toHaveLength(0);
    r.stop();
  });

  it("delivers a late frame rather than skipping it", async () => {
    const r = start(fetchOf(recording()));
    await settle();
    // The main thread was busy: the clock jumps past three frames at once.
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.batches).toHaveLength(2);
    expect(r.blocks).toHaveLength(1);
    r.stop();
  });

  it("reports its end once, after the last frame and a pause — never a loop", async () => {
    const r = start(fetchOf(recording()));
    await settle();
    await vi.advanceTimersByTimeAsync(700);
    expect(r.ended()).toBe(0);
    await vi.advanceTimersByTimeAsync(REPLAY_TAIL_MS - 1);
    expect(r.ended()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(r.ended()).toBe(1);
    // Looping here would send block 21,000,000 again into a ledger whose
    // head is 21,000,000: a reorg that never happened. Nothing more arrives.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.ended()).toBe(1);
    expect(r.blocks).toHaveLength(1);
    r.stop();
  });

  it("stops completely when unsubscribed, before or during playback", async () => {
    const early = start(fetchOf(recording()));
    early.stop();
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(early.batches).toHaveLength(0);
    expect(early.described).toHaveLength(0);

    const mid = start(fetchOf(recording()));
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(mid.batches).toHaveLength(1);
    mid.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(mid.batches).toHaveLength(1);
    expect(mid.blocks).toHaveLength(0);
    expect(mid.ended()).toBe(0);
  });

  it("refuses a recording it cannot vouch for, loudly, and plays nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = recording();
    bad.frames.reverse();
    const r = start(fetchOf(bad));
    await settle();
    await vi.advanceTimersByTimeAsync(5000);
    expect(r.batches).toHaveLength(0);
    expect(r.blocks).toHaveLength(0);
    expect(r.described).toHaveLength(0);
    expect(r.ended()).toBe(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("refusing");
    error.mockRestore();
  });

  it("says so when the recording cannot be fetched", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = start(fetchOf(null, false));
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.batches).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("HTTP 404");
    error.mockRestore();
  });

  it("refuses an empty URL without touching the network", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const stop = createReplaySource("", { fetchImpl })(() => {}, () => {});
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    expect(() => stop()).not.toThrow();
    error.mockRestore();
  });
});

describe("driving a recording", () => {
  /** A consumer clock that can be stopped, as Viz's is. */
  function stoppableClock() {
    let frozenAt: number | null = null;
    let lost = 0;
    return {
      now: () => (frozenAt ?? Date.now()) - lost,
      pause: () => {
        frozenAt = Date.now();
      },
      resume: () => {
        if (frozenAt !== null) lost += Date.now() - frozenAt;
        frozenAt = null;
      },
    };
  }

  function drive(
    fetchImpl: typeof fetch,
    extra: Partial<Parameters<ReturnType<typeof createReplaySource>>[2] & object> = {},
  ) {
    const batches: PendingTx[][] = [];
    const blocks: BlockEvent[] = [];
    let controls: SourceControls | null = null;
    let ended = 0;
    const progress: SourceProgress[] = [];
    const failures: string[] = [];
    const clock = stoppableClock();
    const stop = createReplaySource("/replay/test.json", { fetchImpl })(
      (txs) => batches.push([...txs]),
      (block) => blocks.push(block),
      {
        now: clock.now,
        onControls: (c) => (controls = c),
        onEnd: () => (ended += 1),
        onProgress: (p) => progress.push(p),
        onFailure: (reason) => failures.push(reason),
        ...extra,
      },
    );
    return { batches, blocks, controls: () => controls as SourceControls | null, ended: () => ended, progress, failures, clock, stop };
  }

  it("offers controls once loaded, and a live-shaped test never sees them before", async () => {
    const r = drive(fetchOf(recording()));
    expect(r.controls()).toBeNull();
    await settle();
    expect(r.controls()).not.toBeNull();
    expect(r.controls()!.paused()).toBe(false);
    expect(r.controls()!.rate()).toBe(1);
    r.stop();
  });

  it("delivers nothing while paused and picks up where it left, ages intact", async () => {
    const r = drive(fetchOf(recording()));
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(r.batches).toHaveLength(1);
    const firstSeenBefore = r.batches[0][0].firstSeen;
    const ageBefore = r.clock.now() - firstSeenBefore;

    r.controls()!.pause();
    r.clock.pause();
    // Nothing left armed: a paused source owns no timer, so it cannot wake
    // itself and it costs nothing while it waits.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(r.batches).toHaveLength(1);
    expect(r.blocks).toHaveLength(0);
    // The consumer's clock stood still, so the mark did not age.
    expect(r.clock.now() - firstSeenBefore).toBe(ageBefore);

    r.clock.resume();
    r.controls()!.resume();
    // 200ms more of recording: the second batch (t=300) is due, the block
    // (t=700) is not.
    await vi.advanceTimersByTimeAsync(200);
    expect(r.batches).toHaveLength(2);
    expect(r.blocks).toHaveLength(0);
    // The second batch's age on the consumer clock is what it was in the
    // recording: announced 50ms before this instant (offset 250 at t=300).
    expect(r.clock.now() - r.batches[1][0].firstSeen).toBeCloseTo(50, 0);
    await vi.advanceTimersByTimeAsync(400);
    expect(r.blocks).toHaveLength(1);
    r.stop();
  });

  it("runs faster at a higher rate, with ages compressed by the same factor", async () => {
    const r = drive(fetchOf(recording()));
    await settle();
    r.controls()!.setRate(6);
    // Everything up to the block (t=700) arrives within 700/6 ≈ 117ms.
    await vi.advanceTimersByTimeAsync(120);
    expect(r.blocks).toHaveLength(1);
    // The block's own timestamp sits 50 recorded ms before its frame; at ×6
    // that is about 8 consumer ms — against 50 at real pace. Fake timers
    // round each hop, so the bound is loose but the factor is not.
    const at = r.clock.now();
    expect(at - r.blocks[0].timestamp).toBeGreaterThan(5);
    expect(at - r.blocks[0].timestamp).toBeLessThan(20);
    r.stop();
  });

  it("jumps to the next block, delivering everything in between in order", async () => {
    const r = drive(fetchOf(recording()));
    await settle();
    expect(r.batches).toHaveLength(0);
    r.controls()!.nextBlock();
    expect(r.batches).toHaveLength(2);
    expect(r.blocks).toHaveLength(1);
    // Rebased as if the time had passed: the first batch's rows are older
    // than the block by exactly their recorded distance.
    expect(r.blocks[0].timestamp - r.batches[0][0].firstSeen).toBe(650 - 40);
    // Nothing more to jump to: a no-op, not an error and not a loop.
    r.controls()!.nextBlock();
    expect(r.blocks).toHaveLength(1);
    r.stop();
  });

  it("jumping while paused resumes, so the block is seen to land", async () => {
    const r = drive(fetchOf(recording()));
    await settle();
    r.controls()!.pause();
    r.controls()!.nextBlock();
    expect(r.controls()!.paused()).toBe(false);
    expect(r.blocks).toHaveLength(1);
    r.stop();
  });

  it("opens at a deep-linked block with everything before it delivered at once", async () => {
    const r = drive(fetchOf(recording()), { startAtBlock: 21_000_000 });
    await settle();
    expect(r.blocks).toHaveLength(1);
    expect(r.batches).toHaveLength(2);
    // And an unknown block is ignored: the recording plays from the top.
    const s = drive(fetchOf(recording()), { startAtBlock: 1 });
    await settle();
    expect(s.blocks).toHaveLength(0);
    r.stop();
    s.stop();
  });

  it("reports progress while loading and failure when it cannot", async () => {
    const body = new TextEncoder().encode(JSON.stringify(recording()));
    const streamingFetch = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === "content-length" ? String(body.byteLength) : null) },
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: async () =>
                sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: body }),
            };
          },
        },
      }) as unknown as Response) as typeof fetch;
    const r = drive(streamingFetch);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.progress.length).toBeGreaterThanOrEqual(2);
    expect(r.progress.at(-1)).toEqual({ loaded: body.byteLength, total: body.byteLength });
    expect(r.failures).toHaveLength(0);
    r.stop();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = drive(fetchOf(null, false));
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.failures).toEqual(["HTTP 404"]);
    f.stop();
    error.mockRestore();
  });
});
