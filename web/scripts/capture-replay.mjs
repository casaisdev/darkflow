#!/usr/bin/env node
/**
 * Records a few minutes of Ethereum mainnet into the replay format.
 *
 *   node scripts/capture-replay.mjs --minutes 5 --out public/replay/mainnet.json
 *     [--pending wss://…]…  endpoints to hear pending transactions from
 *     [--blocks wss://…]     endpoint to take blocks and receipts from
 *
 * No dependencies. Node 22 has a WebSocket, and the format module is plain
 * enough for Node's own type stripping.
 *
 * ## What it records, and from where
 *
 * Every pending source is subscribed to `newPendingTransactions` with full
 * bodies requested. A node that honours that delivers transactions; one that
 * does not delivers hashes, and the body is fetched from the *same* node —
 * measured, another node fails to know about one hash in nine, and a body
 * fetched elsewhere would silently drop those. A hash is stamped `firstSeen`
 * the moment it is announced, not when its body arrives.
 *
 * Several sources are unioned by hash, earliest announcement wins. The
 * headline figure this recording will produce is "never seen by this node",
 * and with two nodes it is "never seen by either" — a smaller propagation
 * term, and the endpoints are written into the recording so the claim says
 * which nodes. Coverage is still partial: measured, one public endpoint hears
 * about a tenth of what another does.
 *
 * Blocks come from one source: `newHeads`, then the block by hash and its
 * receipts by hash, retried because a public gateway's upstreams lag each
 * other by a block. A block whose receipts cannot be had is dropped and
 * counted, never written with gaps.
 *
 * ## What it does not do
 *
 * It does not capture the pool as it stood when it started. `txpool_content`
 * is disabled on every public endpoint tried, so the recording opens cold and
 * the instrument calibrates over five blocks, exactly as it would against a
 * live ingest without a snapshot.
 */
import fs from "node:fs";
import path from "node:path";
import {
  RECORDING_FORMAT,
  blockFromRpc,
  encodeBlock,
  encodeTx,
  txFromRpc,
} from "../lib/replay/format.ts";

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
}
function flags(name) {
  const out = [];
  args.forEach((a, i) => {
    if (a === `--${name}` && args[i + 1] !== undefined) out.push(args[i + 1]);
  });
  return out;
}

const MINUTES = Number(flag("minutes", "5"));
const OUT = flag("out", `public/replay/mainnet-${new Date().toISOString().slice(0, 10)}.json`);
const PENDING = flags("pending").length
  ? flags("pending")
  : ["wss://eth.drpc.org", "wss://ethereum.publicnode.com"];
const BLOCKS = flag("blocks", "wss://ethereum.publicnode.com");

/** Flush cadence for transaction frames, as the ingest contract batches. */
const BATCH_MS = 100;
/** Body fetches in flight per source before announcements are dropped. */
const MAX_INFLIGHT = 80;
/** Announcements waiting for a fetch slot before they are dropped. */
const MAX_QUEUE = 2000;

// ---------------------------------------------------------------- rpc client

/**
 * One WebSocket JSON-RPC connection with reconnect. Subscriptions are
 * re-established on reconnect; requests in flight when it drops are rejected.
 */
class Rpc {
  constructor(url, label) {
    this.url = url;
    this.label = label;
    this.id = 0;
    this.pending = new Map();
    this.subscriptions = []; // { params, handler, id }
    this.closed = false;
    this.drops = 0;
    this.ws = null;
    this.ready = this.connect();
  }

  connect() {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = async () => {
        for (const sub of this.subscriptions) {
          sub.id = await this.request("eth_subscribe", sub.params).catch(() => null);
        }
        resolve();
      };
      ws.onmessage = (event) => this.receive(JSON.parse(event.data));
      ws.onerror = () => {};
      ws.onclose = () => {
        for (const p of this.pending.values()) p.reject(new Error(`${this.label}: connection dropped`));
        this.pending.clear();
        if (this.closed) return;
        this.drops += 1;
        log(`${this.label}: dropped, reconnecting`);
        setTimeout(() => (this.ready = this.connect()), 1000);
      };
    });
  }

  receive(message) {
    for (const m of Array.isArray(message) ? message : [message]) {
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`${this.label}: ${JSON.stringify(m.error)}`));
        else p.resolve(m.result);
      } else if (m.method === "eth_subscription") {
        const sub = this.subscriptions.find((s) => s.id === m.params.subscription);
        sub?.handler(m.params.result);
      }
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) {
        reject(new Error(`${this.label}: not connected`));
        return;
      }
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async subscribe(params, handler) {
    const sub = { params, handler, id: null };
    this.subscriptions.push(sub);
    sub.id = await this.request("eth_subscribe", params);
    return sub;
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

async function withRetry(fn, attempts, delayMs) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await sleep(delayMs);
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (line) => console.error(`[capture ${elapsed()}] ${line}`);
let startedAt = 0;
const elapsed = () => (startedAt ? `${((Date.now() - startedAt) / 1000).toFixed(1)}s` : "");

// ---------------------------------------------------------------- capture

async function main() {
  const frames = [];
  /** hash → { firstSeen, sources: Set<label> } for every announcement. */
  const announced = new Map();
  /** Decoded bodies waiting for the next flush. */
  let batch = [];
  const stats = {
    announced: 0,
    bodies: 0,
    unknownBody: 0, // node announced a hash, then had no body for it
    droppedQueue: 0,
    rejectedShape: 0,
    blocks: 0,
    blocksDropped: 0,
    perSource: {},
  };

  const pendingClients = PENDING.map((url, i) => new Rpc(url, `pending${i}:${new URL(url).host}`));
  const blockClient = new Rpc(BLOCKS, `blocks:${new URL(BLOCKS).host}`);
  await Promise.all([...pendingClients.map((c) => c.ready), blockClient.ready]);

  const chainIds = await Promise.all(
    [...pendingClients, blockClient].map((c) => c.request("eth_chainId", []).then((h) => parseInt(h, 16))),
  );
  if (new Set(chainIds).size !== 1) throw new Error(`sources disagree on chain: ${chainIds.join(", ")}`);
  const chainId = chainIds[0];

  startedAt = Date.now();
  log(`recording chain ${chainId} for ${MINUTES} min from ${PENDING.join(" + ")}; blocks from ${BLOCKS}`);

  // --- pending transactions -------------------------------------------------

  function announce(hash, source) {
    const now = Date.now();
    const known = announced.get(hash);
    if (known) {
      known.sources.add(source);
      return false;
    }
    announced.set(hash, { firstSeen: now, sources: new Set([source]) });
    stats.announced += 1;
    return true;
  }

  function accept(rpcTx, firstSeen, source) {
    const tx = txFromRpc(rpcTx, firstSeen);
    if (!tx) {
      stats.rejectedShape += 1;
      return;
    }
    stats.bodies += 1;
    stats.perSource[source].bodies += 1;
    batch.push(tx);
  }

  for (const client of pendingClients) {
    const source = client.label;
    stats.perSource[source] = { announced: 0, bodies: 0 };
    const queue = [];
    let inflight = 0;

    const pump = () => {
      while (inflight < MAX_INFLIGHT && queue.length) {
        const hash = queue.shift();
        inflight += 1;
        client
          .request("eth_getTransactionByHash", [hash])
          .then(
            (body) => {
              if (body) accept(body, announced.get(hash).firstSeen, source);
              else stats.unknownBody += 1;
            },
            () => {
              stats.unknownBody += 1;
            },
          )
          .finally(() => {
            inflight -= 1;
            pump();
          });
      }
    };

    await client.subscribe(["newPendingTransactions", true], (result) => {
      if (typeof result === "string") {
        stats.perSource[source].announced += 1;
        if (!announce(result, source)) return;
        if (queue.length >= MAX_QUEUE) {
          stats.droppedQueue += 1;
          return;
        }
        queue.push(result);
        pump();
      } else if (result && typeof result === "object" && typeof result.hash === "string") {
        stats.perSource[source].announced += 1;
        if (!announce(result.hash, source)) return;
        accept(result, announced.get(result.hash).firstSeen, source);
      }
    });
    log(`${source}: subscribed`);
  }

  const flush = setInterval(() => {
    if (batch.length === 0) return;
    const t = Date.now() - startedAt;
    frames.push({ t, kind: "txs", txs: batch.map((tx) => encodeTx(tx, startedAt)) });
    batch = [];
  }, BATCH_MS);

  // --- blocks ---------------------------------------------------------------

  const blockFetches = new Set();
  await blockClient.subscribe(["newHeads"], (head) => {
    const t = Date.now() - startedAt;
    const number = parseInt(head.number, 16);
    const job = (async () => {
      try {
        // Parsed inside the retry, not after it: a public gateway answers a
        // fresh head from an upstream that is a block behind, and the shape
        // of that answer is "receipts missing for some hashes", which parses
        // to nothing. Measured on 2026-09-03: four blocks of twenty-five were
        // dropped as "wrong shape" that a second ask would have completed.
        const event = await withRetry(
          async () => {
            const [block, receipts] = await Promise.all([
              blockClient.request("eth_getBlockByHash", [head.hash, false]),
              blockClient.request("eth_getBlockReceipts", [head.hash]),
            ]);
            const parsed = blockFromRpc(block, receipts);
            if (!parsed) throw new Error("block or receipts incomplete");
            return parsed;
          },
          5,
          1500,
        );
        frames.push(encodeBlock(event, t, startedAt));
        stats.blocks += 1;
        const seen = event.hashes.filter((h) => announced.has(h)).length;
        log(
          `block ${number}: ${event.hashes.length} tx, ${seen} heard before landing ` +
            `(${((100 * (event.hashes.length - seen)) / Math.max(1, event.hashes.length)).toFixed(1)}% not)`,
        );
      } catch (error) {
        stats.blocksDropped += 1;
        log(`block ${number}: dropped — ${error.message}`);
      }
    })();
    blockFetches.add(job);
    job.finally(() => blockFetches.delete(job));
  });
  log(`${blockClient.label}: subscribed to heads`);

  // --- run ------------------------------------------------------------------

  const progress = setInterval(() => {
    log(`${stats.announced} announced, ${stats.bodies} bodies, ${stats.blocks} blocks`);
  }, 30_000);

  await sleep(MINUTES * 60_000);
  clearInterval(progress);
  clearInterval(flush);
  // Let in-flight block fetches finish; a block that lands in the last
  // second is worth its receipts.
  await Promise.race([Promise.all([...blockFetches]), sleep(8000)]);
  const durationMs = Date.now() - startedAt;
  for (const c of [...pendingClients, blockClient]) c.close();

  // --- write ----------------------------------------------------------------

  frames.sort((a, b) => a.t - b.t);
  const blocks = frames.filter((f) => f.kind === "block");
  if (blocks.length === 0) throw new Error("no blocks recorded; refusing to write a recording with nothing to classify");
  let overlapCount = 0;
  for (const entry of announced.values()) if (entry.sources.size > 1) overlapCount += 1;

  const meta = {
    format: RECORDING_FORMAT,
    chainId,
    sources: { pending: PENDING, blocks: BLOCKS },
    capturedAt: new Date(startedAt).toISOString(),
    startedAt,
    durationMs,
    firstBlock: Math.min(...blocks.map((b) => b.number)),
    lastBlock: Math.max(...blocks.map((b) => b.number)),
    counts: {
      txs: frames.reduce((n, f) => n + (f.kind === "txs" ? f.txs.length : 0), 0),
      blocks: blocks.length,
    },
    overlap: stats.announced ? overlapCount / stats.announced : 0,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ meta, frames }));
  const bytes = fs.statSync(OUT).size;

  log("done");
  console.error(
    JSON.stringify(
      {
        out: OUT,
        bytes,
        durationS: Math.round(durationMs / 1000),
        blocks: `${meta.firstBlock}–${meta.lastBlock} (${meta.counts.blocks}, ${stats.blocksDropped} dropped)`,
        txs: meta.counts.txs,
        announced: stats.announced,
        unknownBody: stats.unknownBody,
        rejectedShape: stats.rejectedShape,
        droppedQueue: stats.droppedQueue,
        overlap: meta.overlap.toFixed(3),
        perSource: stats.perSource,
        reconnects: [...pendingClients, blockClient].map((c) => `${c.label}: ${c.drops}`),
      },
      null,
      2,
    ),
  );
  console.log(`NEXT_PUBLIC_STREAM_SOURCE=replay\nNEXT_PUBLIC_REPLAY_URL=/${path.relative("public", OUT).replace(/\\/g, "/")}`);
}

main().catch((error) => {
  log(`failed: ${error.message}`);
  process.exit(1);
});
