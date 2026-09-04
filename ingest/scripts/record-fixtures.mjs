/**
 * Records raw provider messages into fixtures/, so that the frame tests run
 * against the shapes the provider actually sends and not against our idea of
 * them. No dependencies; Node 24's WebSocket.
 *
 *   node scripts/record-fixtures.mjs [url=wss://ethereum-rpc.publicnode.com] [seconds=90]
 *
 * Writes:
 *   fixtures/pending.json        up to 200 full pending transaction objects,
 *                                keeping every fee type seen
 *   fixtures/heads.json          every newHeads notification in the window
 *   fixtures/receipts.json       eth_getBlockReceipts for the first head,
 *                                fetched by hash, plus that head
 *   fixtures/README.md           when, where, what
 */
import { writeFileSync, mkdirSync } from "node:fs";

const url = process.argv[2] ?? "wss://ethereum-rpc.publicnode.com";
const seconds = Number(process.argv[3] ?? 90);
const recordedAt = new Date().toISOString();

const ws = new WebSocket(url);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("connect failed")); });

const pending = [];
const byType = new Map();
const heads = [];
let receipts = null;
let receiptsHead = null;
const subs = {};

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id === 1) subs[m.result] = "pending";
  if (m.id === 2) subs[m.result] = "heads";
  if (m.id === 3 && Array.isArray(m.result)) receipts = m.result;
  if (m.method !== "eth_subscription") return;
  const kind = subs[m.params.subscription];
  const r = m.params.result;
  if (kind === "pending") {
    const type = r.type ?? "none";
    byType.set(type, (byType.get(type) ?? 0) + 1);
    // Keep the first 200, and always keep the first of every type.
    if (pending.length < 200 || byType.get(type) === 1) pending.push(r);
  }
  if (kind === "heads") {
    heads.push(r);
    if (!receiptsHead) {
      receiptsHead = r;
      setTimeout(() => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "eth_getBlockReceipts", params: [r.hash] })), 1500);
    }
  }
};
ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newPendingTransactions", true] }));
ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "eth_subscribe", params: ["newHeads"] }));
await new Promise((r) => setTimeout(r, seconds * 1000));
ws.close();

mkdirSync("fixtures", { recursive: true });
writeFileSync("fixtures/pending.json", JSON.stringify(pending, null, 1));
writeFileSync("fixtures/heads.json", JSON.stringify(heads, null, 1));
writeFileSync("fixtures/receipts.json", JSON.stringify({ head: receiptsHead, receipts }, null, 1));
writeFileSync("fixtures/README.md", `# Fixtures

Raw provider messages, recorded by \`scripts/record-fixtures.mjs\`.

- recorded: ${recordedAt}
- source: ${url}
- window: ${seconds}s
- pending.json: ${pending.length} transactions, by type: ${[...byType].map(([t, n]) => `${t}=${n}`).join(", ")}
- heads.json: ${heads.length} heads
- receipts.json: ${receipts?.length ?? 0} receipts for block ${receiptsHead ? parseInt(receiptsHead.number, 16) : "none"}

These are data, not examples: the frame tests parse them as the provider sent
them. Re-record rather than edit.
`);
console.log(`pending=${pending.length} types=${[...byType].map(([t, n]) => `${t}:${n}`).join(",")} heads=${heads.length} receipts=${receipts?.length ?? 0}`);
