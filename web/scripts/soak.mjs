/**
 * A soak: the page left running in a browser for N minutes while its memory
 * and its data structures are sampled, to find what only time finds.
 *
 * Drives headless Chrome over the DevTools protocol with nothing but Node's
 * built-in WebSocket, so no dependency. The sampler lives in the page — a
 * `setInterval` on `window` reading the dev seam `window.__darkflow` — so it
 * survives this process and only needs collecting at the end. The seam exists
 * in development only: run the soak against `next dev`, not a build.
 *
 * Start Chrome yourself, with precise memory figures on:
 *
 *   chrome --headless=new --remote-debugging-port=9222 \
 *          --user-data-dir=<empty dir> --window-size=1424,800 \
 *          --enable-precise-memory-info about:blank
 *
 * then, with the dev server and an ingest (scripts/fake-ingest.mjs at a
 * mainnet rate is the point) running:
 *
 *   node scripts/soak.mjs [url=http://localhost:3000/] [minutes=30] [port=9222]
 *
 * Do not edit anything the app imports while it runs: HMR reloads the page and
 * the soak with it. Prints a summary and writes every sample as JSON next to it.
 *
 * What the summary cannot tell you: the heap figure is one renderer's JS heap,
 * not GPU memory, and the slope is a least-squares line over noisy GC cycles —
 * read it against the first-to-last delta, not on its own.
 */
import { writeFileSync } from "node:fs";

const url = process.argv[2] ?? "http://localhost:3000/";
const minutes = Number(process.argv[3] ?? 30);
const port = Number(process.argv[4] ?? 9222);
const SAMPLE_MS = 10_000;

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("no page target in Chrome");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
async function evalIn(source) {
  const result = await send("Runtime.evaluate", {
    expression: `(async () => { ${source} })()`,
    awaitPromise: true,
    returnByValue: true,
    timeout: 300_000,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? "eval failed");
  }
  return result.result.value;
}

// The sampler. Everything it reads is on the dev seam; a missing method reads
// as null rather than throwing, so an older seam still yields a partial row.
const START = `
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 600; i++) {
    if (window.__darkflow && document.querySelector(".df-status-dot")) break;
    await sleep(100);
  }
  const D = window.__darkflow;
  if (!D) return "no dev seam: run the soak against next dev";
  const soak = { t0: Date.now(), samples: [], frames: 0, world: D.world };
  window.__soak = soak;
  const tick = () => { soak.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  let lastFrames = 0, lastAt = Date.now();
  const call = (o, k) => (typeof o?.[k] === "function" ? o[k]() : null);
  soak.timer = setInterval(() => {
    const now = Date.now();
    const fps = (soak.frames - lastFrames) / ((now - lastAt) / 1000);
    lastFrames = soak.frames; lastAt = now;
    const W = D.world;
    soak.samples.push({
      minute: +((now - soak.t0) / 60000).toFixed(2),
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
      fps: +fps.toFixed(1),
      seen: call(D.seen, "size"),
      pending: call(D.seen, "pending"),
      capacityEvictions: call(D.seen, "capacityEvictions"),
      entities: W.entities.length,
      inbox: W.inbox.length,
      block: W.block.length,
      head: call(D.ledger, "head"),
      reorgs: call(D.ledger, "reorgs"),
      status: document.querySelector(".df-status-dot")?.dataset.status ?? null,
    });
  }, ${SAMPLE_MS});
  return "started";
`;

const COLLECT = `
  const s = window.__soak;
  if (!s) return null;
  clearInterval(s.timer);
  return { elapsedMin: +((Date.now() - s.t0) / 60000).toFixed(2),
           sameWorld: window.__darkflow?.world === s.world, samples: s.samples };
`;

await send("Page.enable");
await send("Page.navigate", { url });
const started = await evalIn(START);
if (started !== "started") throw new Error(started);
console.log(`soak started on ${url} for ${minutes} min, sampling every ${SAMPLE_MS / 1000}s`);

await new Promise((r) => setTimeout(r, minutes * 60_000));
const result = await evalIn(COLLECT);
ws.close();
if (!result) throw new Error("the soak is gone: the page reloaded (HMR?) during the run");

const S = result.samples;
const col = (k) => S.map((x) => x[k]).filter((v) => v !== null && v !== undefined);
const stats = (a) =>
  a.length
    ? { min: Math.min(...a), max: Math.max(...a), mean: +(a.reduce((x, y) => x + y) / a.length).toFixed(1) }
    : null;
const slope = (xs, ys) => {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b) / n;
  const my = ys.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  return +(sxy / sxx).toFixed(3);
};
const late = S.filter((x) => x.minute >= Math.min(10, minutes / 3) && x.heapMB !== null);
const summary = {
  url, minutes: result.elapsedMin, samples: S.length, sameWorld: result.sameWorld,
  heapMB: { first: S[0]?.heapMB, last: S.at(-1)?.heapMB, ...stats(col("heapMB")),
    slopePerMin_all: slope(S.map((x) => x.minute), S.map((x) => x.heapMB)),
    slopePerMin_settled: slope(late.map((x) => x.minute), late.map((x) => x.heapMB)) },
  fps: stats(col("fps")),
  seen: stats(col("seen")),
  pending: stats(col("pending")),
  capacityEvictions: { first: S[0]?.capacityEvictions, last: S.at(-1)?.capacityEvictions },
  entities: stats(col("entities")),
  inbox: stats(col("inbox")),
  block: stats(col("block")),
  blocks: { first: S[0]?.head, last: S.at(-1)?.head, reorgs: S.at(-1)?.reorgs },
  statuses: [...new Set(col("status"))],
};
const out = `soak-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(out, JSON.stringify({ summary, samples: S }, null, 1));
console.log(JSON.stringify(summary, null, 1));
console.log(`samples written to ${out}`);
