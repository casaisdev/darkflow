import { describe, expect, it } from "vitest";
import { createWorld } from "@/lib/canvas/world";
import { readout } from "@/lib/readout";
import { createSeenSet } from "@/lib/seen";
import { hashOf, resetHashes, tx } from "./helpers";

/**
 * The seen-set forgetting a live transaction is the one failure that turns
 * into private flow on screen with no trace on the canvas. The readout must
 * carry the count, and carry exactly the count — not a flag, not a cache.
 */
const NOW = 1_700_000_000_000;

function sampleWith(seen: ReturnType<typeof createSeenSet>) {
  return readout({
    world: createWorld({ maxEntities: 8 }),
    seen,
    ticks: [],
    recentRatios: [],
    axisSamples: 4096,
    axisBounds: { low: 1e8, high: 1e11 },
    view: { width: 1440, height: 900 },
    lastBlockAt: NOW,
    lastEventAt: NOW,
    subscribed: true,
    budgetReduced: false,
    now: NOW,
  });
}

describe("forgotten transactions reach the readout", () => {
  it("is zero while the set is under its cap", () => {
    resetHashes();
    const seen = createSeenSet({ warmupBlocks: 1, maxEntries: 4 });
    seen.addMany([tx({ hash: hashOf(1) }), tx({ hash: hashOf(2) })]);
    expect(seen.capacityEvictions()).toBe(0);
    expect(sampleWith(seen).forgotten).toBe(0);
  });

  it("is the number of live records the cap pushed out", () => {
    resetHashes();
    const seen = createSeenSet({ warmupBlocks: 1, maxEntries: 2 });
    seen.addMany([tx({ hash: hashOf(1) }), tx({ hash: hashOf(2) }), tx({ hash: hashOf(3) })]);
    expect(seen.capacityEvictions()).toBe(1);
    expect(sampleWith(seen).forgotten).toBe(1);
    seen.addMany([tx({ hash: hashOf(4) }), tx({ hash: hashOf(5) })]);
    expect(sampleWith(seen).forgotten).toBe(3);
  });
});
