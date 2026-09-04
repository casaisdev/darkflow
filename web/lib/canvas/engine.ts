import { geometryFor, render, WIDE, type DrawOptions, type FeeScale, type View } from "@/lib/canvas/draw";
import { step, type WorldState } from "@/lib/canvas/world";
import type { Palette } from "@/lib/tokens";

/**
 * The only thing in the project that owns a clock.
 *
 * Deliberately thin: it resizes the backing store, drives `requestAnimationFrame`,
 * and calls `step` then `render`. All the behaviour lives in those two, which
 * are pure — so the interesting parts can be exercised without a frame ever
 * being scheduled.
 */

/**
 * Device pixel ratio ceiling.
 *
 * A full-screen canvas at DPR 3 is nine times the fill rate of DPR 1 for
 * differences nobody can see on a field of one-pixel marks. Two is the point
 * past which this stops buying anything.
 */
export const MAX_DPR = 2;

/**
 * Longest delta a single step may represent.
 *
 * `requestAnimationFrame` does not fire while the tab is hidden, so returning
 * to a backgrounded tab hands over a delta of however long the user was away.
 * Stepping that at once makes the field jump. Clamped, the simulation simply
 * misses the time it was not running, which is the honest outcome.
 */
const MAX_DELTA_MS = 100;

export type EngineOptions = {
  canvas: HTMLCanvasElement;
  world: WorldState;
  /**
   * Read per frame rather than captured, so calibration can swap in a
   * desaturated palette without tearing the engine down. The canvas
   * desaturates its own colours; putting a CSS filter over a surface that
   * repaints sixty times a second would be paid for on every one of them.
   */
  palette: () => Palette;
  feeScale: FeeScale;
  /** Also read per frame: whether ghosts may be drawn changes mid-session. */
  drawOptions?: () => DrawOptions;
  split?: number;
  /** Runs before each step. Where the fee window gets resorted, at a few Hz. */
  beforeStep?: (frameMs: number) => void;
  /** Called when the tab is hidden or shown, so the source can pause too. */
  onVisibilityChange?: (visible: boolean) => void;
  /** Frame timing, sampled for the instrument chrome. Never per frame. */
  onSample?: (sample: EngineSample) => void;
  sampleIntervalMs?: number;
  /**
   * The clock every age is measured on. Defaults to `Date.now`, which matches
   * `PendingTx.firstSeen` from a live source. A consumer that can pause hands
   * in a clock that stops, so a held picture does not keep fading.
   */
  clock?: () => number;
};

export type EngineSample = {
  fps: number;
  /** The slowest single frame in this window, ms. See `maxFrameMsInWindow`. */
  maxFrameMs: number;
  entities: number;
  notSampled: number;
  evictedFromTop: number;
  culledByAge: number;
};

export type Engine = {
  start(): void;
  stop(): void;
  /**
   * Holds the simulation. Frames still render — the reader can still point
   * at things — but nothing drifts, flies or ages. Pair it with a stopped
   * clock, or the ages will jump when it resumes.
   */
  setPaused(paused: boolean): void;
  /** Current view, for tests that want to reason in pixels. */
  view(): View;
  /** Renders one frame immediately, without scheduling. For verification. */
  renderOnce(now: number): void;
};

export function createEngine(options: EngineOptions): Engine {
  const {
    canvas,
    world,
    palette,
    feeScale,
    drawOptions,
    /**
     * Where the populated field ends, as a fraction of the width.
     *
     * Lowered from 0.62 after measuring: the field carried 0.32% ink coverage
     * across 62% of the screen while the block column carried 78% across 11%.
     * Narrowing the field also lengthens the flight rather than shortening it —
     * mean travel 973px → 1060px, and the shortest flight, which is the one at
     * risk of being unreadable, 422px → 623px.
     */
    split: splitOverride,
    beforeStep,
    onVisibilityChange,
    onSample,
    sampleIntervalMs = 400,
    clock = Date.now,
  } = options;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("[engine] 2d context unavailable");

  let view: View = { width: 1, height: 1, dpr: 1, split: splitOverride ?? WIDE.split, g: WIDE };
  let frame = 0;
  let lastFrameMs = 0;
  let running = false;
  let paused = false;

  let framesSinceSample = 0;
  let lastSampleMs = 0;
  /**
   * The slowest single frame in the current sampling window.
   *
   * A device stuttering twice a second while everything else renders at
   * 60fps still averages a healthy fps: 27 fast frames and 1 slow one over a
   * 400ms window reads as ~68fps, well above the governor's floor. The
   * average hides exactly the kind of frame a reader notices. This is
   * measured so the governor does not have to wait for the average to fail
   * before it reacts to a stutter that is already visible.
   */
  let maxFrameMsInWindow = 0;

  function resize(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    // The proportions follow the width: a phone held upright gets the
    // portrait instrument, everything else the wide one.
    const g = geometryFor(width, height);
    view = { width, height, dpr, split: splitOverride ?? g.split, g };

    const backingWidth = Math.round(width * dpr);
    const backingHeight = Math.round(height * dpr);
    // Assigning width/height clears the canvas, so only do it on real change.
    if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
      canvas.width = backingWidth;
      canvas.height = backingHeight;
    }
  }

  const observer = new ResizeObserver(resize);

  function renderOnce(now: number): void {
    /**
     * Loud, because the alternative is silent and looks fine.
     *
     * `now` reaches `ageOf`, which reaches `exponentialDecay`, which reaches
     * `ctx.globalAlpha`. A non-finite value propagates all the way down and
     * then vanishes: the canvas spec says an assignment of a non-finite value
     * to `globalAlpha` is **ignored**, so the context silently keeps whatever
     * it had — 1 — and every emissive mark renders at full strength with no
     * age decay at all.
     *
     * That happened. Every verification capture of the field taken through the
     * dev seam called `renderOnce()` with no argument, and every one of them
     * showed a field roughly 2.6x too bright in which a thirty-second-old trace
     * was indistinguishable from a new one. No error, no warning, and a
     * perfectly plausible picture — which is the failure mode this codebase
     * keeps producing and the reason for throwing here rather than clamping.
     *
     * The real loop passes `Date.now()`, matching `PendingTx.firstSeen`, so
     * this cannot fire in production. It exists for the seam.
     */
    if (!Number.isFinite(now)) {
      throw new TypeError(
        `[engine] renderOnce(now) needs finite ms since epoch, got ${String(now)}. ` +
          "A non-finite value silently disables alpha decay instead of failing.",
      );
    }
    render(ctx!, world, palette(), view, now, feeScale, drawOptions?.());
  }

  function loop(frameMs: number): void {
    if (!running) return;
    frame = requestAnimationFrame(loop);

    const delta = Math.min(MAX_DELTA_MS, frameMs - lastFrameMs);
    lastFrameMs = frameMs;
    maxFrameMsInWindow = Math.max(maxFrameMsInWindow, delta);

    beforeStep?.(frameMs);

    const now = clock();
    if (!paused) step(world, delta, now);
    renderOnce(now);

    framesSinceSample += 1;
    if (onSample && frameMs - lastSampleMs >= sampleIntervalMs) {
      const seconds = (frameMs - lastSampleMs) / 1000;
      onSample({
        fps: framesSinceSample / seconds,
        maxFrameMs: maxFrameMsInWindow,
        entities: world.entities.length,
        notSampled: world.notSampled,
        evictedFromTop: world.evictedFromTop,
        culledByAge: world.culledByAge,
      });
      framesSinceSample = 0;
      maxFrameMsInWindow = 0;
      lastSampleMs = frameMs;
    }
  }

  function handleVisibility(): void {
    const visible = document.visibilityState === "visible";
    onVisibilityChange?.(visible);
    if (visible) {
      if (running && frame === 0) {
        // Reset the clock, or the first delta covers the whole absence.
        lastFrameMs = performance.now();
        lastSampleMs = lastFrameMs;
        frame = requestAnimationFrame(loop);
      }
    } else if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  return {
    start() {
      if (running) return; // Strict Mode remounts; starting twice is a bug.
      running = true;
      resize();
      observer.observe(canvas);
      document.addEventListener("visibilitychange", handleVisibility);
      lastFrameMs = performance.now();
      lastSampleMs = lastFrameMs;
      if (document.visibilityState === "visible") {
        frame = requestAnimationFrame(loop);
      }
    },
    stop() {
      running = false;
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      observer.disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
    },
    setPaused(next) {
      paused = next;
    },
    view: () => view,
    renderOnce,
  };
}
