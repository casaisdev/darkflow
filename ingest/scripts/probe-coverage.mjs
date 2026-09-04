/**
 * Coverage: of the transactions in each new block, what share did a feed
 * announce as pending first? This is the number that decides whether a
 * source can carry DARKFLOW's claim: a feed that misses
 * announced transactions inflates "never seen" with its own blindness.
 *
 * Two feeds run side by side. The union tells the two apart: if adding a
 * feed with more peers barely moves the share, what is left unseen is
 * private flow, not a blind spot.
 *
 *   node scripts/probe-coverage.mjs [minutes=5] [primary=wss://ethereum-rpc.publicnode.com] [secondary=wss://eth.drpc.org]
 *
 * Prints one JSON document at the end. For the overnight run, pass
 * the minutes and pipe stdout to a file; hourly figures are in `perHour`.
 */
const minutes = Number(process.argv[2] ?? 5);
const FEEDS = {
  primary: process.argv[3] ?? "wss://ethereum-rpc.publicnode.com",
  secondary: process.argv[4] ?? "wss://eth.drpc.org",
};
const WINDOW_MS = minutes * 60_000;
const WARMUP_MS = 120_000;

const seen = { primary: new Map(), secondary: new Map() };
const stats = { primary: { n: 0, dup: 0, drops: 0 }, secondary: { n: 0, dup: 0, drops: 0 } };
const heads = [];
let receiptsSock = null;

function open(name, url) {
  let ws;
  const subs = {};
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions", true] }));
      if (name === "primary") {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));
        receiptsSock = ws;
      }
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) subs[m.result] = "pending";
      if (m.id === 2) subs[m.result] = "heads";
      if (m.id >= 100 && Array.isArray(m.result)) {
        const head = heads.find((h) => h.id === m.id);
        if (!head) return;
        const hashes = m.result.map((r) => r.transactionHash);
        head.total = hashes.length;
        for (const f of Object.keys(seen)) head[f] = hashes.filter((h) => seen[f].has(h)).length;
        head.either = hashes.filter((h) => seen.primary.has(h) || seen.secondary.has(h)).length;
        head.done = true;
      }
      if (m.method === "eth_subscription") {
        const r = m.params.result;
        const kind = subs[m.params.subscription];
        if (kind === "pending") {
          const h = typeof r === "string" ? r : r.hash;
          if (seen[name].has(h)) stats[name].dup++;
          else seen[name].set(h, Date.now());
          stats[name].n++;
        }
        if (kind === "heads") {
          const id = 100 + heads.length;
          heads.push({ id, number: parseInt(r.number, 16), hash: r.hash, at: Date.now() });
          setTimeout(() => receiptsSock?.send(JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getBlockReceipts", params: [r.hash] })), 1500);
        }
      }
    };
    ws.onclose = () => {
      stats[name].drops++;
      if (Date.now() < deadline) setTimeout(connect, 2000);
    };
    ws.onerror = () => {};
  };
  connect();
  return () => { try { ws.close(); } catch { /* gone */ } };
}

const deadline = Date.now() + WINDOW_MS;
const closers = Object.entries(FEEDS).map(([n, u]) => open(n, u));
// Keep the seen maps bounded on a long run: forget hashes older than 30 min.
const gc = setInterval(() => {
  const cutoff = Date.now() - 30 * 60_000;
  for (const f of Object.values(seen)) for (const [h, t] of f) { if (t < cutoff) f.delete(h); else break; }
}, 60_000);
await new Promise((r) => setTimeout(r, WINDOW_MS));
clearInterval(gc);
for (const c of closers) c();

const done = heads.filter((h) => h.done);
const t0 = heads[0]?.at ?? Date.now();
const settled = done.filter((h) => h.at - t0 > WARMUP_MS);
const share = (rows, f) => {
  const t = rows.reduce((a, h) => a + h.total, 0);
  const s = rows.reduce((a, h) => a + h[f], 0);
  return t ? +((100 * s) / t).toFixed(1) : null;
};
const perHour = [];
for (let hour = 0; hour * 3_600_000 < WINDOW_MS; hour++) {
  const rows = settled.filter((h) => Math.floor((h.at - t0) / 3_600_000) === hour);
  if (rows.length) perHour.push({ hour, blocks: rows.length, primary: share(rows, "primary"), secondary: share(rows, "secondary"), either: share(rows, "either") });
}
console.log(JSON.stringify({
  minutes,
  feeds: FEEDS,
  pendingPerSec: Object.fromEntries(Object.keys(stats).map((f) => [f, +(stats[f].n / (WINDOW_MS / 1000)).toFixed(1)])),
  duplicates: Object.fromEntries(Object.keys(stats).map((f) => [f, stats[f].dup])),
  drops: Object.fromEntries(Object.keys(stats).map((f) => [f, stats[f].drops])),
  blocksSeen: heads.length,
  blocksWithReceipts: done.length,
  seenBeforeInclusionPct: { primary: share(settled, "primary"), secondary: share(settled, "secondary"), either: share(settled, "either"), blocks: settled.length },
  perHour,
}, null, 1));
