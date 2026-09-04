import type { Fees, Hex, PendingTx } from "@/types/stream";
import type { Palette, Rgb } from "@/lib/tokens";
import type { View } from "@/lib/canvas/draw";

/**
 * Fixtures and stubs shared by the suite.
 *
 * Nothing here fakes behaviour under test. The palette is arbitrary but
 * complete, the context records rather than simulates, and the hashes are a
 * counter — none of it can make an assertion pass that the real code would
 * fail.
 */

const GWEI = 1e9;

let counter = 0;
/** Deterministic, unique, and shaped like the real thing. */
export function hashOf(n: number = counter++): Hex {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

export function resetHashes(): void {
  counter = 0;
}

export function eip1559(tipGwei: number, capGwei: number): Fees {
  return {
    kind: "eip1559",
    maxPriorityFeePerGas: tipGwei * GWEI,
    maxFeePerGas: capGwei * GWEI,
  };
}

export function legacy(priceGwei: number): Fees {
  return { kind: "legacy", gasPrice: priceGwei * GWEI };
}

export function tx(overrides: Partial<PendingTx> = {}): PendingTx {
  return {
    hash: hashOf(),
    firstSeen: 1_700_000_000_000,
    gas: 21000,
    fees: eip1559(1, 30),
    ...overrides,
  };
}

const rgb = (r: number, g: number, b: number, a = 1): Rgb => ({ r, g, b, a });

/**
 * A complete palette with distinguishable channels.
 *
 * Every colour differs, so a test can assert *which* token was used from the
 * recorded fill string alone. A palette of identical greys would let a wrong
 * token pass.
 */
export const palette: Palette = {
  void: rgb(5, 7, 10),
  field: rgb(9, 12, 18),
  sunken: rgb(4, 6, 8),
  trace: [
    rgb(30, 40, 50),
    rgb(50, 70, 90),
    rgb(80, 110, 140),
    rgb(120, 160, 200),
    rgb(170, 210, 240),
    rgb(220, 240, 255),
  ],
  settled: rgb(43, 58, 74),
  settledHi: rgb(70, 97, 122),
  ghost: rgb(214, 122, 61),
  ghostCore: rgb(255, 160, 90),
  ghostHalo: rgb(214, 122, 61, 0.5),
  ghostSettled: rgb(176, 103, 58),
  ruleHair: rgb(20, 26, 34),
  rule: rgb(30, 40, 52),
  ruleLit: rgb(50, 66, 84),
  text: rgb(200, 210, 220),
  textNum: rgb(220, 230, 240),
  textDim: rgb(110, 120, 130),
  live: rgb(90, 200, 150),
  calib: rgb(200, 170, 90),
  dead: rgb(200, 80, 80),
};

export const view: View = { width: 1440, height: 900, dpr: 2, split: 0.62 };

export type DrawCall =
  | { op: "fillRect"; x: number; y: number; w: number; h: number; fill: string }
  | {
      op: "strokeRect";
      x: number;
      y: number;
      w: number;
      h: number;
      stroke: string;
    }
  | { op: "arc"; x: number; y: number; r: number; fill: string; alpha: number }
  | { op: "radialGradient"; x: number; y: number; r: number }
  | { op: "linearGradient" }
  | {
      op: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke: string;
      alpha: number;
    };

/**
 * A canvas context that records instead of painting.
 *
 * `render` is a pure function of its arguments, so a recorder is enough to
 * assert what it draws — no DOM, no canvas implementation, no image diffing.
 * `fillStyle` is captured at call time because the real code sets it before
 * each shape and the value at the end of the frame says nothing.
 */
export function recordingContext(): {
  ctx: CanvasRenderingContext2D;
  calls: DrawCall[];
} {
  const calls: DrawCall[] = [];
  let pendingArc: { x: number; y: number; r: number } | null = null;
  /** Every moveTo/lineTo pair of a path, flushed on stroke. Recording only
      the last one made four bracket corners look like one line, which cost an
      assertion its meaning. Still not a path implementation — curves and
      sub-paths are not used by `draw.ts` and are not modelled. */
  let segment: { x1: number; y1: number; x2: number; y2: number } | null = null;
  let pending: { x1: number; y1: number; x2: number; y2: number }[] = [];

  const gradient = { addColorStop() {} };

  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    setTransform() {},
    beginPath() {
      pendingArc = null;
      segment = null;
      pending = [];
    },
    moveTo(x: number, y: number) {
      if (segment) pending.push(segment);
      segment = { x1: x, y1: y, x2: x, y2: y };
    },
    lineTo(x: number, y: number) {
      if (segment) {
        segment.x2 = x;
        segment.y2 = y;
      }
    },
    stroke() {
      if (segment) pending.push(segment);
      segment = null;
      for (const line of pending) {
        calls.push({
          op: "line",
          ...line,
          stroke: String(ctx.strokeStyle),
          alpha: Number(ctx.globalAlpha),
        });
      }
      pending = [];
    },
    arc(x: number, y: number, r: number) {
      pendingArc = { x, y, r };
    },
    fill() {
      if (pendingArc) {
        calls.push({
          op: "arc",
          ...pendingArc,
          fill: String(ctx.fillStyle),
          // Recorded because the emissive field carries its whole reading in
          // alpha: fee is the colour, age and entry are the alpha.
          alpha: Number(ctx.globalAlpha),
        });
        pendingArc = null;
      }
    },
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ op: "fillRect", x, y, w, h, fill: String(ctx.fillStyle) });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      calls.push({
        op: "strokeRect",
        x,
        y,
        w,
        h,
        stroke: String(ctx.strokeStyle),
      });
    },
    createLinearGradient() {
      calls.push({ op: "linearGradient" });
      return gradient;
    },
    createRadialGradient(
      _x0: number,
      _y0: number,
      _r0: number,
      x: number,
      y: number,
      r: number,
    ) {
      calls.push({ op: "radialGradient", x, y, r });
      return gradient;
    },
  };

  // The recorder implements exactly the members `draw.ts` touches, which is
  // asserted in `tests/geometry.test.ts` rather than assumed here.
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}
