/**
 * Single source of truth for the deployed origin. `layout.tsx`, `robots.ts` and
 * `sitemap.ts` all need it, and a mismatch between them is invisible until a
 * crawler complains.
 */
export const SITE_URL = "https://darkflow.martincasais.com";
export const SITE_NAME = "DARKFLOW";
/* Not "in real time". The page runs on a generator or on a recording until
   the ingest exists, and a tagline is the one line of copy that outlives the
   page it was written for — it is what a link unfurls to. This one is true
   under every source. */
export const TAGLINE = "The Ethereum mempool, and what skips it";
export const DESCRIPTION =
  "Real-time visualizer for the Ethereum L1 mempool. Every block reveals what landed without this feed ever seeing it pending: private order flow, bundles, and whatever propagation missed.";
