import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSseSource } from "@/lib/stream/sse";
import type { LinkState, SourceInfo } from "@/types/stream";
import { readout } from "@/lib/readout";
import { createSeenSet } from "@/lib/seen";
import { createWorld } from "@/lib/canvas/world";
import { STALE_AFTER_S } from "@/components/Instrument";
import { BLOCK_STALE_AFTER_S } from "@/lib/readout";
import { applyBlock } from "@/lib/canvas/world";
import { WIRE_VERSION, type BlockEvent, type PendingTx } from "@/types/stream";
import { eip1559, hashOf, resetHashes } from "./helpers";

/**
 * The SSE client, and what the page does when the stream stops.
 *
 * ## What is under test, and what is not
 *
 * `createSseSource` is thin on purpose: reconnection is delegated to
 * `EventSource`, which already retries on the server's `retry:` interval, and
 * SSE frame assembly — `data:` lines, blank-line terminators — happens inside
 * the browser before `onmessage` ever fires. Our surface is exactly three
 * things: what we do with `event.data`, whether we get out of the browser's way
 * on error, and whether teardown is complete.
 *
 * Node 24 exposes no global `EventSource`, and adding one is a runtime
 * dependency this project does not take. So the double below implements the
 * slice of the interface the client touches. **This is not a test of
 * reconnection** — reconnection is the browser's, and asserting it against a
 * double would only be asserting the double. What it does test is that the
 * client cannot defeat it, which is the part we can actually get wrong.
 *
 * The last group is the one that matters most, and it needs no socket at all:
 * a stream that dies must present as an honest absence of signal rather than
 * as a page still showing the last block as though it were current.
 */

type Handler<E> = ((event: E) => void) | null;

/** The slice of the EventSource interface `createSseSource` touches. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onmessage: Handler<MessageEvent<string>> = null;
  onerror: Handler<Event> = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  /**
   * One server frame, already assembled by the browser.
   *
   * An object frame is stamped with the wire version unless the test supplies
   * one, so every fixture below is a frame a conforming ingest would send and
   * the version check is exercised only where a test means to.
   */
  emit(payload: unknown) {
    const stamped =
      payload !== null &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      !("v" in payload)
        ? { v: WIRE_VERSION, ...payload }
        : payload;
    this.onmessage?.({
      data: typeof stamped === "string" ? stamped : JSON.stringify(stamped),
    } as MessageEvent<string>);
  }

  onopen: Handler<Event> = null;
  readyState = 1; // OPEN

  /** The connection drops. EventSource fires `error` and retries on its own. */
  cut() {
    this.readyState = 0; // CONNECTING, while the browser retries
    this.onerror?.(new Event("error"));
  }

  /** The browser's retry succeeded. */
  reopen() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
}

function txOf(n: number): PendingTx {
  return {
    hash: hashOf(n),
    firstSeen: 1_700_000_000_000,
    gas: 21000,
    fees: eip1559(2, 30),
  };
}

function blockOf(number: number): BlockEvent {
  return {
    number,
    timestamp: 1_700_000_000_000,
    baseFeePerGas: 12e9,
    hashes: [hashOf(900), hashOf(901)],
    gasUsed: [21000, 50_000],
  };
}

function connect(url = "https://ingest.example/stream") {
  const batches: { txs: readonly PendingTx[]; snapshot: boolean }[] = [];
  const blocks: BlockEvent[] = [];
  const links: LinkState[] = [];
  const described: SourceInfo[] = [];
  const failures: string[] = [];
  const stop = createSseSource(url)(
    (txs, meta) => batches.push({ txs, snapshot: meta.snapshot }),
    (block) => blocks.push(block),
    {
      onLink: (state) => links.push(state),
      onDescribe: (info) => described.push(info),
      onFailure: (reason) => failures.push(reason),
    },
  );
  const source = FakeEventSource.instances.at(-1);
  return { batches, blocks, links, described, failures, stop, source: source! };
}

beforeEach(() => {
  resetHashes();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SSE client", () => {
  describe("frames", () => {
    it("delivers a batch of transactions as a batch", () => {
      const { batches, source } = connect();
      source.emit({ kind: "txs", txs: [txOf(1), txOf(2), txOf(3)] });
      expect(batches).toHaveLength(1);
      // One callback per frame, never one per transaction: at a few hundred
      // tx/s the second shape is thousands of dispatches a second.
      expect(batches[0].txs).toHaveLength(3);
      expect(batches[0].snapshot).toBe(false);
    });

    it("marks the opening snapshot as a snapshot", () => {
      const { batches, source } = connect();
      source.emit({ kind: "snapshot", txs: [txOf(1)] });
      // The consumer seeds its seen-set from this and ends calibration early.
      // Delivered as an ordinary batch it would close nothing, and the cold
      // start would run its full five blocks for no reason.
      expect(batches[0].snapshot).toBe(true);
    });

    it("delivers blocks", () => {
      const { blocks, source } = connect();
      source.emit({ kind: "block", block: blockOf(21_000_000) });
      expect(blocks).toHaveLength(1);
      expect(blocks[0].gasUsed).toEqual([21000, 50_000]);
    });

    it("drops a malformed frame without stopping the stream", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { batches, blocks, source } = connect();
      source.emit("{ not json");
      source.emit({ kind: "txs" }); // no txs array
      source.emit({ kind: "wat", txs: [] });
      source.emit({ kind: "block", block: { number: 1 } }); // incomplete
      source.emit(null);
      source.emit([1, 2, 3]);
      // A bad frame must never be able to kill the feed: the ingest will ship
      // a bug one day and the page has to survive it.
      expect(batches).toHaveLength(0);
      expect(blocks).toHaveLength(0);
      source.emit({ kind: "txs", txs: [txOf(1)] });
      expect(batches).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    });

    it("rejects a block missing the gas array's siblings", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { blocks, source } = connect();
      source.emit({
        kind: "block",
        block: { number: 1, timestamp: 2, baseFeePerGas: 3 }, // no hashes
      });
      expect(blocks).toHaveLength(0);
      warn.mockRestore();
    });

    it("takes tips only as a whole array, one finite number per hash", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { blocks, source } = connect();
      const block = blockOf(21_000_000);
      // One short, wrong type, not finite: each drops the whole block, as
      // gasUsed does — half a block placed from data is the thing to avoid.
      source.emit({ kind: "block", block: { ...block, tips: [1e9] } });
      source.emit({ kind: "block", block: { ...block, tips: ["1", "2"] } });
      source.emit({ kind: "block", block: { ...block, tips: [1e9, NaN] } });
      expect(blocks).toHaveLength(0);
      // Whole, or absent: both are blocks.
      source.emit({ kind: "block", block: { ...block, tips: [1e9, 0] } });
      source.emit({ kind: "block", block });
      expect(blocks).toHaveLength(2);
      expect(blocks[0].tips).toEqual([1e9, 0]);
      expect(blocks[1].tips).toBeUndefined();
      warn.mockRestore();
    });

    it("rejects a block whose gas array does not match its hashes, whole", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { blocks, source } = connect();
      const block = blockOf(21_000_000);
      // One short. `applyBlock` would size the last row from `undefined`,
      // which is a row of no width: private flow rendered as nothing.
      source.emit({ kind: "block", block: { ...block, gasUsed: [21000] } });
      // Absent altogether — the shape an ingest that skipped the receipts
      // would send.
      source.emit({ kind: "block", block: { ...block, gasUsed: undefined } });
      // Present, wrong type.
      source.emit({
        kind: "block",
        block: { ...block, gasUsed: ["21000", "50000"] },
      });
      source.emit({ kind: "block", block: { ...block, gasUsed: [21000, NaN] } });
      expect(blocks).toHaveLength(0);
      source.emit({ kind: "block", block });
      expect(blocks).toHaveLength(1);
      warn.mockRestore();
    });

    it("rejects a block with a non-hex hash or a non-finite number", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { blocks, source } = connect();
      const block = blockOf(21_000_000);
      source.emit({
        kind: "block",
        block: { ...block, hashes: [hashOf(1), "deadbeef"] },
      });
      source.emit({ kind: "block", block: { ...block, number: "21000000" } });
      source.emit({ kind: "block", block: { ...block, baseFeePerGas: null } });
      expect(blocks).toHaveLength(0);
      warn.mockRestore();
    });

    it("drops malformed transactions from a batch and keeps the rest", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { batches, source } = connect();
      source.emit({
        kind: "txs",
        txs: [
          txOf(1),
          { ...txOf(2), hash: undefined }, // would key the record on "undefined"
          { ...txOf(3), fees: { kind: "eip1559" } }, // NaN into the fee window
          { ...txOf(4), firstSeen: "1700000000000" }, // a string age
          { ...txOf(5), gas: Infinity },
          txOf(6),
          "not a transaction",
        ],
      });
      expect(batches).toHaveLength(1);
      expect(batches[0].txs.map((tx) => tx.hash)).toEqual([hashOf(1), hashOf(6)]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("5 malformed");
      warn.mockRestore();
    });

    it("drops a batch in which nothing survived, rather than delivering a quiet pool", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { batches, source } = connect();
      source.emit({ kind: "txs", txs: [{ hash: 1 }, { hash: 2 }] });
      expect(batches).toHaveLength(0);
      // An honestly empty batch is still delivered: a quiet pool is data, and
      // the frame is evidence the stream is alive.
      source.emit({ kind: "txs", txs: [] });
      expect(batches).toHaveLength(1);
      expect(batches[0].txs).toHaveLength(0);
      warn.mockRestore();
    });

    it("accepts a legacy fee shape and rejects an unknown one", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { batches, source } = connect();
      source.emit({
        kind: "txs",
        txs: [
          { ...txOf(1), fees: { kind: "legacy", gasPrice: 15e9 } },
          { ...txOf(2), fees: { kind: "eip4844", maxFeePerGas: 1 } },
        ],
      });
      expect(batches[0].txs).toHaveLength(1);
      expect(batches[0].txs[0].fees.kind).toBe("legacy");
      warn.mockRestore();
    });
  });

  describe("the wire version", () => {
    it("drops frames from another version and says so once", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { batches, blocks, source } = connect();
      source.emit({ v: WIRE_VERSION + 1, kind: "txs", txs: [txOf(1)] });
      source.emit({ v: WIRE_VERSION + 1, kind: "block", block: blockOf(1) });
      source.emit({ v: undefined, kind: "txs", txs: [txOf(2)] });
      // The names all match. A future version could carry `firstSeen` in
      // seconds under the same key, and every frame would parse into a field
      // that never fades. Refusing is the only safe reading of a version we
      // do not know.
      expect(batches).toHaveLength(0);
      expect(blocks).toHaveLength(0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(`speaks ${WIRE_VERSION}`);
      // The current version still flows.
      source.emit({ kind: "txs", txs: [txOf(3)] });
      expect(batches).toHaveLength(1);
      warn.mockRestore();
    });
  });

  describe("staying out of the browser's way", () => {
    it("does not close the connection when it errors", () => {
      const { links, source } = connect();
      // An error handler is attached now — to observe, never to act.
      // EventSource retries on its own, with the server's `retry:` interval;
      // closing here would replace a working reconnect with none at all, and
      // the page would go dark for the rest of the session on one dropped
      // packet. What the handler does is tell the page, so the dot can say
      // "reconnecting" instead of "live" over nothing.
      source.cut();
      expect(source.closed).toBe(false);
      expect(links).toEqual(["reconnecting"]);
      source.reopen();
      expect(links).toEqual(["reconnecting", "open"]);
    });

    it("keeps delivering after the connection comes back", () => {
      const { batches, source } = connect();
      source.emit({ kind: "txs", txs: [txOf(1)] });
      source.cut();
      // Same EventSource instance: the browser reconnects underneath it.
      source.emit({ kind: "txs", txs: [txOf(2)] });
      expect(batches).toHaveLength(2);
    });

    it("opens exactly one connection", () => {
      connect();
      expect(FakeEventSource.instances).toHaveLength(1);
    });

    it("refuses to connect to an empty URL, loudly — and tells the page", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const failures: string[] = [];
      const stop = createSseSource("")(
        () => {},
        () => {},
        { onFailure: (reason) => failures.push(reason) },
      );
      expect(FakeEventSource.instances).toHaveLength(0);
      expect(error).toHaveBeenCalled();
      // The console is for whoever built this; the hook is for the reader.
      // Without it the status said "connecting" forever over a source that
      // was never going to.
      expect(failures).toHaveLength(1);
      expect(() => stop()).not.toThrow();
      error.mockRestore();
    });

    it("says what it is, once, before anything flows", () => {
      const { described } = connect();
      // Provenance is out of band by design: a recording's frames are
      // indistinguishable from a live node's. A live source is the only kind
      // that is "now", and the chrome must not infer that from silence.
      expect(described).toEqual([{ kind: "live" }]);
    });
  });

  describe("teardown", () => {
    it("closes and detaches, so a Strict Mode remount does not double the feed", () => {
      const { batches, links, stop, source } = connect();
      stop();
      expect(source.closed).toBe(true);
      expect(source.onmessage).toBeNull();
      expect(source.onerror).toBeNull();
      // And the link is reported closed, so no dot goes on saying
      // "reconnecting" about a socket that no longer exists.
      expect(links.at(-1)).toBe("closed");
      // Development remounts the effect once. A source still delivering after
      // teardown shows twice the traffic, and every rate on the panel is wrong.
      source.emit({ kind: "txs", txs: [txOf(1)] });
      expect(batches).toHaveLength(0);
    });
  });

  describe("a clock ahead of ours", () => {
    it("says so rather than letting the field silently stop fading", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { batches, source } = connect();
      const future = Date.now() + 60_000;
      source.emit({ kind: "txs", txs: [{ ...txOf(1), firstSeen: future }] });
      // `ageOf` clamps a future timestamp to zero, and zero age is full
      // brightness for ever — indistinguishable from a fresh arrival, with
      // nothing on screen to reveal it. Same family as the NaN alpha.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("clock is ahead");
      // Warned, not dropped: the transaction is real and refusing it would
      // turn a cosmetic fault into a missing one.
      expect(batches).toHaveLength(1);
      warn.mockRestore();
    });

    it("tolerates ordinary disagreement between two machines", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { source } = connect();
      source.emit({
        kind: "txs",
        txs: [{ ...txOf(2), firstSeen: Date.now() + 500 }],
      });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});

describe("what the page says when the stream stops", () => {
  /**
   * The assertion that matters most, and it needs no socket.
   *
   * A dead feed must not leave the page showing the last block as if it were
   * current. There is no event for "the stream died" — EventSource retries
   * silently forever — so the only honest signal is elapsed silence, which is
   * why `readout` reports it rather than trusting a status channel.
   */
  const NOW = 1_700_000_000_000;

  function stateAfterSilence(seconds: number) {
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const seen = createSeenSet();
    seen.seedFromSnapshot([]);
    return readout({
      world,
      seen,
      ticks: [],
      recentRatios: [],
    axisSamples: 4096,
  axisBounds: { low: 1e8, high: 1e11 },
  view: { width: 1440, height: 900 },
      lastBlockAt: NOW,
      lastEventAt: NOW,
      subscribed: true,
      budgetReduced: false,
      now: NOW + seconds * 1000,
    });
  }

  it("reports silence as elapsed seconds, without a bound", () => {
    expect(stateAfterSilence(0).staleSeconds).toBe(0);
    expect(stateAfterSilence(90).staleSeconds).toBe(90);
    // Unbounded on purpose: a counter that stopped at some ceiling would make
    // a stream dead for an hour look the same as one dead for a minute.
    expect(stateAfterSilence(86_400).staleSeconds).toBe(86_400);
  });

  it("stays quiet through a normal gap between blocks", () => {
    // Twelve seconds of silence is a block interval, not a failure. A shorter
    // threshold would put the page into NO SIGNAL between every block.
    expect(STALE_AFTER_S).toBeGreaterThan(12);
    expect(stateAfterSilence(12).staleSeconds! > STALE_AFTER_S).toBe(false);
    expect(stateAfterSilence(24).staleSeconds! > STALE_AFTER_S).toBe(false);
  });

  it("crosses into no-signal past the threshold", () => {
    expect(stateAfterSilence(26).staleSeconds! > STALE_AFTER_S).toBe(true);
    expect(STALE_AFTER_S).toBe(25);
  });

  it("keeps the elapsed-since-block counter running, so old numbers are dated", () => {
    // The block figures on the panel are still the last ones received, and
    // they should be: they were true when they arrived. What makes that honest
    // rather than a frozen page pretending to be live is that this number
    // keeps climbing beside them.
    const state = stateAfterSilence(300);
    expect(state.sinceBlockSeconds).toBe(300);
    expect(state.sinceBlockSeconds).toBeGreaterThan(STALE_AFTER_S);
  });

  it("stops calling the block readings current once the block is old", () => {
    /**
     * A live stream is not a current block.
     *
     * `staleSeconds` watches the stream; this watches the block. They diverge:
     * transactions can arrive every hundred milliseconds while no block has
     * landed for minutes, and before this the primary percentage, the height,
     * the transaction count and the base fee were all presented as now.
     */
    const fresh = stateAfterSilence(0);
    expect(fresh.blockReadingsCurrent).toBe(true);
    // One missed slot is ordinary and must not trip it.
    expect(stateAfterSilence(24).blockReadingsCurrent).toBe(true);
    expect(BLOCK_STALE_AFTER_S).toBe(36);
    expect(stateAfterSilence(BLOCK_STALE_AFTER_S).blockReadingsCurrent).toBe(
      true,
    );
    expect(stateAfterSilence(37).blockReadingsCurrent).toBe(false);
  });

  it("marks the block stale while the stream itself is perfectly alive", () => {
    // The exact production shape: the feed is delivering, the block feed is
    // not. Nothing about `staleSeconds` can catch this.
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const seen = createSeenSet();
    seen.seedFromSnapshot([]);
    const state = readout({
      world,
      seen,
      ticks: [],
      recentRatios: [],
      axisSamples: 4096,
      axisBounds: { low: 1e8, high: 1e11 },
  view: { width: 1440, height: 900 },
      lastBlockAt: NOW - 240_000,
      lastEventAt: NOW - 80, // a batch arrived 80ms ago
      subscribed: true,
      budgetReduced: false,
      now: NOW,
    });
    expect(state.staleSeconds).toBeLessThan(1);
    expect(state.blockReadingsCurrent).toBe(false);
    expect(state.sinceBlockSeconds).toBe(240);
  });

  it("keeps showing the stale reading rather than blanking it", () => {
    // It was a true measurement when it arrived. Hiding it loses information;
    // what it must not do is claim to be about now.
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const seen = createSeenSet();
    seen.seedFromSnapshot([]);
    const hashes = [hashOf(1), hashOf(2), hashOf(3), hashOf(4)];
    applyBlock(
      world,
      {
        number: 21_000_000,
        timestamp: NOW,
        baseFeePerGas: 12e9,
        hashes,
        gasUsed: hashes.map(() => 50_000),
      },
      hashes.map((hash, index) => ({
        hash,
        index,
        origin: index === 0 ? ("ghost" as const) : ("seen" as const),
        record:
          index === 0
            ? undefined
            : { firstSeen: NOW, fees: eip1559(2, 30), gas: 50_000 },
        gasUsed: 50_000,
      })),
      () => 0.5,
    );
    const state = readout({
      world,
      seen,
      ticks: [],
      recentRatios: [],
      axisSamples: 4096,
      axisBounds: { low: 1e8, high: 1e11 },
  view: { width: 1440, height: 900 },
      lastBlockAt: NOW - 300_000,
      lastEventAt: NOW,
      subscribed: true,
      budgetReduced: false,
      now: NOW,
    });
    expect(state.blockReadingsCurrent).toBe(false);
    expect(state.blockNumber).toBe(21_000_000);
    expect(state.ghostRatio).toBeCloseTo(0.25, 10);
    expect(state.baseFeeGwei).toBe(12);
  });

  it("calls a deliberately paused stream null, not dead", () => {
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    const seen = createSeenSet();
    // A hidden tab drops the subscription on purpose — there is no loop to
    // feed. Reporting that as a dead stream told anyone glancing back at a tab
    // that the app had failed when it had simply been waiting for them.
    const paused = readout({
      world,
      seen,
      ticks: [],
      recentRatios: [],
    axisSamples: 4096,
  axisBounds: { low: 1e8, high: 1e11 },
  view: { width: 1440, height: 900 },
      lastBlockAt: NOW,
      lastEventAt: NOW,
      subscribed: false,
      budgetReduced: false,
      now: NOW + 600_000,
    });
    expect(paused.staleSeconds).toBeNull();
  });
});
