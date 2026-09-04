/**
 * The feed's own coverage, read from the ingest's state endpoint.
 *
 * The headline says what share of a block this feed never saw pending. A feed
 * that simply misses announcements would inflate that number and nothing on
 * the canvas could tell. The ingest measures itself against the same doubt:
 * of each block it emits, how many hashes were in its pool first. This
 * module fetches that figure so the page can show it next to the claim it
 * bounds.
 *
 * Pure except `fetchCoverage`, which is one GET.
 */

export type FeedCoverage = {
  /** Share of the last blocks' rows the feed had announced first, 0–100, or null with no blocks yet. */
  pct: number | null;
  /** How many blocks the share is over. */
  blocks: number;
  /** When it was read, ms since epoch. */
  at: number;
};

/**
 * The state endpoint next to a stream endpoint: `…/stream` → `…/state`.
 * `null` for anything else — a URL that is not the ingest's has no state to ask.
 */
export function stateUrlFor(streamUrl: string): string | null {
  if (!/\/stream$/.test(streamUrl)) return null;
  return streamUrl.replace(/\/stream$/, "/state");
}

/**
 * The coverage out of the ingest's state JSON, or `null` when the document
 * does not carry one. A missing figure is unknown, never zero.
 */
export function parseCoverage(json: unknown, at: number): FeedCoverage | null {
  if (typeof json !== "object" || json === null) return null;
  const coverage = (json as { coverage?: unknown }).coverage;
  if (typeof coverage !== "object" || coverage === null) return null;
  const recent = (coverage as { recent?: unknown }).recent;
  if (typeof recent !== "object" || recent === null) return null;
  const { blocks, pct } = recent as { blocks?: unknown; pct?: unknown };
  if (typeof blocks !== "number" || !Number.isInteger(blocks) || blocks < 0) return null;
  if (blocks === 0) return { pct: null, blocks: 0, at };
  if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return { pct, blocks, at };
}

export async function fetchCoverage(
  url: string,
  now: () => number = Date.now,
  fetchLike: (url: string, init: RequestInit) => Promise<{ ok: boolean; json(): Promise<unknown> }> = (u, i) => fetch(u, i),
): Promise<FeedCoverage | null> {
  try {
    const res = await fetchLike(url, { cache: "no-store" });
    if (!res.ok) return null;
    return parseCoverage(await res.json(), now());
  } catch {
    return null;
  }
}
