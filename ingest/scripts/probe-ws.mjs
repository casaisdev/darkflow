/**
 * Probes public Ethereum WebSocket endpoints for what the ingest needs:
 * full pending transactions, newHeads, and eth_getBlockReceipts. Twenty
 * seconds each, all in parallel, one JSON line per endpoint. This is the
 * measurement behind the choice of source; re-run it before trusting a source
 * that has not been probed this month.
 *
 *   node scripts/probe-ws.mjs [wss://... ...]      defaults to the list below
 */
const DEFAULT_ENDPOINTS = [
  "wss://ethereum-rpc.publicnode.com",
  "wss://eth.drpc.org",
  "wss://mainnet.gateway.tenderly.co",
  "wss://eth.llamarpc.com",
  "wss://eth-mainnet.public.blastapi.io",
  "wss://1rpc.io/eth",
  "wss://rpc.ankr.com/eth/ws",
];
const endpoints = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_ENDPOINTS;
const WINDOW_MS = 20_000;

async function probe(url) {
  const out = { url, ok: false };
  let ws;
  try {
    ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("connect failed"));
      setTimeout(() => rej(new Error("connect timeout")), 8000);
    });
  } catch (e) {
    out.error = e.message;
    return out;
  }
  out.ok = true;
  const subs = {};
  let pendingCount = 0, fullCount = 0, hashCount = 0, heads = 0;
  let firstTx = null, firstHead = null, receipts = null;
  const errors = [];
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id === 1) { if (m.error) errors.push("pending: " + JSON.stringify(m.error)); else subs[m.result] = "pending"; }
    if (m.id === 2) { if (m.error) errors.push("heads: " + JSON.stringify(m.error)); else subs[m.result] = "heads"; }
    if (m.id === 3) {
      receipts = m.error
        ? "error: " + JSON.stringify(m.error).slice(0, 120)
        : Array.isArray(m.result)
          ? `ok, ${m.result.length} receipts, fields: ${Object.keys(m.result[0] ?? {}).filter((k) => /gasUsed|effectiveGasPrice|transactionHash|transactionIndex|blockHash/.test(k)).join(",")}`
          : "unexpected";
    }
    if (m.method === "eth_subscription") {
      const kind = subs[m.params.subscription];
      const r = m.params.result;
      if (kind === "pending") {
        pendingCount++;
        if (typeof r === "string") hashCount++;
        else { fullCount++; if (!firstTx) firstTx = Object.keys(r).join(","); }
      }
      if (kind === "heads") {
        heads++;
        if (!firstHead) firstHead = Object.keys(r).filter((k) => /number|hash|parentHash|baseFeePerGas|timestamp|gasUsed/.test(k)).join(",");
      }
    }
  };
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions", true] }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_getBlockReceipts", params: ["latest"] }));
  await new Promise((r) => setTimeout(r, WINDOW_MS));
  try { ws.close(); } catch { /* gone already */ }
  Object.assign(out, {
    pendingPerSec: +(pendingCount / (WINDOW_MS / 1000)).toFixed(1),
    full: fullCount,
    hashesOnly: hashCount,
    txFields: firstTx,
    heads,
    headFields: firstHead,
    receipts,
    errors,
  });
  return out;
}

const results = await Promise.all(endpoints.map(probe));
for (const r of results) console.log(JSON.stringify(r));
