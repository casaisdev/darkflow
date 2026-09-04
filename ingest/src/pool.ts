/**
 * The ingest's memory of what it has announced.
 *
 * Two jobs only: deduplication, because a feed may repeat a hash, and the
 * counts `/state` reports. It is **not** a snapshot and must never be
 * sent as one.
 *
 * Bounded by age, oldest first — the Map keeps insertion order and entries
 * are inserted as they are observed, so pruning is a walk from the front that
 * stops at the first live entry. The hard cap is a backstop; when it binds it
 * is counted, because a cap binding before the TTL means the process is
 * forgetting live transactions, and that is a sizing bug to see, not to hide.
 */
import type { Hex } from "../../web/types/stream.ts";

export type Pool = {
  /** Remembers the hash. `false` if it was already known. */
  add(hash: Hex, observedAt: number): boolean;
  has(hash: Hex): boolean;
  /** Forgets everything observed before `now - ttlMs`. Returns how many. */
  prune(now: number): number;
  size(): number;
  capEvictions(): number;
};

export function createPool(options: { ttlMs: number; max: number }): Pool {
  const { ttlMs, max } = options;
  if (!(ttlMs > 0) || !(max >= 1)) throw new Error("pool: ttlMs must be > 0 and max >= 1");
  const seen = new Map<Hex, number>();
  let capEvictions = 0;
  return {
    add(hash, observedAt) {
      if (seen.has(hash)) return false;
      seen.set(hash, observedAt);
      if (seen.size > max) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
        capEvictions += 1;
      }
      return true;
    },
    has: (hash) => seen.has(hash),
    prune(now) {
      const cutoff = now - ttlMs;
      let removed = 0;
      for (const [hash, at] of seen) {
        if (at >= cutoff) break;
        seen.delete(hash);
        removed += 1;
      }
      return removed;
    },
    size: () => seen.size,
    capEvictions: () => capEvictions,
  };
}
