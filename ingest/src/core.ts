/**
 * The ingest without its transport: sources →
 * pool, batch, blocks, coverage, hub, with the lifecycle that makes it run on
 * demand. `vercel.ts` puts a transport on it: a web-standard `Response` for
 * the web's route handlers on Vercel. The only module with timers.
 *
 * Lifecycle. With `idleStopMs > 0` the upstream is subscribed when the first
 * client arrives and dropped that long after the last one leaves: nothing
 * runs while nobody is looking, which is what a site with one visitor a
 * month should cost. With `idleStopMs = 0` it is always on, which is what a
 * feed that must be warm before the first visitor needs. Counters and
 * coverage survive an idle stop; the pool is pruned by age as usual.
 */
import type { PendingTx } from "../../web/types/stream.ts";
import type { CoreConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { createPool } from "./pool.ts";
import { createHub, type AddResult, type Client } from "./hub.ts";
import { createBatch } from "./wire/batch.ts";
import { blockFrame, pendingTx, serialize, txsFrame } from "./wire/frames.ts";
import { createBlockPipeline } from "./blocks.ts";
import { createCoverage } from "./coverage.ts";
import { createProviderSource } from "./source/provider.ts";
import type { LinkState, Source } from "./source/types.ts";

export type IngestCore = {
  admission(ip: string): "ok" | "full" | "ip-limit";
  /** Admits a client and starts the upstream if it was idle. */
  addClient(client: Client, now: number, options: { ip: string; lastEventId?: number | null }): AddResult;
  removeClient(client: Client): void;
  state(): Record<string, unknown>;
  healthy(): boolean;
  /** Whether the upstream is subscribed right now. */
  running(): boolean;
  /** Drops the upstream and the timers. Idempotent; `addClient` restarts. */
  stop(): void;
  config: CoreConfig;
};

export type CoreDeps = {
  log: Logger;
  now?: () => number;
  /** Test seam: builds a source for a URL list and the feeds it should carry. */
  createSource?: (urls: string[], feeds: { pending: boolean; heads: boolean }) => Source;
};

type Link = { state: LinkState; detail: string; since: number };

export function createIngestCore(config: CoreConfig, deps: CoreDeps): IngestCore {
  const { log, now = Date.now } = deps;
  const createSource =
    deps.createSource ??
    ((urls, feeds) => createProviderSource({ urls, ...feeds, now, reconnectMinMs: config.reconnectMinMs }));

  const createdAt = now();
  const pool = createPool({ ttlMs: config.poolTtlMs, max: config.poolMax });
  const batch = createBatch<PendingTx>({ max: config.maxBatchTxs });
  const hub = createHub({
    keepaliveMs: config.keepaliveMs,
    stallMs: config.clientStallMs,
    maxClients: config.maxClients,
    maxClientsPerIp: config.maxClientsPerIp,
    replayMs: config.replayMs,
  });
  const coverage = createCoverage();

  // One connection carries both feeds unless the blocks have their own.
  const split = config.blocksUrls !== null;

  // Counters for /state. Every drop in the process lands in one of these.
  const counters = {
    pendingSeen: 0,
    pendingDuplicates: 0,
    pendingRejected: new Map<string, number>(),
    headsSeen: 0,
    headsRejected: new Map<string, number>(),
    blocksSent: 0,
    receiptsMisses: 0,
    batchDrops: 0,
    txFramesSent: 0,
    starts: 0,
    idleStops: 0,
  };
  const idle: Link = { state: "closed", detail: "idle", since: createdAt };
  const links: { pending: Link; blocks: Link } = { pending: idle, blocks: idle };
  let lastPendingAt: number | null = null;
  let lastHeadAt: number | null = null;
  let lastBlock: { number: number; rows: number; at: number } | null = null;
  let startedAt: number | null = null;
  let lastClientLeftAt: number | null = null;

  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const record = (map: Map<string, number>) => Object.fromEntries([...map.entries()].sort());

  // The sources exist for the life of a subscription only.
  let pendingSource: Source | null = null;
  let blockSource: Source | null = null;
  let stops: (() => void)[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  const blocks = createBlockPipeline({
    fetchReceipts: (hash) => {
      if (!blockSource) return Promise.reject(new Error("idle"));
      return blockSource.blockReceipts(hash);
    },
    fetchHeader: (hash) => {
      if (!blockSource) return Promise.reject(new Error("idle"));
      return blockSource.blockHeader(hash);
    },
    delayMs: config.receiptsDelayMs,
    attempts: config.receiptsAttempts,
    backfillMax: config.backfillMax,
    now,
    onBlock(block, meta) {
      const t = now();
      counters.blocksSent += 1;
      lastBlock = { number: block.number, rows: block.hashes.length, at: t };
      const seen = block.hashes.filter((h) => pool.has(h)).length;
      coverage.record({ number: block.number, rows: block.hashes.length, seen }, t);
      hub.broadcast(serialize(blockFrame(block)), t);
      log.line("block", {
        number: block.number,
        rows: block.hashes.length,
        seen,
        attempts: meta.attempts,
        latencyMs: meta.latencyMs,
        backfilled: meta.backfilled,
        clients: hub.clients(),
      });
    },
    onMiss(head, reason) {
      counters.receiptsMisses += 1;
      log.line("miss", { number: head.number, hash: head.hash, reason });
    },
    onReject(reason) {
      bump(counters.headsRejected, reason);
      log.once(`head-reject:${reason}`, "drop", { what: "head", reason });
    },
  });

  const onLink = (which: "pending" | "blocks", source: Source) => (state: LinkState, detail?: string) => {
    links[which] = { state, detail: detail ?? "", since: now() };
    log.line("link", { feed: which, state, detail, source: source.describe().name });
  };
  const onPending = (raw: Record<string, unknown>, observedAt: number) => {
    counters.pendingSeen += 1;
    lastPendingAt = observedAt;
    const parsed = pendingTx(raw, observedAt, now());
    if (!parsed.ok) {
      bump(counters.pendingRejected, parsed.reason);
      log.once(`pending-reject:${parsed.reason}`, "drop", { what: "pending", reason: parsed.reason, sample: JSON.stringify(raw).slice(0, 200) });
      return;
    }
    if (!pool.add(parsed.value.hash, observedAt)) {
      counters.pendingDuplicates += 1;
      return;
    }
    batch.push(parsed.value);
  };
  const onHead = (raw: Record<string, unknown>) => {
    counters.headsSeen += 1;
    lastHeadAt = now();
    blocks.onHead(raw);
  };

  function start(): void {
    if (pendingSource) return;
    counters.starts += 1;
    startedAt = now();
    lastClientLeftAt = null;
    pendingSource = createSource(config.upstreamUrls, { pending: true, heads: !split });
    blockSource = split ? createSource(config.blocksUrls!, { pending: false, heads: true }) : pendingSource;
    if (split) {
      stops.push(pendingSource.subscribe({ onPending, onHead: () => {}, onLink: onLink("pending", pendingSource) }));
      stops.push(blockSource.subscribe({ onPending: () => {}, onHead, onLink: onLink("blocks", blockSource) }));
    } else {
      const both = onLink("pending", pendingSource);
      stops.push(
        pendingSource.subscribe({
          onPending,
          onHead,
          onLink: (state, detail) => {
            both(state, detail);
            links.blocks = links.pending;
          },
        }),
      );
    }
    log.line("start", { upstream: config.upstreamUrls.join(","), blocks: config.blocksUrls?.join(",") ?? "same", idleStopMs: config.idleStopMs });

    // Timers. The batch flush is the one place a txs frame is born.
    flushTimer = setInterval(() => {
      const txs = batch.flush();
      const drops = batch.drops();
      if (drops !== counters.batchDrops) {
        log.once("batch-drops", "drop", { what: "batch", total: drops });
        counters.batchDrops = drops;
      }
      if (txs.length === 0) return;
      counters.txFramesSent += 1;
      hub.broadcast(serialize(txsFrame(txs)), now());
    }, config.batchIntervalMs);
    tickTimer = setInterval(tick, 1_000);
  }

  function stop(): void {
    if (!pendingSource) return;
    for (const s of stops) s();
    stops = [];
    pendingSource = null;
    blockSource = null;
    if (flushTimer) clearInterval(flushTimer);
    if (tickTimer) clearInterval(tickTimer);
    flushTimer = null;
    tickTimer = null;
    batch.flush();
    const t = now();
    links.pending = { state: "closed", detail: "idle", since: t };
    links.blocks = links.pending;
    startedAt = null;
  }

  function tick(): void {
    const t = now();
    const { evicted } = hub.tick(t);
    if (evicted > 0) log.line("client", { event: "evicted", count: evicted, reason: "stalled", clients: hub.clients() });
    pool.prune(t);
    if (pool.capEvictions() > 0) log.once("pool-cap", "drop", { what: "pool-cap", total: pool.capEvictions(), size: pool.size() });
    if (links.pending.state === "open" && lastPendingAt !== null && t - lastPendingAt > config.pendingStaleMs) {
      log.once("pending-silent", "silent", { feed: "pending", forMs: t - lastPendingAt });
    }
    if (links.blocks.state === "open" && lastHeadAt !== null && t - lastHeadAt > config.headStaleMs) {
      log.once("heads-silent", "silent", { feed: "heads", forMs: t - lastHeadAt });
    }
    if (config.idleStopMs > 0 && hub.clients() === 0) {
      if (lastClientLeftAt === null) lastClientLeftAt = t;
      if (t - lastClientLeftAt >= config.idleStopMs) {
        counters.idleStops += 1;
        log.line("stop", { reason: "idle", idleMs: t - lastClientLeftAt });
        stop();
      }
    }
  }

  function healthy(): boolean {
    const t = now();
    return (
      links.pending.state === "open" &&
      links.blocks.state === "open" &&
      lastHeadAt !== null &&
      t - lastHeadAt <= config.headStaleMs &&
      lastPendingAt !== null &&
      t - lastPendingAt <= config.pendingStaleMs
    );
  }

  function state(): Record<string, unknown> {
    const t = now();
    const link = (l: Link) => ({ ...l, forS: Math.round((t - l.since) / 1000) });
    return {
      uptimeS: Math.round((t - createdAt) / 1000),
      running: pendingSource !== null,
      runningForS: startedAt === null ? null : Math.round((t - startedAt) / 1000),
      starts: counters.starts,
      idleStops: counters.idleStops,
      sources: {
        pending: pendingSource?.describe() ?? null,
        blocks: blockSource?.describe() ?? null,
        split,
        configured: { upstream: config.upstreamUrls, blocks: config.blocksUrls },
      },
      links: { pending: link(links.pending), blocks: link(links.blocks) },
      healthy: healthy(),
      pending: {
        seen: counters.pendingSeen,
        duplicates: counters.pendingDuplicates,
        rejected: record(counters.pendingRejected),
        lastAgoS: lastPendingAt === null ? null : Math.round((t - lastPendingAt) / 1000),
        pool: pool.size(),
        poolCapEvictions: pool.capEvictions(),
        batchDrops: counters.batchDrops,
        framesSent: counters.txFramesSent,
      },
      blocks: {
        headsSeen: counters.headsSeen,
        headsRejected: record(counters.headsRejected),
        sent: counters.blocksSent,
        backfilled: blocks.backfilled(),
        receiptsMisses: counters.receiptsMisses,
        inFlight: blocks.inFlight(),
        last: lastBlock === null ? null : { ...lastBlock, agoS: Math.round((t - lastBlock.at) / 1000) },
        lastHeadAgoS: lastHeadAt === null ? null : Math.round((t - lastHeadAt) / 1000),
      },
      coverage: coverage.snapshot(),
      clients: {
        open: hub.clients(),
        framesSent: hub.framesSent(),
        lastId: hub.lastId(),
        replayBuffered: hub.buffered(),
        replays: hub.replays(),
        evicted: hub.evictions(),
        max: config.maxClients,
        maxPerIp: config.maxClientsPerIp,
      },
    };
  }

  if (config.idleStopMs === 0) start();

  return {
    config,
    admission: (ip) => hub.admission(ip),
    addClient(client, t, options) {
      const verdict = hub.admission(options.ip);
      if (verdict !== "ok") return { status: verdict };
      start();
      lastClientLeftAt = null;
      return hub.add(client, t, options);
    },
    removeClient(client) {
      hub.remove(client);
      if (hub.clients() === 0 && lastClientLeftAt === null) lastClientLeftAt = now();
    },
    state,
    healthy,
    running: () => pendingSource !== null,
    stop,
  };
}
