# ingest

The server half of DARKFLOW: one subscription to the Ethereum mainnet mempool
and chain head, turned into one Server-Sent Events stream that any number of
open pages read. It speaks the wire contract in `../web/types/stream.ts` and
nothing else.

It has no process of its own. One route handler in the web
(`web/app/api/[endpoint]/route.ts`, serving `/api/stream`, `/api/state` and
`/api/health`) imports `src/core.ts` and `src/vercel.ts` and runs the whole
thing inside one of the site's functions on Vercel. One handler, not three:
each route file there is its own function with its own instance, and the core
lives in module state. Same origin, so
no CORS; one upstream connection shared by every page an instance serves;
subscribed when the first page arrives, dropped a minute after the last one
leaves. Zero runtime dependencies. Node 24 runs the TypeScript as it is.

```
pnpm install                 # dev tools only
pnpm typecheck && pnpm test
```

Configuration is the web project's server-side environment; every variable
is listed in `../web/.env.example`. Only `UPSTREAM_WS_URL` is required;
nothing defaults to a network or a provider.

## What it does, and what it refuses to do

The web infers everything on its own from two feeds: the pending pool as one
endpoint hears it, and every block as it lands with its ordered hashes and the
gas each row consumed. The ingest **does not classify, does not reconcile
reorgs, does not smooth, and never invents a frame**. Each of those would let a
server turn an honest "we do not know" into a false "we know" — the contract's
header in `web/types/stream.ts` says why at length.

Two rules run through everything below: no frame is sent that the chain did
not produce, and every drop is counted somewhere a human can read (`/api/state`).

## The source, and why it is this one

`wss://ethereum-rpc.publicnode.com`, free, no key. Chosen by measurement, not
by reading:

| What was asked of it | What it did |
|---|---|
| `eth_subscribe("newPendingTransactions", true)` | Full transaction objects, with `type`, `maxFeePerGas`, `maxPriorityFeePerGas`, `gasPrice`, `gas`, `from`, `to`, `chainId` |
| `eth_subscribe("newHeads")` | `number`, `hash`, `parentHash`, `baseFeePerGas`, `timestamp` |
| `eth_getBlockReceipts(blockHash)` | `transactionHash`, `transactionIndex`, `gasUsed`, `effectiveGasPrice` per receipt |
| Five minutes of pending | 11.9 tx/s, no duplicates, no disconnects |
| Share of a block's rows it had heard pending first | 55.5 % over fifteen blocks; a second public feed with three times the announcements reached 55.9 %, the union 56.6 % |

The last row is the one that matters: adding a feed with far more peers moved
the figure by one point, so what is left unheard is private flow, not a blind
spot. The product's claim survives this source as "never seen by this feed".

What was rejected, with numbers. Every metered provider prices the mempool by
message or by byte, and the mempool is the chain's largest stream: at a
modest 25 tx/s Alchemy's 0.04 CU/byte works out near $1,000 a month,
QuickNode's per-response credits land on a $999 plan, Chainstack's one unit
per event is 65 M a month against 3 M free, Infura's per-event credits blow
through its daily allowance by breakfast. LlamaRPC, Blast, 1RPC, Ankr and
Merkle refused the WebSocket without a key. `scripts/probe-ws.mjs` and
`scripts/probe-coverage.mjs` are the two probes that produced these numbers;
run them before trusting a source that has not been probed this month.

PublicNode publishes no rate limits and its terms let it revoke access for any
reason. The source is one file behind an interface (`src/source/`), so a
replacement is a file and a config value.

## How it works

```
PublicNode (wss) ─► source/provider ─► pool ─► batch (10 Hz) ─► hub ─► /api/stream (SSE) ─► pages
       │ newHeads         └── blocks: receipts by hash ─► frames ┘  (never batched, never delayed)
       └── link state ─────────────────────────────────────────► /api/state, /api/health
```

- **Pending.** The provider pushes a full object; `wire/frames.ts` validates
  and converts it (fee shape from `type`, `firstSeen` clamped so a host clock
  ahead of the viewer's can never send a mark that refuses to fade); the pool
  deduplicates; the batch flushes every 100 ms as one `txs` frame. A malformed
  object is dropped and counted, never sent as a partial entry.
- **Blocks.** Heads are processed one at a time, in order. Each waits 1.5 s
  (a public gateway can serve a head before it has indexed the receipts), then
  one `eth_getBlockReceipts` **by hash** — never by number, so a reorg between
  the head and the call cannot pair a replaced block's rows with a new number.
  Three attempts with doubling waits; then a counted miss and **no frame**. If
  a head's number is more than one past the last block emitted — after a
  reconnect, typically — the missing blocks are walked back through
  `parentHash` (up to ten) and emitted first, oldest first.
- **Tips.** Receipts carry `effectiveGasPrice`, so every row's bid above the
  base fee goes on the wire as `BlockEvent.tips`, private flow included. The
  web places a never-seen row by it instead of at the floor.
- **Clients.** Every frame carries an `id:` and the last minute is kept; a page
  that reconnects with `Last-Event-ID` (which `EventSource` does on its own)
  gets what it missed. A stream is closed cleanly just under the platform's
  duration limit so the page reconnects on its own terms rather than on a 504.
  A client whose socket stops draining for ten seconds is closed; one address
  may hold eight streams; past five hundred clients the answer is 503 with
  `Retry-After`.
- **Coverage.** Of each block it emits, the ingest counts how many rows were
  in its pool first, and publishes the share per block, over the last ten and
  per hour. The web shows it on the panel as COVERAGE, beside the headline it
  bounds.
- **Health.** `/api/health` is 200 only with the link open, a head within
  36 s *and* a pending transaction within 30 s. A feed delivering blocks and no
  transactions is the worst shape a failure can take here, and it used to
  report healthy.

RPC budget on the steady path: two subscriptions and about five calls a
minute. `eth_getBlockByHash` is called only to fill a gap.

## Failure model

| Failure | Response | What the page sees |
|---|---|---|
| Upstream socket drops | reconnect with capped, jittered backoff; resubscribe; blocks produced meanwhile filled in from parent hashes | silence, then a complete chain again |
| Head before its receipts are indexed | wait, retry, doubling | a block a few seconds late |
| Receipts never come | no frame; counted | that block missing; readings marked not current |
| Reorg | passed through as-is | the page's ledger records it |
| Malformed provider object | dropped and counted by shape | nothing |
| Page's connection blips | replay from the last minute | no gap in its ledger |
| Slow client | closed after ten seconds of back-pressure | that page reconnects |
| Provider revokes access | backoff continues; health 503 | fallback to the recording, "Try live again" |
| Instance recycled (on demand) | next request starts a new one; the pool refills | one reconnect, then calibration if the seen-set is cold |

## Layout

```
src/
  core.ts           the ingest as one object: sources → pool/batch/blocks/coverage/hub, on demand
  vercel.ts         the transport: Request → Response over a ReadableStream
  config.ts         env → typed config; fails loudly on what is missing
  source/           the Source interface, JSON-RPC over WebSocket with reconnect, the provider file
  wire/             pure: raw objects → contract types, and the 10 Hz batch
  blocks.ts         heads in order: gap walk, wait, receipts by hash, retries, misses
  pool.ts           what was announced, bounded by age; dedup and counts
  hub.ts            clients, ids and replay, keepalive, stall eviction
  coverage.ts       the self-measurement, per block and per hour
tests/              every module without a network, plus the whole thing against a
                    fake provider (a WebSocket server of a hundred lines in tests/helpers/)
fixtures/           raw provider messages, recorded; the frame tests parse those, not examples
scripts/            the two probes and the fixture recorder
```

`wire/`, `pool`, `batch`, `hub` and `coverage` import only the contract and
each other; `source/` and `vercel.ts` are the only modules with I/O.

## Verification

Tests are mutation-checked at the claims that matter: receipts from another
block accepted, `firstSeen` not clamped, stalled clients never evicted,
subscriptions not re-established after a reconnect, a miss still emitting a
block, replay including the frame already seen, backfill emitted newest first,
health ignoring the pending feed, coverage counting every row as seen, the
per-address cap never binding — each of those mutants fails the suite.

Against live mainnet, from a development machine: twenty minutes with a page
attached, 97 heads and 97 blocks, no misses, no rejections, one link event;
the page's never-seen figure equal, block for block, to the rows the ingest had
not heard first. Not yet measured on the host it will run on.
