/**
 * Single source of truth for the deployed origin. `layout.tsx`, `robots.ts` and
 * `sitemap.ts` all need it, and a mismatch between them is invisible until a
 * crawler complains.
 */
export const SITE_URL = "https://darkflow.martincasais.com";
export const SITE_NAME = "DARKFLOW";
/* A tagline is the one line of copy that outlives the page it was written
   for: it is what a link unfurls to. This one is true under every source,
   live, recorded or generated. */
export const TAGLINE = "The Ethereum mempool, and what skips it";
/**
 * The document title, and the name the manifest and the share card use.
 * A middle dot, matching the `%s · DARKFLOW` template on inner pages, so a
 * tab, an unfurl and a home-screen icon all read the same way.
 */
export const TITLE = `${SITE_NAME} · ${TAGLINE}`;
/**
 * Under 160 characters, which is where search results cut a description.
 * It says what the reader sees and what the number means, in that order.
 */
export const DESCRIPTION =
  "Watch the Ethereum mempool live and see which transactions land in a block without ever being announced to it: private order flow, bundles, MEV.";
export const AUTHOR = {
  name: "Martín Casais",
  url: "https://martincasais.com",
  handle: "@casaisdev",
  x: "https://x.com/casaisdev",
} as const;
