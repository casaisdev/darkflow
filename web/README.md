# web

The instrument, and the route handlers that feed it. What the project is and
why is in the [root README](../README.md); this file is the part you need with
the code open.

```bash
pnpm install
pnpm dev        # http://localhost:3000
pnpm lint
pnpm test
pnpm build
```

The first build needs the network: `next/font` self-hosts Geist Mono, and the
Open Graph card fetches IBM Plex Mono for satori at build time.

## Sources

`NEXT_PUBLIC_STREAM_SOURCE` picks one at build time; it is inlined, so a
change is a rebuild (`.env.example` explains every variable).

| Source | What it is | Status dot |
| --- | --- | --- |
| `synthetic` | Seeded generator, the shape of mainnet. The reference every visual constant was calibrated against. | `simulated data` |
| `replay` | A recording from `public/replay/`, played at its recorded pace; ends rather than loops. | `recorded` |
| `sse` | The live feed: `/api/stream` in production, or `pnpm exec node scripts/fake-ingest.mjs` locally — the contract served from a generator, with a control endpoint for breaking it on purpose. | `live` |

A recording can be driven, because it is a record and not the chain: pause
(space), next block (n), land again (r), copy link, and `?block=<number>`
opens it at that block. Calibration runs at ×6 on a recording and the status
says so; a live source cannot be sped up and will not be.

The live feed comes from `app/api/[endpoint]/route.ts`, one handler for
`/api/stream`, `/api/state` and `/api/health` that runs the ingest core from
`../ingest` inside the site's functions. One file on purpose: on Vercel each
route file is its own function with its own instance, and the core lives in
module state, so `/api/state` can only describe the stream it shares a
function with. They need
`UPSTREAM_WS_URL` in the server environment and nothing else; the stream limit
is derived from the route's `maxDuration` so the two cannot drift.

## Where things live

| Path | What |
| --- | --- |
| `app/globals.css` | The design system: tokens, the four rules, the small-screen blocks. Start here. |
| `app/notes/page.tsx` | Method, failures and measurements, as a page. |
| `types/stream.ts` | The wire contract with the ingest. Versioned. |
| `lib/canvas/world.ts` | The simulation: a pure `step(state, dt, now)`. |
| `lib/canvas/draw.ts` | Rendering, and the instrument's geometry — wide and portrait. |
| `lib/canvas/engine.ts` | The one animation loop, resize, and frame sampling. |
| `lib/canvas/layout.ts` | The fee axis: calibration, ticks, the floor band. |
| `lib/seen.ts` | The seen-set: what the mempool announced, and the never-seen verdict. |
| `lib/blocks.ts` | The block ledger — new, duplicate, replacement — and `ingestBlock`. |
| `lib/readout.ts` | Every figure on the panel, and when it is null. |
| `lib/capability.ts` | Render budget from hardware hints, corrected by frames that actually rendered. |
| `lib/stream/` | The three sources behind one `subscribe`, the SSE parser, the coverage poll. |
| `lib/replay/format.ts` | The recording format, shared with `scripts/capture-replay.mjs`. |
| `app/api/[endpoint]/route.ts` | The live feed: stream, state and health from one function. |
| `lib/ingest-core.ts` | The one place an ingest core is created, for that route. |
| `scripts/` | Fake ingest, recording capture, soak, favicon. |
| `tests/` | 399 tests. The recording in `tests/fixtures/` pins the axis-stability numbers. |

## Design rules

Tokens are declared twice on purpose in `app/globals.css`: on `:root` under
short names, so the canvas can read them from JS, and in `@theme inline`,
mapped onto Tailwind namespaces. Four rules the code holds to, spelled out at
the top of that file:

1. `--ghost` means private flow and nothing else. Never a button, a link, a
   hover, a spinner.
2. Fee maps to luminance and height; age maps to alpha. The two never cross.
3. The background is never `#000`.
4. Every real-time number is `tabular-nums`.

Dark only. One face, Geist Mono, whose figures were measured tabular before
the swap. Departure Mono is the intended face and is wired up, commented out,
in `app/fonts.ts` for the day the file exists.

Below 1024px the instrument is laid out for a phone rather than shrunk from a
desk: portrait proportions on the canvas, a stacked panel, the inspector as a
sheet, axis numerals that thin themselves to the chamber's height. Measured at
390, 430, 768 and sideways at 844×390.
