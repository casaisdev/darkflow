import { describe, expect, it } from "vitest";
import { createCoverage } from "../src/coverage.ts";

const HOUR = 3_600_000;

describe("coverage", () => {
  it("reports the last block, the recent window and the hour, as shares", () => {
    const c = createCoverage({ recentBlocks: 2, hours: 24 });
    c.record({ number: 1, rows: 100, seen: 50 }, 0);
    c.record({ number: 2, rows: 200, seen: 120 }, 1000);
    c.record({ number: 3, rows: 100, seen: 90 }, 2000);
    const s = c.snapshot();
    expect(s.lastBlock).toEqual({ number: 3, rows: 100, seen: 90, pct: 90 });
    // The recent window holds the last two blocks only.
    expect(s.recent).toEqual({ blocks: 2, rows: 300, seen: 210, pct: 70 });
    expect(s.perHour).toEqual([{ hourStart: new Date(0).toISOString(), blocks: 3, rows: 400, seen: 260, pct: 65 }]);
  });

  it("keeps only the newest hours and says null where there were no rows", () => {
    const c = createCoverage({ hours: 2 });
    c.record({ number: 1, rows: 10, seen: 1 }, 0);
    c.record({ number: 2, rows: 10, seen: 2 }, HOUR);
    c.record({ number: 3, rows: 0, seen: 0 }, 2 * HOUR);
    const s = c.snapshot();
    expect(s.perHour.map((h) => h.hourStart)).toEqual([new Date(HOUR).toISOString(), new Date(2 * HOUR).toISOString()]);
    expect(s.perHour[1]!.pct).toBeNull();
    expect(s.lastBlock!.pct).toBeNull();
  });

  it("starts empty", () => {
    expect(createCoverage().snapshot()).toEqual({ lastBlock: null, recent: { blocks: 0, rows: 0, seen: 0, pct: null }, perHour: [] });
  });
});
