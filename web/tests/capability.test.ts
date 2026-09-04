import { describe, expect, it } from "vitest";
import { createGovernor } from "@/lib/capability";

/**
 * `observe(fps, maxFrameMs, currentCap)`. Every case feeds a clean run of
 * identical samples so the three-in-a-row hysteresis is exercised on
 * purpose, not incidentally.
 */
const GOOD = { fps: 60, maxFrameMs: 12 }; // comfortably fast, no stutter
const SLOW_AVG = { fps: 30, maxFrameMs: 20 }; // low average, no single stutter
const JANKY = { fps: 60, maxFrameMs: 60 }; // healthy average, one bad frame

function drive(
  governor: ReturnType<typeof createGovernor>,
  sample: { fps: number; maxFrameMs: number },
  times: number,
  cap: number,
): number {
  for (let i = 0; i < times; i++) cap = governor.observe(sample.fps, sample.maxFrameMs, cap);
  return cap;
}

describe("the governor reduces on a low average, same as before", () => {
  it("does nothing for two slow samples, then cuts on the third", () => {
    const governor = createGovernor(300);
    let cap = 300;
    cap = drive(governor, SLOW_AVG, 2, cap);
    expect(cap).toBe(300);
    expect(governor.reduced()).toBe(false);
    cap = governor.observe(SLOW_AVG.fps, SLOW_AVG.maxFrameMs, cap);
    expect(cap).toBe(225); // 75%
    expect(governor.reduced()).toBe(true);
  });
});

describe("the governor also reduces on a stutter the average hides", () => {
  it("cuts after three windows with a slow single frame, average untouched", () => {
    const governor = createGovernor(300);
    const cap = drive(governor, JANKY, 3, 300);
    expect(cap).toBe(225);
    expect(governor.reduced()).toBe(true);
  });

  it("matches the measured 6x-throttle shape: ~68fps average, occasional 100ms+ frames", () => {
    const governor = createGovernor(300);
    const measured = { fps: 67, maxFrameMs: 107 };
    expect(drive(governor, measured, 2, 300)).toBe(300);
    expect(governor.observe(measured.fps, measured.maxFrameMs, 300)).toBe(225);
  });

  it("a single stray stutter does not reduce anything", () => {
    const governor = createGovernor(300);
    let cap = governor.observe(JANKY.fps, JANKY.maxFrameMs, 300);
    cap = governor.observe(GOOD.fps, GOOD.maxFrameMs, cap);
    cap = governor.observe(JANKY.fps, JANKY.maxFrameMs, cap);
    expect(cap).toBe(300);
    expect(governor.reduced()).toBe(false);
  });
});

describe("giving capacity back needs both a comfortable average and no stutter", () => {
  it("restores after ten clean windows", () => {
    const governor = createGovernor(300);
    let cap = drive(governor, SLOW_AVG, 3, 300); // 225, reduced
    cap = drive(governor, GOOD, 9, cap);
    expect(cap).toBe(225); // ninth window: not yet
    cap = governor.observe(GOOD.fps, GOOD.maxFrameMs, cap);
    expect(cap).toBeGreaterThan(225); // tenth: given back
  });

  it("a fast average with a lingering stutter never counts toward recovery", () => {
    const governor = createGovernor(300);
    const cap = drive(governor, SLOW_AVG, 3, 300); // 225, reduced
    // Fast on average, but every window still drops a frame past the jank
    // line: the old criterion (fps alone) would have called this comfortable
    // and started restoring capacity to a device that is visibly still
    // stuttering. It still counts as slow, so the cap only ever falls or
    // holds — it must never climb back past what a stutter-free run earns.
    const fastButJanky = { fps: 60, maxFrameMs: 40 };
    let capacity = cap;
    for (let i = 0; i < 20; i++) {
      const next = governor.observe(fastButJanky.fps, fastButJanky.maxFrameMs, capacity);
      expect(next).toBeLessThanOrEqual(capacity);
      capacity = next;
    }
  });

  it("recovers once the stutter actually stops, not just when the average looks fine", () => {
    const governor = createGovernor(300);
    let cap = drive(governor, SLOW_AVG, 3, 300); // 225, reduced
    const fastButJanky = { fps: 60, maxFrameMs: 40 };
    cap = drive(governor, fastButJanky, 9, cap); // still stuttering: no recovery
    const stillReduced = cap;
    cap = drive(governor, GOOD, 10, cap); // the stutter is gone now
    expect(cap).toBeGreaterThan(stillReduced);
  });
});

describe("neither reduces nor restores in the middle band", () => {
  it("an fps between the floor and comfort line, with no stutter, counts as neither slow nor fast", () => {
    const governor = createGovernor(300);
    let cap = drive(governor, SLOW_AVG, 3, 300); // 225, reduced
    // 50fps sits strictly between FLOOR_FPS (45) and COMFORT_FPS (56); this
    // must reset the run counters like any other unremarkable window, not
    // quietly count toward giving capacity back.
    cap = drive(governor, { fps: 50, maxFrameMs: 10 }, 50, cap);
    expect(cap).toBe(225);
  });
});

describe("edge cases carried over from the fps-only governor", () => {
  it("ignores a zero fps sample (hidden tab) without touching the run counters", () => {
    const governor = createGovernor(300);
    let cap = drive(governor, SLOW_AVG, 2, 300);
    cap = governor.observe(0, 0, cap); // a hidden-tab sample in the middle of a slow run
    cap = governor.observe(SLOW_AVG.fps, SLOW_AVG.maxFrameMs, cap);
    expect(cap).toBe(225); // the interrupted run still completed
  });

  it("never cuts below the floor", () => {
    const governor = createGovernor(300);
    let cap = 65;
    for (let i = 0; i < 30; i++) cap = drive(governor, SLOW_AVG, 3, cap);
    expect(cap).toBeGreaterThanOrEqual(60);
  });

  it("never restores past the ceiling", () => {
    const governor = createGovernor(100);
    let cap = 100;
    for (let i = 0; i < 100; i++) cap = governor.observe(GOOD.fps, GOOD.maxFrameMs, cap);
    expect(cap).toBeLessThanOrEqual(100);
  });
});
