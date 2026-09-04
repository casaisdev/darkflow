/**
 * A fake ingest: the wire contract in `types/stream.ts`, served over SSE, with
 * a control endpoint for breaking it on purpose.
 *
 * It exists so the page's live path — reconnecting, per-feed silence, the
 * fallback to the recording, the way back, replay after a blip, the coverage
 * reading — can be driven end to end in a browser without a network and
 * without the real ingest. It mirrors the real adapter's surface
 * (ingest/src/vercel.ts): frames carry `id:` lines, a reconnect with
 * `Last-Event-ID` gets the frames it missed from the last minute, and
 * `/state` answers with the same shape, its coverage labelled as invented.
 *
 * No dependencies. Node's http module, CORS for any origin (a local page on
 * another port connects directly).
 *
 *   node scripts/fake-ingest.mjs [port=3999] [tps=45]
 *
 *   tps is the transaction rate. The default is a quiet hour; mainnet runs at
 *   a few hundred, which is where the seen-set's TTL and size cap start to
 *   matter and the only rate at which a soak of the page says anything.
 *
 *   GET  /stream                    the SSE feed: snapshot on open, then txs
 *                                   batches at ~10Hz and a block every 12s;
 *                                   honours Last-Event-ID
 *   GET  /state                     what it is doing, as JSON, in the real
 *                                   ingest's shape (coverage is made up and
 *                                   says so)
 *   POST /control?cmd=<command>     bend it:
 *        silence-txs&ms=N           stop transaction batches for N ms
 *        silence-all&ms=N           stop everything for N ms
 *        drop                       close every open connection once
 *                                   (EventSource reconnects on its own)
 *        resume                     end any silence early
 *        rate&tps=N                 change the transaction rate
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.argv[2] ?? 3999);
let tps = Number(process.argv[3] ?? 45);
const WIRE_VERSION = 1;
const GWEI = 1e9;
const REPLAY_MS = 60_000;

const clients = new Set();
let silenceTxsUntil = 0;
let silenceAllUntil = 0;
let baseFee = 0.8 * GWEI;
let blockNumber = 26_000_000;
let txsSent = 0;
let blocksSent = 0;
const startedAt = Date.now();

/** Announced and not yet included: the pool, as this ingest sees it. */
const pool = new Map();

/** The last minute of frames, with ids, for Last-Event-ID. */
let nextId = 1;
const buffer = [];
let replays = { clients: 0, frames: 0 };

const hex = (bytes) => `0x${randomBytes(bytes).toString("hex")}`;
const rand = Math.random;

/** Log-normal-ish tips with a fat mass at zero, like mainnet. */
function makeTx(now) {
  const zero = rand() < 0.6;
  const tip = zero ? 0 : Math.exp(Math.log(0.05 * GWEI) + rand() * Math.log(200));
  const legacy = rand() < 0.2;
  const fees = legacy
    ? { kind: "legacy", gasPrice: Math.round(baseFee + tip) }
    : {
        kind: "eip1559",
        maxPriorityFeePerGas: Math.round(tip),
        maxFeePerGas: Math.round(baseFee * 2 + tip),
      };
  return { hash: hex(32), firstSeen: now, gas: 21_000 + Math.floor(rand() * 180_000), fees };
}

function frame(payload) {
  return `data: ${JSON.stringify({ v: WIRE_VERSION, ...payload })}\n\n`;
}

/** Every frame that leaves gets an id and a minute in the buffer. */
function broadcast(payload) {
  const id = nextId++;
  const text = `id: ${id}\n${frame(payload)}`;
  const now = Date.now();
  buffer.push({ id, at: now, text });
  while (buffer.length > 0 && buffer[0].at < now - REPLAY_MS) buffer.shift();
  for (const res of clients) res.write(text);
}

function snapshotFor(res) {
  const txs = [...pool.values()];
  res.write(frame({ kind: "snapshot", txs }));
}

setInterval(() => {
  const now = Date.now();
  if (now < silenceAllUntil || now < silenceTxsUntil) return;
  const batch = [];
  // Ten batches a second, each jittered ±30% around the rate.
  const count = Math.max(1, Math.round((tps / 10) * (0.7 + rand() * 0.6)));
  for (let i = 0; i < count; i++) {
    const tx = makeTx(now);
    pool.set(tx.hash, tx);
    batch.push(tx);
  }
  txsSent += batch.length;
  // Bound the pool the way a real one is bounded: old entries drop out.
  if (pool.size > 6000) {
    for (const key of [...pool.keys()].slice(0, pool.size - 6000)) pool.delete(key);
  }
  broadcast({ kind: "txs", txs: batch });
}, 100);

setInterval(() => {
  const now = Date.now();
  if (now < silenceAllUntil) return;
  baseFee = Math.max(0.05 * GWEI, baseFee * (0.9 + rand() * 0.2));
  // Builders take the highest tips; a share of the block was never announced.
  const tipOf = (tx) =>
    tx.fees.kind === "legacy"
      ? tx.fees.gasPrice - baseFee
      : Math.min(tx.fees.maxPriorityFeePerGas, tx.fees.maxFeePerGas - baseFee);
  const ranked = [...pool.values()].sort((a, b) => tipOf(b) - tipOf(a));
  const publicCount = Math.min(ranked.length, 90 + Math.floor(rand() * 40));
  const ghostCount = 30 + Math.floor(rand() * 40);
  const included = ranked.slice(0, publicCount);
  for (const tx of included) pool.delete(tx.hash);
  const rows = [
    ...included.map((tx) => ({ hash: tx.hash, tip: tipOf(tx) })),
    ...Array.from({ length: ghostCount }, () => ({
      hash: hex(32),
      tip: included.length ? tipOf(included[Math.floor(rand() * included.length)]) : 0,
    })),
  ].sort((a, b) => b.tip - a.tip);
  blockNumber += 1;
  blocksSent += 1;
  broadcast({
    kind: "block",
    block: {
      number: blockNumber,
      timestamp: now,
      baseFeePerGas: Math.round(baseFee),
      hashes: rows.map((r) => r.hash),
      gasUsed: rows.map(() => 21_000 + Math.floor(rand() * 200_000)),
      tips: rows.map((r) => Math.max(0, Math.round(r.tip))),
    },
  });
}, 12_000);

/** The real ingest's /state shape, with the parts a generator cannot have marked as such. */
function state() {
  const now = Date.now();
  return {
    fake: true,
    uptimeS: Math.round((now - startedAt) / 1000),
    running: true,
    tps,
    links: { pending: { state: "open" }, blocks: { state: "open" } },
    healthy: true,
    pending: { seen: txsSent, pool: pool.size, framesSent: nextId - 1 },
    blocks: { headsSeen: blocksSent, sent: blocksSent, last: { number: blockNumber } },
    // Invented: a generator has no upstream to have missed anything from.
    // Kept in the real shape so the page's COVERAGE reading has something to
    // parse, and labelled so nobody reads it as a measurement.
    coverage: {
      invented: true,
      lastBlock: { number: blockNumber, rows: 150, seen: 100, pct: 66.7 },
      recent: { blocks: Math.min(10, blocksSent), rows: 1500, seen: 1000, pct: blocksSent > 0 ? 66.7 : null },
      perHour: [],
    },
    clients: { open: clients.size, framesSent: nextId - 1, lastId: nextId - 1, replayBuffered: buffer.length, replays },
    silenceTxsMs: Math.max(0, silenceTxsUntil - now),
    silenceAllMs: Math.max(0, silenceAllUntil - now),
  };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (url.pathname === "/stream") {
    res.writeHead(200, {
      ...cors,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 1000\n\n");
    const since = Number(req.headers["last-event-id"]);
    if (Number.isInteger(since) && since >= 0) {
      // A returning page: what it missed, if the buffer still reaches that far.
      const oldest = buffer[0];
      if (oldest && since >= oldest.id - 1) {
        let n = 0;
        for (const f of buffer) if (f.id > since) { res.write(f.text); n += 1; }
        replays = { clients: replays.clients + 1, frames: replays.frames + n };
      }
    } else {
      snapshotFor(res);
    }
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (url.pathname === "/control" && req.method === "POST") {
    const cmd = url.searchParams.get("cmd");
    const ms = Number(url.searchParams.get("ms") ?? 0);
    const now = Date.now();
    if (cmd === "silence-txs") silenceTxsUntil = now + ms;
    else if (cmd === "silence-all") silenceAllUntil = now + ms;
    else if (cmd === "resume") silenceTxsUntil = silenceAllUntil = 0;
    else if (cmd === "rate") tps = Math.max(1, Number(url.searchParams.get("tps") ?? tps));
    else if (cmd === "drop") {
      for (const c of clients) c.destroy();
      clients.clear();
    }
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cmd }));
    return;
  }
  if (url.pathname === "/state") {
    res.writeHead(200, { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(state()));
    return;
  }
  res.writeHead(404, cors);
  res.end();
});

server.listen(PORT, () => {
  console.log(`[fake-ingest] http://127.0.0.1:${PORT}/stream at ${tps} tx/s`);
});
