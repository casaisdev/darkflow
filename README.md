# DARKFLOW

A live view of the Ethereum mempool, built to show one thing: the transactions
that enter a block **without ever having been in the public mempool**.

**[darkflow.martincasais.com](https://darkflow.martincasais.com)**

Every pending transaction the feed hears is a dot in a chamber, placed by the
fee it offers and fading as it waits. Every twelve seconds a block lands. The
transactions the feed had heard fly to their row in the block; the ones it had
not appear in their row with no trajectory, in the one warm colour the page
uses for nothing else. The panel reads the share: *never seen by this feed*.
On mainnet that is about half of every block.

That figure is an upper bound on private order flow from one vantage point —
builder bundles, private relays, and whatever propagation simply missed — and
the page says so. Everything on it is measured before it is shown; what cannot
be supported is shown as blank, never as zero.

## How it is put together

```
PublicNode ── wss ──► the ingest, inside the site's own route handlers ── SSE ──► the page
                        one subscription, shared by every open tab              canvas, no framework in the hot path
```

Two packages, one contract between them (`web/types/stream.ts`):

- **`web/`** — Next.js, one `<canvas>`, a pure simulation stepped by a
  single animation loop. Every visual constant was calibrated in pixels, every
  reading has a definition on hover, and a governor scales the render budget
  down on a device that drops frames. It also serves the feed: three route
  handlers run the ingest core inside the site's functions.
- **`ingest/`** — the core those handlers run. One WebSocket subscription to
  a public endpoint, receipts by hash, frames batched at 10 Hz, replay on
  reconnect, its own coverage measured on every block. No dependencies, no
  process of its own. Its README has the design and the numbers behind it.

The hosting is deliberate. Nobody is watching this site all day, so nothing
runs all day: the upstream subscription opens when the first page arrives and
closes a minute after the last one leaves. Concurrent pages on an instance
share the one connection.

## What it can and cannot tell you

- **It can** show, block by block, how much of what landed was never announced
  to this feed, and place every row — announced or not — at the fee it
  actually paid, read from the receipt.
- **It cannot** tell private flow from a transaction the feed simply failed to
  hear. So it measures itself: for every block, how many rows it had heard
  first (about half), shown on the panel as COVERAGE. A second public feed
  with three times the announcements added one point to that, which is why the
  rest is called private flow rather than deafness.
- **It will not** guess. The first five blocks after connecting are a warm-up
  during which nothing is marked and the headline is blank. A block whose
  receipts cannot be had is not drawn with gaps; it is not drawn. If the feed
  dies, the page falls back to a recording of mainnet and says so in the status
  dot.

## Running it

```bash
cd web
cp .env.example .env.local        # pick a source; the defaults are explained inline
pnpm install
pnpm dev
```

Three sources, chosen at build time: `synthetic` (a seeded generator with the
shape of mainnet — the default, and what every visual constant was calibrated
against), `replay` (a recording in `public/replay/`, played at its own pace),
and `sse` (the live feed, served by the site itself at `/api/stream` when
`UPSTREAM_WS_URL` is set, or by `scripts/fake-ingest.mjs` for local work
without a network). The status dot always says which one you are looking at.

To deploy: one Vercel project, Root Directory `web`, and four environment
variables — nothing else. The ingest needs no server; it runs inside the
site's functions and reads the same environment.

```
NEXT_PUBLIC_STREAM_SOURCE=sse
NEXT_PUBLIC_INGEST_URL=/api/stream
NEXT_PUBLIC_REPLAY_URL=replay/mainnet-2026-09-03.json   # or empty: no fallback
UPSTREAM_WS_URL=wss://ethereum-rpc.publicnode.com        # server-side
```

Every other setting has a default and is documented in `web/.env.example`.

Gates, in both packages: `pnpm lint`, `pnpm build`, `pnpm test` — 394 tests in
the web, 57 in the ingest, mutation-checked at the claims that matter, and
run by CI on every push.

## Method

The characteristic failure of this project is one that cannot be seen,
because it produces a plausible picture: an alpha that was `NaN` and silently
disabled decay for months of screenshots; a block shuffled for realism that
destroyed the fee ordering it sat next to; a build gate that read the lines it
expected and called a failing build green for hours. None was reported by a
viewer. Each was found by measuring something that looked fine.

Those cases — eighteen of them — and the five working rules that came out of
them are written up at
[darkflow.martincasais.com/notes](https://darkflow.martincasais.com/notes).
The short version: zero is a claim, the average hides the frame you notice,
and a test that no mutant can fail is not evidence.

## Recordings

`web/public/replay/mainnet-2026-09-03.json` is five minutes of mainnet from
2026-09-03: blocks 25,897,732–25,897,756, all twenty-five, 7,807 transactions
heard from two public endpoints, every row with the tip it paid. It is what the
page plays if the live feed is gone, and what `NEXT_PUBLIC_STREAM_SOURCE=replay`
plays on purpose. `pnpm capture` in `web/` makes another.

---

[Martín Casais](https://martincasais.com) · [@casaisdev](https://x.com/casaisdev)
