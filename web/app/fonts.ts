import { Geist_Mono } from "next/font/google";
// import localFont from "next/font/local";

/**
 * DARKFLOW typography.
 *
 * One voice: the mono sets everything, the wordmark included. Archivo was here
 * for the wordmark alone — a whole family loaded to set eight characters in a
 * different accent from every other word on the page.
 *
 * The intended mono is Departure Mono, which is not on Google Fonts and needs
 * the font file. It is wired up below and commented out: once
 * `app/fonts/DepartureMono-Regular.woff2` exists, uncomment the block and flip
 * the single marked line at the bottom of this file.
 */

/**
 * The face this instrument reads in.
 *
 * Rule 4 puts `tabular-nums` on every real-time number, and a face whose
 * figures are not tabular makes those numbers jump on every update. So the
 * swap off IBM Plex Mono was gated on measuring it rather than trusting it:
 * rendered at 100px in the target browser, all ten digits came out at exactly
 * 60px both with `font-variant-numeric: tabular-nums` and without it, and 0,
 * O, 1 and l all share that advance. It is monospaced throughout, so rule 4's
 * declarations stay correct and cost nothing.
 */
const geistMono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: "normal",
  display: "swap",
  variable: "--font-mono-face",
});

/** Target mono face. Needs the file in `app/fonts/`. */
// const departureMono = localFont({
//   src: "./fonts/DepartureMono-Regular.woff2",
//   weight: "400",
//   style: "normal",
//   display: "swap",
//   variable: "--font-mono-face",
//   adjustFontFallback: false,
// });

// ─── Swapping the mono means changing this one line ──────────────────────────
export const mono = geistMono;
