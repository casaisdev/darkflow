/**
 * Configuration from the environment. Nothing here defaults to a network or
 * a provider: a core that starts is a core that was
 * told what to listen to. Tunables have defaults because they are sizes and
 * delays, not places.
 *
 * On Vercel these are the web project's server-side environment variables;
 * `web/lib/ingest-core.ts` reads them at first use.
 */

export type CoreConfig = {
  /** Upstream WebSocket endpoints for the pending feed (and heads, unless split), tried in order. */
  upstreamUrls: string[];
  /**
   * Optional separate endpoints for heads and receipts. When set, the
   * block half of the picture has its own connection and its own failures.
   */
  blocksUrls: string[] | null;

  /** Pool memory: how long a pending transaction is remembered. */
  poolTtlMs: number;
  /** Pool memory: the hard cap, logged when it binds. */
  poolMax: number;
  /** The txs batch: flush interval and the most entries one frame carries. */
  batchIntervalMs: number;
  maxBatchTxs: number;
  /** Blocks: wait before the first receipts call, and how many attempts. */
  receiptsDelayMs: number;
  receiptsAttempts: number;
  /** Blocks: how many missing blocks to fill in behind a head after a gap. */
  backfillMax: number;
  /** Upstream reconnect: the first wait; doubles up to thirty seconds. */
  reconnectMinMs: number;
  /** Clients: keepalive comment interval, stall eviction, the caps. */
  keepaliveMs: number;
  clientStallMs: number;
  maxClients: number;
  maxClientsPerIp: number;
  /** Clients: how far back `Last-Event-ID` can reach on a reconnect. */
  replayMs: number;
  /** After this long without a head, or without a pending, health reports 503. */
  headStaleMs: number;
  pendingStaleMs: number;
  /**
   * On demand: the upstream is subscribed when the first client arrives
   * and dropped this long after the last one leaves. `0` keeps it always on.
   */
  idleStopMs: number;
  /**
   * A stream is closed cleanly after this long so the client reconnects on
   * its own terms rather than being cut by a platform limit. `0` never closes.
   */
  streamMaxMs: number;
};

export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is required and empty`);
  return value;
}

function list(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ConfigError(`${name} must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

function isWsUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "ws:" || u.protocol === "wss:";
  } catch {
    return false;
  }
}

function wsList(name: string, value: string): string[] {
  const urls = list(value);
  if (urls.length === 0) throw new ConfigError(`${name} has no entries`);
  for (const url of urls) {
    if (!isWsUrl(url)) throw new ConfigError(`${name} entry is not a ws:// or wss:// URL: "${url}"`);
  }
  return urls;
}

export function loadCoreConfig(env: Env): CoreConfig {
  const upstreamUrls = wsList("UPSTREAM_WS_URL", required(env, "UPSTREAM_WS_URL"));
  const blocksRaw = env.BLOCKS_WS_URL?.trim();
  const blocksUrls = blocksRaw ? wsList("BLOCKS_WS_URL", blocksRaw) : null;
  return {
    upstreamUrls,
    blocksUrls,
    poolTtlMs: integer(env, "POOL_TTL_MS", 300_000, 1_000, 3_600_000),
    poolMax: integer(env, "POOL_MAX", 200_000, 1_000, 5_000_000),
    batchIntervalMs: integer(env, "BATCH_INTERVAL_MS", 100, 10, 5_000),
    maxBatchTxs: integer(env, "MAX_BATCH_TXS", 2_000, 1, 100_000),
    receiptsDelayMs: integer(env, "RECEIPTS_DELAY_MS", 1_500, 0, 60_000),
    receiptsAttempts: integer(env, "RECEIPTS_ATTEMPTS", 3, 1, 10),
    backfillMax: integer(env, "BACKFILL_MAX", 10, 0, 100),
    reconnectMinMs: integer(env, "RECONNECT_MIN_MS", 1_000, 50, 30_000),
    keepaliveMs: integer(env, "KEEPALIVE_MS", 15_000, 1_000, 120_000),
    clientStallMs: integer(env, "CLIENT_STALL_MS", 10_000, 1_000, 600_000),
    maxClients: integer(env, "MAX_CLIENTS", 500, 1, 100_000),
    maxClientsPerIp: integer(env, "MAX_CLIENTS_PER_IP", 8, 1, 10_000),
    replayMs: integer(env, "REPLAY_MS", 60_000, 0, 600_000),
    headStaleMs: integer(env, "HEAD_STALE_MS", 36_000, 12_000, 600_000),
    pendingStaleMs: integer(env, "PENDING_STALE_MS", 30_000, 5_000, 600_000),
    idleStopMs: integer(env, "IDLE_STOP_MS", 60_000, 0, 3_600_000),
    streamMaxMs: integer(env, "STREAM_MAX_MS", 0, 0, 3_600_000),
  };
}
