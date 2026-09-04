import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createIngestCore, type IngestCore } from "../src/core.ts";
import { createLogger } from "../src/log.ts";
import { clientAddressOf, healthResponse, lastEventIdOf, stateResponse, streamResponse } from "../src/vercel.ts";
import { H, sseReader, startFakeProvider, testConfig, waitFor, type FakeProvider } from "./helpers/fake-provider.ts";

const pendingFixture: Record<string, unknown>[] = JSON.parse(readFileSync(new URL("../fixtures/pending.json", import.meta.url), "utf8"));

const request = (headers: Record<string, string> = {}, signal?: AbortSignal) =>
  new Request("http://site.example/api/stream", { headers, ...(signal ? { signal } : {}) });

describe("request helpers", () => {
  it("takes the address from the platform's forwarded header", () => {
    expect(clientAddressOf(request({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    expect(clientAddressOf(request({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientAddressOf(request())).toBe("unknown");
  });
  it("parses Last-Event-ID or ignores it", () => {
    expect(lastEventIdOf(request({ "last-event-id": "12" }))).toBe(12);
    expect(lastEventIdOf(request({ "last-event-id": "x" }))).toBeNull();
    expect(lastEventIdOf(request())).toBeNull();
  });
});

/**
 * The web-standard adapter against the fake provider:
 * what a Next.js route handler on Vercel returns, read as a page would.
 */
describe("streamResponse", () => {
  let provider: FakeProvider;
  let core: IngestCore;
  afterEach(async () => {
    core?.stop();
    await provider?.stop();
  });

  it("streams frames to a page, replays on Last-Event-ID, caps per address, and closes cleanly at the stream limit", async () => {
    provider = await startFakeProvider();
    core = createIngestCore(testConfig(provider.url, { idleStopMs: 5_000, maxClientsPerIp: 2 }), { log: createLogger(() => {}) });

    // The first request starts the upstream (on demand) and gets the hint.
    const ac = new AbortController();
    const res = streamResponse(core, request({ "x-forwarded-for": "203.0.113.9" }, ac.signal), { streamMaxMs: 0 });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const { next } = sseReader(res);
    await waitFor(() => provider.subscribeCalls.length === 2);
    provider.emitPending(pendingFixture[0]);
    const txs = await next();
    expect(txs.id).toBe(1);
    expect(txs.data).toMatchObject({ v: 1, kind: "txs" });
    provider.emitHead(300);
    const block = await next();
    expect(block.data).toMatchObject({ kind: "block", block: { number: 300 } });

    // A reconnect that saw only the first frame gets the block replayed.
    const again = streamResponse(core, request({ "x-forwarded-for": "203.0.113.9", "last-event-id": "1" }), { streamMaxMs: 0 });
    expect((await sseReader(again).next()).id).toBe(2);

    // Two streams from that address are the limit; a third is 429.
    const third = streamResponse(core, request({ "x-forwarded-for": "203.0.113.9" }), { streamMaxMs: 0 });
    expect(third.status).toBe(429);
    expect(third.headers.get("retry-after")).toBe("30");
    // Another address is fine.
    const other = streamResponse(core, request({ "x-forwarded-for": "198.51.100.4" }), { streamMaxMs: 300 });
    expect(other.status).toBe(200);
    // ...and its stream ends by itself at the limit, with a comment first.
    await sseReader(other).untilEnd(3_000);
    await waitFor(() => (core.state() as { clients: { open: number } }).clients.open === 2);

    // Aborting a request releases its slot.
    ac.abort();
    await waitFor(() => (core.state() as { clients: { open: number } }).clients.open === 1);

    // State and health answer as JSON.
    expect(await stateResponse(core).json()).toMatchObject({ running: true, clients: { replays: { clients: 1, frames: 1 } } });
    expect(healthResponse(core).status).toBe(200);
  }, 15_000);

  it("survives a dropped upstream, fills the gap behind the next head in order, and reports health by both feeds", async () => {
    provider = await startFakeProvider();
    const lines: string[] = [];
    let skew = 0;
    core = createIngestCore(testConfig(provider.url, { idleStopMs: 0 }), { log: createLogger((l) => lines.push(l)), now: () => Date.now() + skew });
    await waitFor(() => provider.subscribeCalls.length === 2);
    const res = streamResponse(core, request({ "x-forwarded-for": "203.0.113.9" }), { streamMaxMs: 0 });
    const { next } = sseReader(res);
    expect(healthResponse(core).status).toBe(503); // nothing received yet

    provider.emitPending(pendingFixture[1]);
    await next();
    provider.emitHead(100);
    expect(((await next()).data as { block: { number: number } }).block.number).toBe(100);
    expect(healthResponse(core).status).toBe(200);

    // The upstream drops: the core reconnects and resubscribes on its own,
    // the page's stream stays open, and the two blocks produced meanwhile
    // are filled in from parent hashes before the new head, in order.
    provider.dropAll();
    await waitFor(() => provider.subscribeCalls.length === 4, 5000);
    expect(lines.some((l) => l.includes("state=reconnecting"))).toBe(true);
    provider.emitHead(103);
    const numbers = [];
    for (let i = 0; i < 3; i++) numbers.push(((await next()).data as { block: { number: number } }).block.number);
    expect(numbers).toEqual([101, 102, 103]);
    expect((core.state() as { blocks: { backfilled: number } }).blocks.backfilled).toBe(2);
    // Coverage measured by the core: none of the scripted rows was pending.
    expect((core.state() as { coverage: { recent: { blocks: number; seen: number } } }).coverage.recent).toMatchObject({ blocks: 4, seen: 0 });

    // Blocks fresh, pending silent past its window: health must say so.
    skew = 31_000;
    provider.emitHead(104);
    await next();
    expect(healthResponse(core).status).toBe(503);
    provider.emitPending(pendingFixture[2]);
    await next();
    expect(healthResponse(core).status).toBe(200);

    // A gap whose parent the provider cannot serve: the walk stops with a
    // counted miss, the head itself is still emitted, nothing is invented.
    provider.unknownHeaders.add(H(105));
    provider.emitHead(106);
    expect(((await next()).data as { block: { number: number } }).block.number).toBe(106);
    const blocks = core.state().blocks as { receiptsMisses: number; backfilled: number };
    expect(blocks.receiptsMisses).toBe(1);
    expect(blocks.backfilled).toBe(2);
  }, 20_000);

  it("refuses when the core is full without starting anything", async () => {
    provider = await startFakeProvider();
    core = createIngestCore(testConfig(provider.url, { idleStopMs: 5_000, maxClients: 0 }), { log: createLogger(() => {}) });
    const res = streamResponse(core, request(), { streamMaxMs: 0 });
    expect(res.status).toBe(503);
    expect(core.running()).toBe(false);
  });
});
