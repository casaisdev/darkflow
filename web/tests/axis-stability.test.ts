import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeTx, type Recording } from "@/lib/replay/format";
import { createQuantileScale } from "@/lib/quantile";
import { createFeeLayout } from "@/lib/canvas/layout";
import { effectivePriorityFee } from "@/lib/fees";

/**
 * The fee axis, on real traffic, does not jitter.
 *
 * The worry was live-specific: the axis is p1..p99 of a rolling window,
 * rebuilt every 300ms, and a bound that dances makes every tick a label for a
 * height that keeps moving. Damping was on the table — a first-order filter
 * over the log bounds — until this measured what there was to damp.
 *
 * Measured on the mainnet fixture (7,640 transactions, 24 blocks, five
 * minutes, base fee moving as EIP-1559 moves it): the bounds were
 * bit-identical across all 968 rebuilds. Not stable-ish — identical. The low
 * end is pinned by the mass of zero-tip transactions (p1 lands in it, and the
 * MIN_TIP_WEI clamp holds the bound at 0.001 gwei), and the high end sat on
 * the 2 gwei default that a visible share of wallets offer, exactly. Damping
 * would have been a rendering answer to a market question nobody asked.
 *
 * So this is the regression guard instead: if a change to the window, the
 * percentiles or the layout makes the axis move on traffic where it measurably
 * did not, that change is renegotiating something calibrated, and it fails
 * here rather than as jitter on screen.
 *
 * The fixture is what makes this assertable at all. Live traffic cannot be a
 * test; a recording of it is deterministic and this suite already ships one.
 */
describe("axis stability on recorded mainnet traffic", () => {
  it("holds its bounds still while the recording plays", () => {
    const recording = JSON.parse(
      readFileSync("tests/fixtures/mainnet-2026-08-27.json", "utf8"),
    ) as Recording;
    const epoch = recording.meta.startedAt;

    const scale = createQuantileScale();
    const layout = createFeeLayout(scale);
    let baseFee = 12e9;

    const REBUILD_MS = 300;
    let nextRebuild = 0;
    let rebuilds = 0;
    let worstLowLog = 0;
    let worstHighLog = 0;
    let worstTickShift = 0;
    let last: { low: number; high: number } | null = null;
    let lastTicks: Map<number, number> | null = null;

    const rebuildAt = () => {
      scale.rebuild();
      layout.refresh();
      if (!layout.calibrated()) return;
      rebuilds += 1;
      const bounds = layout.bounds();
      const ticks = new Map(layout.ticks().map((t) => [t.gwei, t.height]));
      if (last && lastTicks) {
        worstLowLog = Math.max(
          worstLowLog,
          Math.abs(Math.log(bounds.low / last.low)),
        );
        worstHighLog = Math.max(
          worstHighLog,
          Math.abs(Math.log(bounds.high / last.high)),
        );
        for (const [gwei, height] of ticks) {
          const was = lastTicks.get(gwei);
          if (was !== undefined) {
            worstTickShift = Math.max(worstTickShift, Math.abs(height - was));
          }
        }
      }
      last = bounds;
      lastTicks = ticks;
    };

    for (const frame of recording.frames) {
      while (nextRebuild <= frame.t) {
        rebuildAt();
        nextRebuild += REBUILD_MS;
      }
      if (frame.kind === "block") {
        baseFee = frame.baseFeePerGas;
      } else {
        for (const row of frame.txs) {
          const tx = decodeTx(row, epoch);
          scale.push(effectivePriorityFee(tx.fees, baseFee));
        }
      }
    }

    // Enough rebuilds that stillness means something.
    expect(rebuilds).toBeGreaterThan(900);
    /**
     * The thresholds are deliberately looser than the measurement (which was
     * exactly zero): a different recording, or a legitimate widening of the
     * window, may move a bound a little without making the axis a bad
     * instrument. What must fail is jitter a reader could see — a persisting
     * tick moving more than ~1% of the chamber between two rebuilds, or a
     * bound stepping more than 5% in log space in 300ms.
     */
    expect(worstLowLog).toBeLessThan(0.05);
    expect(worstHighLog).toBeLessThan(0.05);
    expect(worstTickShift).toBeLessThan(0.01);
  });
});
