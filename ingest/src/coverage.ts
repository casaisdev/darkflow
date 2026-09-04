/**
 * The ingest measuring its own coverage: of the
 * transactions in each block it emits, how many were in its pool first.
 *
 * This is the number that says whether the feed can carry the product's
 * claim. It used to be a script run for a night; now it is continuous, per
 * block and per hour, and `/state` publishes it. A coverage that falls at
 * some hours is the feed going blind, and the headline would be lying at
 * those hours unless someone can see this.
 *
 * Pure. Bounded: the last `recentBlocks` blocks and the last `hours` hourly
 * buckets.
 */
export type CoverageBlock = { number: number; rows: number; seen: number };

export type CoverageSnapshot = {
  lastBlock: (CoverageBlock & { pct: number | null }) | null;
  recent: { blocks: number; rows: number; seen: number; pct: number | null };
  perHour: { hourStart: string; blocks: number; rows: number; seen: number; pct: number | null }[];
};

export type Coverage = {
  record(block: CoverageBlock, now: number): void;
  snapshot(): CoverageSnapshot;
};

const HOUR_MS = 3_600_000;

function pct(seen: number, rows: number): number | null {
  return rows > 0 ? Math.round((1000 * seen) / rows) / 10 : null;
}

export function createCoverage(options: { recentBlocks?: number; hours?: number } = {}): Coverage {
  const { recentBlocks = 10, hours = 24 } = options;
  const recent: CoverageBlock[] = [];
  const buckets = new Map<number, { blocks: number; rows: number; seen: number }>();

  return {
    record(block, now) {
      recent.push(block);
      if (recent.length > recentBlocks) recent.shift();
      const hour = Math.floor(now / HOUR_MS);
      const bucket = buckets.get(hour) ?? { blocks: 0, rows: 0, seen: 0 };
      bucket.blocks += 1;
      bucket.rows += block.rows;
      bucket.seen += block.seen;
      buckets.set(hour, bucket);
      for (const key of [...buckets.keys()].sort((a, b) => a - b)) {
        if (buckets.size <= hours) break;
        buckets.delete(key);
      }
    },
    snapshot() {
      const last = recent.at(-1) ?? null;
      const rows = recent.reduce((a, b) => a + b.rows, 0);
      const seen = recent.reduce((a, b) => a + b.seen, 0);
      return {
        lastBlock: last ? { ...last, pct: pct(last.seen, last.rows) } : null,
        recent: { blocks: recent.length, rows, seen, pct: pct(seen, rows) },
        perHour: [...buckets.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([hour, b]) => ({ hourStart: new Date(hour * HOUR_MS).toISOString(), ...b, pct: pct(b.seen, b.rows) })),
      };
    },
  };
}
