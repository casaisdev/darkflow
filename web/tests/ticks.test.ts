import { describe, expect, it } from "vitest";
import { thinTicks, type FeeTick } from "@/lib/canvas/layout";

const tick = (height: number, ruled = false): FeeTick => ({ gwei: height * 100, height, ruled });

describe("numerals thinned to the chamber's height", () => {
  it("keeps every tick when the chamber is tall enough for all of them", () => {
    const ticks = [tick(0.1), tick(0.2, true), tick(0.3), tick(0.5, true)];
    expect(thinTicks(ticks, 560)).toEqual(ticks); // 56px apart at the closest
  });

  it("drops numerals that would touch, keeping the ruled ones first", () => {
    // 220px chamber: 0.04 apart is 8.8px, under a numeral's height.
    const ticks = [tick(0.10), tick(0.14, true), tick(0.18), tick(0.22), tick(0.30, true)];
    const kept = thinTicks(ticks, 220);
    expect(kept.map((t) => t.height)).toEqual([0.14, 0.22, 0.3]);
    // The ruled 0.14 survives and the unruled 0.10 beside it does not.
    expect(kept.some((t) => t.height === 0.1)).toBe(false);
  });

  it("returns the axis order whatever the priority did", () => {
    const ticks = [tick(0.05), tick(0.5, true), tick(0.2), tick(0.9, true)];
    expect(thinTicks(ticks, 400).map((t) => t.height)).toEqual([0.05, 0.2, 0.5, 0.9]);
  });

  it("with no room at all, keeps one numeral per gap and never zero", () => {
    const ticks = Array.from({ length: 20 }, (_, i) => tick(i / 20, i % 5 === 0));
    const kept = thinTicks(ticks, 100, 14);
    expect(kept.length).toBeGreaterThan(0);
    for (let i = 1; i < kept.length; i++) {
      expect((kept[i]!.height - kept[i - 1]!.height) * 100).toBeGreaterThanOrEqual(14);
    }
  });
});
