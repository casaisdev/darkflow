/**
 * How much rendering this device can actually afford.
 *
 * Deliberately not a breakpoint. A 2020 phone and a 2015 laptop can report the
 * same viewport width and have nothing else in common, and a narrow window on a
 * workstation is not a phone at all. What matters is capacity, so that is what
 * gets measured.
 *
 * ## What is reduced, and what never is
 *
 * Only the **render** scales down: fewer entities on screen, a lower device
 * pixel ratio. The matching does not. The seen-set keeps its full window, every
 * arrival is still classified, and the ghost ratio a phone reports is the same
 * number a desktop reports. Reducing what is drawn is a rendering budget;
 * reducing what is matched would change the answer.
 */

export type Capability = {
  /** Starting entity cap. The governor moves it from here. */
  maxEntities: number;
  /** Device pixel ratio ceiling. */
  maxDpr: number;
  /** Radius multiplier, so a smaller field still reads at a smaller size. */
  markScale: number;
  /** Why these numbers, for the record. */
  reason: string;
};

const DESKTOP: Omit<Capability, "reason"> = {
  maxEntities: 300,
  maxDpr: 2,
  markScale: 1.8,
};

/**
 * Reads the hints the platform offers. They are coarse and occasionally absent,
 * which is fine — they only choose the starting point. The governor corrects
 * from there using frames that actually happened.
 */
export function detectCapability(): Capability {
  if (typeof navigator === "undefined") {
    return { ...DESKTOP, reason: "no navigator; assuming desktop" };
  }

  const cores = navigator.hardwareConcurrency ?? 8;
  // Chromium-only, absent elsewhere. Treated as a hint, never as a gate.
  const memory =
    (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const dpr = window.devicePixelRatio || 1;

  // A high-DPR coarse-pointer device with few cores is a phone, whatever its
  // CSS width says, and its fill rate is the binding constraint.
  const constrained = coarse && (cores <= 6 || memory <= 4 || dpr >= 2.5);

  if (constrained) {
    return {
      maxEntities: 90,
      maxDpr: 1.5,
      // Fewer marks over a smaller screen: each has to carry more.
      markScale: 2.4,
      reason: `constrained: cores=${cores} memory=${memory} dpr=${dpr} coarse=${coarse}`,
    };
  }
  if (cores <= 4) {
    return {
      maxEntities: 160,
      maxDpr: 1.5,
      markScale: 2,
      reason: `low core count: cores=${cores}`,
    };
  }
  return { ...DESKTOP, reason: `cores=${cores} memory=${memory} dpr=${dpr}` };
}

export type Governor = {
  /**
   * Feed it a measured frame rate and the slowest single frame in that same
   * window; it returns the entity cap to use.
   */
  observe(fps: number, maxFrameMs: number, currentCap: number): number;
  /** Whether the cap has been reduced from the starting point. */
  reduced(): boolean;
};

/** Below this the animation stops reading as continuous. */
const FLOOR_FPS = 45;
/** Above this there is headroom to give some back. */
const COMFORT_FPS = 56;
/**
 * A single frame this slow reads as a stutter, whatever the window's average
 * says. Twice the 16.7ms budget of one 60fps frame: a device stuttering
 * twice a second while everything else renders at 60fps still averages a
 * healthy fps — 27 fast frames and one slow one over a 400ms window is
 * ~68fps — so the average alone would never catch it. Measured on an
 * emulated mid/low-end phone (CPU throttled 6x): p95 27ms, max 107ms, ~1.8
 * frames/s over this line, while the windowed average held at 67fps and
 * never tripped `FLOOR_FPS`.
 */
const JANK_FRAME_MS = 33;
const MIN_ENTITIES = 60;

/**
 * Adjusts the entity cap from frames that actually rendered.
 *
 * Hardware hints choose the starting point; this corrects it. A device that
 * lies about its capability, or one that is simply busy with something else,
 * gets the same treatment either way — the only evidence it uses is whether
 * frames arrived on time, judged two ways: the window's average fps, and
 * whether any single frame in it stuttered. Either counts as a slow window.
 * `fast` is only ever checked once `slow` is known false, and `slow` already
 * covers a stutter — so a window can only count toward giving capacity back
 * once it is both comfortably fast *and* stutter-free, without a separate
 * check saying so twice.
 */
export function createGovernor(ceiling: number): Governor {
  let slowRuns = 0;
  let fastRuns = 0;
  let hasReduced = false;

  return {
    observe(fps, maxFrameMs, currentCap) {
      // The first samples after a mount are noisy; a zero means no frames at
      // all, which is a hidden tab rather than a slow one.
      if (fps <= 0) return currentCap;

      const slow = fps < FLOOR_FPS || maxFrameMs > JANK_FRAME_MS;
      const fast = fps > COMFORT_FPS;
      if (slow) {
        slowRuns += 1;
        fastRuns = 0;
      } else if (fast) {
        fastRuns += 1;
        slowRuns = 0;
      } else {
        slowRuns = 0;
        fastRuns = 0;
      }

      if (slowRuns >= 3) {
        slowRuns = 0;
        hasReduced = true;
        return Math.max(MIN_ENTITIES, Math.round(currentCap * 0.75));
      }
      // Given back slowly, so a device on the edge does not oscillate.
      if (fastRuns >= 10 && currentCap < ceiling) {
        fastRuns = 0;
        return Math.min(ceiling, Math.round(currentCap * 1.15) + 1);
      }
      return currentCap;
    },
    reduced: () => hasReduced,
  };
}
