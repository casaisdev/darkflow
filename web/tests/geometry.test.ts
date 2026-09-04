import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLOCK_EXTENT,
  BLOCK_RIGHT,
  BLOCK_TOP,
  BLOCK_WIDTH,
  CHAMBER_LEFT,
  ENTRY_MS,
  FIELD_FADE_END,
  FRAME_LEFT,
  MIN_ROW_WIDTH,
  entryDepth,
  gasWidthFraction,
  PANEL_BAND,
  STRIP_RIGHT,
  STRIP_WIDTH,
  TOP_SLOT_TAB,
  NARROW,
  NARROW_BELOW_PX,
  NARROW_SHORT,
  SHORT_BELOW_PX,
  WIDE,
  geometryFor,
  render,
  slotRect,
  widthForGas,
} from "@/lib/canvas/draw";
import {
  applyBlock,
  createWorld,
  enqueue,
  step,
  type BlockArrival,
  type WorldState,
} from "@/lib/canvas/world";
import type { BlockEvent } from "@/types/stream";
import {
  eip1559,
  hashOf,
  palette,
  recordingContext,
  resetHashes,
  tx,
  view,
} from "./helpers";

/**
 * Block geometry, which is where the product's central claim is either made
 * honestly or not made at all.
 *
 * Two rules, and every test here is one of them:
 *
 * 1. Gas is width, class is tone, and they never cross. A ghost and a seen
 *    transaction of the same size are drawn at exactly the same width and
 *    exactly the same thickness. Only the colour differs. Any thickness
 *    difference would encode the classification twice and make the accent look
 *    like more of the block than it is.
 * 2. The halo is transient. A permanent glow on private flow would be a second
 *    channel saying the same thing, and would make a row keep announcing
 *    itself long after the announcement was information.
 */

const GAS = 60_000;

function blockOf(
  count: number,
  ghostAt: (i: number) => boolean,
  bigAt = -1,
) {
  const world = createWorld({ maxEntities: 10, topQuota: 0 });
  world.heightFor = () => 0.5;
  const hashes = Array.from({ length: count }, (_, i) => hashOf(i));
  const gasUsed = hashes.map((_, i) => (i === bigAt ? 200_000 : GAS));
  const block: BlockEvent = {
    number: 21_000_000,
    timestamp: 1_700_000_000_000,
    baseFeePerGas: 12e9,
    hashes,
    gasUsed,
  };
  const arrivals: BlockArrival[] = hashes.map((hash, index) => ({
    hash,
    index,
    origin: ghostAt(index) ? "ghost" : "seen",
    record: ghostAt(index)
      ? undefined
      : { firstSeen: 1_699_999_990_000, fees: eip1559(2, 30), gas: GAS },
    gasUsed: gasUsed[index],
  }));
  applyBlock(world, block, arrivals, () => 0.5);
  return world;
}

describe("row width from gas", () => {
  it("runs on the square root between the floor and the full column", () => {
    expect(widthForGas(100, 200_000, 200_000)).toBe(100);
    expect(widthForGas(100, 0, 200_000)).toBe(100 * MIN_ROW_WIDTH);
    expect(widthForGas(100, 50_000, 200_000)).toBeCloseTo(
      100 * (MIN_ROW_WIDTH + (1 - MIN_ROW_WIDTH) * 0.5),
      10,
    );
    // Monotonic: more gas is never a narrower row.
    let last = -1;
    for (let gas = 0; gas <= 200_000; gas += 5000) {
      const width = gasWidthFraction(gas, 200_000);
      expect(width).toBeGreaterThanOrEqual(last);
      last = width;
    }
  });

  it("keeps a plain transfer legible against a rollup batch", () => {
    // Measured on the recording: 6.66M gas at the top of a block. Linear, a
    // 21,000 transfer was 0.3% of the span and sat on the floor with every
    // other ordinary row; the column read as a spine with one bar.
    expect(MIN_ROW_WIDTH).toBe(0.18);
    const linear = MIN_ROW_WIDTH + (1 - MIN_ROW_WIDTH) * (21_000 / 6_660_000);
    const transfer = gasWidthFraction(21_000, 6_660_000);
    expect(transfer).toBeGreaterThan(linear + 0.04);
    // And against an ordinary block maximum it is a row, not the floor.
    const against400k = gasWidthFraction(21_000, 400_000);
    expect(against400k).toBeGreaterThan(0.3);
    expect(against400k).toBeLessThan(0.45);
  });

  it("never exceeds the column, whatever the block reports", () => {
    // Defensive: a gas figure above the block maximum can only come from a bad
    // feed, and the row must not spill out of its column when it does.
    expect(widthForGas(100, 900_000, 200_000)).toBe(100);
  });

  it("falls back to the full width rather than dividing by zero", () => {
    expect(widthForGas(100, 21_000, 0)).toBe(100);
  });
});

describe("slot rectangles", () => {
  it("gives every slot the same thickness regardless of what fills it", () => {
    const heights = Array.from(
      { length: 150 },
      (_, i) => slotRect(view, i, 150, false).height,
    );
    const unique = [...new Set(heights)];
    // Snapping to device pixels means a slot is one of at most two heights.
    // More than that and the stack would read as varying, which is a channel
    // nothing is entitled to use.
    expect(unique.length).toBeLessThanOrEqual(2);
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(
      1 / view.dpr,
    );
  });

  it("leaves a full device pixel of gap between consecutive rows", () => {
    // Measured failure: at a ~5px pitch an unsnapped 1.26px gap landed on
    // fractional coordinates and antialiasing smeared it into the rows either
    // side, so only 45% of the 149 gaps were dark enough to read and the stack
    // looked like one brick.
    const device = 1 / view.dpr;
    for (let i = 0; i < 149; i++) {
      const a = slotRect(view, i, 150, false);
      const b = slotRect(view, i + 1, 150, false);
      const gap = b.y - (a.y + a.height);
      expect(gap).toBeGreaterThanOrEqual(device - 1e-9);
      // On whole device pixels, so the gap is a pixel and not a blur.
      expect(Math.abs(a.y * view.dpr - Math.round(a.y * view.dpr))).toBeLessThan(
        1e-9,
      );
    }
  });

  it("keeps a visible row even when the block is denser than the pitch", () => {
    const rect = slotRect(view, 500, 4000, false);
    expect(rect.height).toBeGreaterThanOrEqual(1 / view.dpr);
  });

  it("puts the compressed strip in its own column, clear of the live block", () => {
    const live = slotRect(view, 0, 150, false);
    const strip = slotRect(view, 0, 150, true);
    expect(live.width).toBeCloseTo(view.width * BLOCK_WIDTH, 10);
    expect(strip.width).toBeCloseTo(view.width * STRIP_WIDTH, 10);
    expect(strip.x + strip.width).toBeLessThan(live.x);
    expect(strip.y).toBe(live.y);
    expect(strip.height).toBe(live.height);
  });

  it("stays clear of the panel band at the bottom", () => {
    const last = slotRect(view, 149, 150, false);
    // The panel used to cover the foot of the block and the registration
    // marks. `BLOCK_EXTENT` is derived from `PANEL_BAND` so it cannot drift.
    expect(BLOCK_EXTENT).toBe(1 - BLOCK_TOP - PANEL_BAND - 0.02);
    expect(last.y + last.height).toBeLessThan(view.height * (1 - PANEL_BAND));
  });

  it("sits against the right edge, in the columns the DOM chrome labels", () => {
    const live = slotRect(view, 0, 150, false);
    expect(live.x + live.width).toBeCloseTo(view.width * BLOCK_RIGHT, 10);
    const strip = slotRect(view, 0, 150, true);
    expect(strip.x + strip.width).toBeCloseTo(view.width * STRIP_RIGHT, 10);
  });
});

describe("what the block pass actually draws", () => {
  const options = {
    showGhosts: true,
    ticks: [],
    markScale: 1,
    reducedMotion: false,
  };

  /**
   * Settled rows in the live block column, in slot order.
   *
   * The column also carries the cap above slot 0, which is a 2px rule rather
   * than a row and would otherwise be counted as a row of a different width.
   * Rows are selected by thickness against the slot pitch, so the filter
   * cannot quietly drop a real row and make an assertion vacuous.
   */
  function blockRows(world: ReturnType<typeof blockOf>, count: number) {
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, options);
    const left = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
    const right = view.width * BLOCK_RIGHT;
    const pitch = (view.height * BLOCK_EXTENT) / count;
    const rows = calls.filter(
      (call) =>
        call.op === "fillRect" &&
        call.x >= left - TOP_SLOT_TAB - 1 &&
        call.x + call.w <= right + 1 &&
        // 0.6 rather than 0.5: at some pitches the 2px block cap clears half a
        // slot and gets counted as a row, which it is not.
        call.h > pitch * 0.6,
    );
    expect(rows.length).toBe(count);
    return rows;
  }

  it("draws a ghost and a seen row at identical width and thickness", () => {
    // Every slot carries the same gas, so the only thing that may differ
    // between the two classes is the fill colour.
    const world = blockOf(20, (i) => i % 2 === 1);
    step(world, 3000, 1_700_000_000_000); // past the flight and the flash
    // Slot 0 is dropped: it carries the protruding tab that marks the top of
    // the block, which is a position signal and not a class signal.
    const body = blockRows(world, 20).slice(1);

    const widths = new Set(body.map((r) => r.op === "fillRect" && r.w));
    const heights = new Set(body.map((r) => r.op === "fillRect" && r.h));
    expect(widths.size).toBe(1);
    // Two, not one: device-pixel snapping puts each row on a whole pixel, so a
    // fractional pitch alternates between neighbouring heights. The spread is
    // what matters, and it is under one device pixel.
    expect(heights.size).toBeLessThanOrEqual(2);
    const spread =
      Math.max(...[...heights].map(Number)) -
      Math.min(...[...heights].map(Number));
    expect(spread).toBeLessThanOrEqual(1 / view.dpr);

    // ...and the colours do differ, or the assertions above would be vacuous.
    const colours = new Set(body.map((r) => r.op === "fillRect" && r.fill));
    expect(colours.size).toBe(2);
  });

  it("gives a bigger transaction a wider row, in both classes alike", () => {
    // Slot 7 holds 200,000 gas against 60,000 everywhere else. In one world it
    // is public, in the other it is private flow; the row must come out the
    // same size either way.
    const seenBig = blockOf(20, (i) => i % 2 === 1, 6);
    const ghostBig = blockOf(20, (i) => i % 2 === 1, 7);
    step(seenBig, 3000, 1_700_000_000_000);
    step(ghostBig, 3000, 1_700_000_000_000);
    const widthsOf = (w: ReturnType<typeof blockOf>) =>
      blockRows(w, 20).map((f) => (f.op === "fillRect" ? f.w : 0));
    const seen = widthsOf(seenBig);
    const ghost = widthsOf(ghostBig);
    expect(seen[6]).toBeCloseTo(ghost[7], 10);
    expect(seen[6]).toBe(view.width * BLOCK_WIDTH); // the block's largest
    expect(seen[6]).toBeGreaterThan(seen[5]);
    // And the classes are genuinely swapped between the two worlds.
    expect(seen[6]).not.toBe(ghost[6]);
  });

  it("marks position 0 by geometry, never by tone", () => {
    // Tone is class and only class. The top slot used to also take a lighter
    // fill, which put two meanings on one channel — and inconsistently, since
    // the ghost branch won: a top slot that was private flow never took it.
    // Two markers that are always there beat a third that is sometimes there.
    const world = blockOf(20, () => false);
    step(world, 3000, 1_700_000_000_000);
    const rows = blockRows(world, 20);
    const fills = new Set(rows.map((r) => r.op === "fillRect" && r.fill));
    expect(fills.size).toBe(1);

    // What does mark it: a tab protruding left, and a cap above.
    const top = rows[0];
    const body = rows[1];
    expect(top.op === "fillRect" && body.op === "fillRect").toBe(true);
    if (top.op !== "fillRect" || body.op !== "fillRect") return;
    expect(top.w - body.w).toBeCloseTo(TOP_SLOT_TAB, 6);
    expect(top.x).toBeCloseTo(body.x - TOP_SLOT_TAB, 6);
  });

  it("keeps the top marker when position 0 is private flow", () => {
    // The case the lighter fill never covered. Geometry does.
    const world = blockOf(20, (i) => i === 0);
    step(world, 3000, 1_700_000_000_000);
    const rows = blockRows(world, 20);
    const top = rows[0];
    const body = rows[1];
    if (top.op !== "fillRect" || body.op !== "fillRect") throw new Error("rows");
    expect(top.w - body.w).toBeCloseTo(TOP_SLOT_TAB, 6);
    // And it is warm, because it is private flow — tone answers class here and
    // has nothing left to say about position.
    const warm = `rgba(${palette.ghostSettled.r}, ${palette.ghostSettled.g}, ${palette.ghostSettled.b}`;
    expect(top.fill.startsWith(warm)).toBe(true);
  });

  it("draws no halo once the block has settled", () => {
    const world = blockOf(20, (i) => i % 2 === 1);
    step(world, 3000, 1_700_000_000_000);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, options);
    // At rest a ghost is the row itself: solid, matte, no glow. The radial
    // gradient is the halo and there must be none of them.
    expect(calls.filter((c) => c.op === "radialGradient")).toEqual([]);
  });

  it("draws a halo while a ghost is still appearing", () => {
    // Ghosts no longer all appear on the same millisecond — they arrive in
    // block order across the assembly — so this walks the assembly and asks
    // whether the flash ever fires, not whether it fires ten times at once.
    const world = blockOf(20, (i) => i % 2 === 1);
    const row = slotRect(view, 1, 20, false);
    let sawHalo = 0;
    let widest = 0;
    for (let t = 0; t < 2600; t += 40) {
      step(world, 40, 1_700_000_000_000);
      const { ctx, calls } = recordingContext();
      render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, options);
      for (const call of calls) {
        if (call.op !== "radialGradient") continue;
        sawHalo += 1;
        widest = Math.max(widest, call.r);
      }
    }
    expect(sawHalo).toBeGreaterThan(0);
    // It overshoots well past the row, which is what makes it announce rather
    // than fade in politely.
    expect(widest).toBeGreaterThan(row.height);
  });

  it("draws nothing in --ghost while calibration is active", () => {
    // Rule 1: during calibration the classification is not merely hidden, it
    // is not made. Nothing on screen may carry the accent.
    const world = blockOf(20, (i) => i % 2 === 1);
    step(world, 3000, 1_700_000_000_000);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, {
      ...options,
      showGhosts: false,
    });
    const accent = `rgba(${palette.ghostSettled.r}, ${palette.ghostSettled.g}, ${palette.ghostSettled.b}`;
    const core = `rgba(${palette.ghostCore.r}, ${palette.ghostCore.g}, ${palette.ghostCore.b}`;
    const warm = calls.filter(
      (c) =>
        (c.op === "fillRect" || c.op === "arc") &&
        (c.fill.startsWith(accent) || c.fill.startsWith(core)),
    );
    expect(warm).toEqual([]);
    // And with ghosts shown, the same render does carry it — otherwise the
    // assertion above would pass on an empty block.
    const shown = recordingContext();
    render(
      shown.ctx,
      world,
      palette,
      view,
      1_700_000_000_000,
      () => 0.5,
      options,
    );
    expect(
      shown.calls.filter(
        (c) => c.op === "fillRect" && c.fill.startsWith(accent),
      ).length,
    ).toBe(10);
  });
});

describe("the engine's entry guard", () => {
  /**
   * Regression for a bug that produced no error and a plausible picture.
   *
   * `now` flows into `ageOf` → `exponentialDecay` → `ctx.globalAlpha`. The
   * canvas spec ignores a non-finite assignment to `globalAlpha`, so a NaN
   * arrived, vanished, and left every emissive mark at full opacity with no
   * age decay. Every field capture taken through the dev seam was wrong for
   * months of sessions and nothing said so.
   */
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws on a non-finite now instead of drawing something plausible", async () => {
    // The engine observes its canvas for resizes. Node has no ResizeObserver
    // and this test never resizes anything, so a no-op stands in.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("document", { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal("devicePixelRatio", 1);
    const { createEngine } = await import("@/lib/canvas/engine");
    const { ctx } = recordingContext();
    const canvas = {
      getContext: () => ctx,
      width: 100,
      height: 100,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
      addEventListener() {},
      removeEventListener() {},
    } as unknown as HTMLCanvasElement;

    const world = createWorld({ maxEntities: 4, topQuota: 0 });
    world.heightFor = () => 0.5;
    const engine = createEngine({
      canvas,
      world,
      palette: () => palette,
      feeScale: () => 0.5,
    });

    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => engine.renderOnce(bad)).toThrow(TypeError);
    }
    // And an argument omitted entirely, which is how it actually happened.
    expect(() =>
      (engine.renderOnce as unknown as () => void)(),
    ).toThrow(TypeError);
    // A real timestamp still works.
    expect(() => engine.renderOnce(Date.now())).not.toThrow();
  });
});

describe("the gas datum", () => {
  /**
   * The left edge of the block column is where the block's largest transaction
   * reaches, and the panel names that figure beside it. Nothing spills past it
   * — measured, 243.04px against a 243.0px column — but until it was drawn, a
   * full-width row ended in open canvas and read as spilling.
   */
  it("draws one vertical rule at the column's left edge, behind the rows", () => {
    const world = blockOf(20, (i) => i % 2 === 1);
    step(world, 3000, 1_700_000_000_000);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: false,
    });
    const left = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
    const lines = calls.filter(
      (c) => c.op === "line" && Math.abs(c.x1 - left) < 1 && c.x1 === c.x2,
    );
    expect(lines).toHaveLength(1);
    // Spanning the block's own extent, not the whole canvas.
    const line = lines[0];
    if (line.op !== "line") throw new Error("line");
    expect(line.y1).toBeCloseTo(view.height * BLOCK_TOP, 6);
    expect(line.y2).toBeCloseTo(
      view.height * (BLOCK_TOP + BLOCK_EXTENT),
      6,
    );
  });

  it("puts no row past it", () => {
    const world = blockOf(20, () => false, 5);
    step(world, 3000, 1_700_000_000_000);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: false,
    });
    const left = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
    const right = view.width * BLOCK_RIGHT;
    const pitch = (view.height * BLOCK_EXTENT) / 20;
    const rows = calls.filter(
      (c) =>
        c.op === "fillRect" &&
        c.x + c.w <= right + 1 &&
        c.x > left - TOP_SLOT_TAB - 1 &&
        c.h > pitch * 0.6,
    );
    expect(rows).toHaveLength(20);
    for (const row of rows) {
      if (row.op !== "fillRect") continue;
      // Slot 0 carries the tab, which is a position marker and not gas.
      const allowance = row.w > view.width * BLOCK_WIDTH ? TOP_SLOT_TAB : 0;
      expect(row.x).toBeGreaterThanOrEqual(left - allowance - 0.01);
    }
  });
});

describe("a block arrives in its own order", () => {
  /**
   * The event the product exists to show.
   *
   * Every transaction still crosses in `--land-block`; they no longer all
   * leave on the same millisecond. Before this the whole transition was a
   * single 420ms flash once every twelve seconds — on screen 3.5% of the time —
   * and a viewer who blinked saw bars swap.
   */
  const options = {
    showGhosts: true,
    ticks: [],
    markScale: 1,
    reducedMotion: false,
  };
  const NOW4 = 1_700_000_000_000;

  function settledRowCount(world: ReturnType<typeof blockOf>, count: number) {
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW4, () => 0.5, options);
    const left = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
    const right = view.width * BLOCK_RIGHT;
    const pitch = (view.height * BLOCK_EXTENT) / count;
    return calls.filter(
      (c) =>
        c.op === "fillRect" &&
        c.x + c.w <= right + 1 &&
        c.x > left - TOP_SLOT_TAB - 1 &&
        c.h > pitch * 0.6,
    ).length;
  }

  it("fills the column progressively rather than all at once", () => {
    const world = blockOf(40, (i) => i % 3 === 0);
    const arrived: number[] = [];
    for (let i = 0; i < 9; i++) {
      step(world, 300, NOW4);
      arrived.push(
        world.block.filter((m) => m.phase === "settled" && m.flightProgress === 1)
          .length,
      );
    }
    // Monotone: the block only ever gains rows.
    for (let i = 1; i < arrived.length; i++) {
      expect(arrived[i]).toBeGreaterThanOrEqual(arrived[i - 1]);
    }
    // Not complete on the first frame — the whole point.
    expect(arrived[0]).toBeLessThan(40);
    expect(arrived[0]).toBeGreaterThan(0);
    // And complete by the end of the assembly.
    expect(arrived[arrived.length - 1]).toBe(40);
    // The drawn column agrees with the model.
    expect(settledRowCount(world, 40)).toBe(40);
  });

  it("releases slot 0 before the last slot", () => {
    const world = blockOf(40, () => false);
    step(world, 200, NOW4);
    const top = world.block.find((m) => m.slotIndex === 0)!;
    const last = world.block.find((m) => m.slotIndex === 39)!;
    // Position in the block is already the row's Y; releasing in that order
    // says the same thing twice rather than adding a channel.
    expect(top.phaseStartMs).toBeLessThan(last.phaseStartMs);
    expect(last.phaseStartMs - top.phaseStartMs).toBeCloseTo(2000, 0);
  });

  it("occupies the crossing for most of the assembly, not an instant", () => {
    const world = blockOf(40, () => false);
    let framesWithTravel = 0;
    for (let t = 0; t < 2600; t += 100) {
      step(world, 100, NOW4);
      const moving = world.block.filter(
        (m) => m.phase === "flying" && m.flightProgress > 0.02 && m.flightProgress < 0.98,
      ).length;
      if (moving > 0) framesWithTravel += 1;
    }
    // Was one frame in twenty-nine at this sampling; now most of them.
    expect(framesWithTravel).toBeGreaterThan(18);
  });

  it("lands the whole block at once under reduced motion", () => {
    // No journey and no sequence. The honest presentation of a block when
    // motion is unwanted is that it is simply there.
    const world = createWorld({ maxEntities: 10, topQuota: 0, reducedMotion: true });
    world.heightFor = () => 0.5;
    const hashes = Array.from({ length: 30 }, (_, i) => hashOf(700 + i));
    applyBlock(
      world,
      {
        number: 1,
        timestamp: NOW4,
        baseFeePerGas: 12e9,
        hashes,
        gasUsed: hashes.map(() => 50_000),
      },
      hashes.map((hash, index) => ({
        hash,
        index,
        origin: "seen" as const,
        record: { firstSeen: NOW4, fees: eip1559(2, 30), gas: 50_000 },
        gasUsed: 50_000,
      })),
      () => 0.5,
    );
    const starts = new Set(world.block.map((m) => m.phaseStartMs));
    expect(starts.size).toBe(1);
    step(world, 16, NOW4);
    expect(world.block.every((m) => m.phase === "settled")).toBe(true);
  });
});

describe("a landing row never lies about its gas", () => {
  it("holds its final width for the whole flight, changing only alpha", () => {
    // Width is gas. A row that grows from zero to its true width is reporting
    // a gas figure that rises from nothing over the whole landing — false for
    // as long as the animation runs, and the animation now runs for seconds.
    const world = blockOf(20, () => false, 7);
    const widths = new Map<number, Set<number>>();
    for (let t = 0; t < 2600; t += 60) {
      step(world, 60, 1_700_000_000_000);
      const { ctx, calls } = recordingContext();
      render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, {
        showGhosts: true,
        ticks: [],
        markScale: 1,
        reducedMotion: false,
      });
      const left = view.width * (BLOCK_RIGHT - BLOCK_WIDTH);
      const right = view.width * BLOCK_RIGHT;
      const pitch = (view.height * BLOCK_EXTENT) / 20;
      for (const c of calls) {
        if (c.op !== "fillRect") continue;
        if (c.x + c.w > right + 1 || c.x <= left - TOP_SLOT_TAB - 1) continue;
        if (c.h <= pitch * 0.6) continue;
        const slot = Math.round((c.y - view.height * BLOCK_TOP) / pitch);
        if (!widths.has(slot)) widths.set(slot, new Set());
        widths.get(slot)!.add(Math.round(c.w * 100) / 100);
      }
    }
    // Every slot was drawn at exactly one width across the whole assembly.
    for (const [slot, seen] of widths) {
      expect({ slot, widths: [...seen] }).toEqual({
        slot,
        widths: [...seen].slice(0, 1),
      });
    }
    // And the slot with the big transaction really is wider, so the assertion
    // above is not passing on a column of identical rows.
    const all = [...widths.values()].map((s) => [...s][0]);
    expect(new Set(all).size).toBeGreaterThan(1);
  });
});

describe("the chamber is one rectangle", () => {
  /**
   * The left of the instrument used to be three alignments inside forty-four
   * pixels — spine at 0.5, bracket corner at 2.5, numerals at 14 — all jammed
   * against the viewport edge, so the frame did not read as enclosing anything.
   * The frame now encloses the measured volume and its scale.
   */
  it("puts the frame outside the axis, and the axis outside the fog", () => {
    expect(FRAME_LEFT).toBeLessThan(CHAMBER_LEFT);
    // The gutter has to fit a numeral: "0.15" at 10px mono is about 30px, and
    // this must not shrink below that at any viewport the chrome supports.
    const gutterAt1024 = (CHAMBER_LEFT - FRAME_LEFT) * 1024;
    expect(gutterAt1024).toBeGreaterThan(30);
  });

  it("starts the grid, the spine and the fog on the same line", () => {
    const world = blockOf(4, () => false);
    world.entities.push({
      ...world.block[0],
      phase: "pending",
      x: 0,
      y: 0.5,
      cullAtMs: Infinity,
      firstSeen: 1_700_000_000_000,
    });
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, {
      showGhosts: true,
      ticks: [
        { gwei: 1, height: 0.5, ruled: true },
        { gwei: 2, height: 0.3, ruled: false },
      ],
      markScale: 1,
      reducedMotion: false,
    });
    const axis = view.width * CHAMBER_LEFT;
    // The ruled line, the spine tick and the vertical spine all begin here.
    const startingAtAxis = calls.filter(
      (c) => c.op === "line" && Math.abs(c.x1 - axis) < 1.5,
    );
    expect(startingAtAxis.length).toBeGreaterThanOrEqual(3);
    // Nothing in the chamber begins left of the axis except the frame.
    const leftOfAxis = calls.filter(
      (c) => c.op === "line" && c.x1 < axis - 1.5 && c.x1 > 0,
    );
    for (const line of leftOfAxis) {
      if (line.op !== "line") continue;
      // A corner is an arm running into a vertex, so the frame edge is the
      // nearer of the two ends, not necessarily the start.
      expect(Math.min(line.x1, line.x2)).toBeCloseTo(
        view.width * FRAME_LEFT,
        0,
      );
    }
    expect(leftOfAxis.length).toBeGreaterThan(0);
    // A mark at x = 0 sits on the axis, not on the viewport edge.
    const marks = calls.filter((c) => c.op === "arc");
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      if (mark.op !== "arc") continue;
      expect(mark.x).toBeGreaterThanOrEqual(axis - 0.01);
    }
  });

  it("ends the frame where the grid stops being full strength", () => {
    // Measured before this pass: both already sat at 835.5px on a 1519px
    // canvas. Pinned so a change to either has to move the other.
    const world = blockOf(4, () => false);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, 1_700_000_000_000, () => 0.5, {
      showGhosts: true,
      ticks: [{ gwei: 1, height: 0.5, ruled: true }],
      markScale: 1,
      reducedMotion: false,
    });
    const frameRight = view.width * view.split;
    // A corner is drawn as an arm into a vertex, so the vertex is the segment
    // end, not its start.
    const corners = calls.filter(
      (c) =>
        c.op === "line" &&
        (Math.abs(c.x1 - frameRight) < 1.5 || Math.abs(c.x2 - frameRight) < 1.5),
    );
    expect(corners.length).toBe(2);
    // And the grid rule reaches past it, dissolving, rather than stopping dead.
    const rules = calls.filter(
      (c) => c.op === "line" && c.x2 > frameRight + 10 && c.y1 === c.y2,
    );
    expect(rules.length).toBeGreaterThan(0);
  });
});

const NOW = 1_700_000_000_000;

describe("a mark enters the field rather than appearing in it", () => {
  /**
   * Reported from the running app: transactions spawning at the top of the
   * chamber whenever a block lands. Metering the intake spread the run over
   * 208ms — measured — but each mark still arrived at the full brightness its
   * age entitled it to, and admission is fee-ordered, so the run lands in the
   * top band where the block has just taken everything out.
   *
   * The moment a mark becomes visible is a rendering decision, not something
   * that happened in the mempool, and it must not be announced in the same
   * visual language the field uses for arrivals.
   */
  function fieldAlpha(world: WorldState, now: number) {
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, now, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: false,
    });
    const arc = calls.find((call) => call.op === "arc");
    return arc?.op === "arc" ? arc.alpha : null;
  }

  function oneMark() {
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    enqueue(world, [
      tx({ hash: hashOf(700), firstSeen: NOW, fees: eip1559(3, 40) }),
    ]);
    // Enough of a step to earn the metered credit for one mark, and no more.
    step(world, 20, NOW);
    expect(world.entities).toHaveLength(1);
    return world;
  }

  it("starts from nothing instead of from full brightness", () => {
    const world = oneMark();
    const atBirth = fieldAlpha(world, NOW);
    expect(atBirth).not.toBeNull();
    expect(atBirth as number).toBeLessThan(0.02);
  });

  it("reaches the brightness its age entitles it to, and stops there", () => {
    const world = oneMark();
    // Two renders of the same world at the same `now`, so age is identical and
    // the only difference is how long the mark has been in the field.
    const early = fieldAlpha(world, NOW) as number;
    world.elapsedMs += ENTRY_MS;
    const entered = fieldAlpha(world, NOW) as number;
    world.elapsedMs += ENTRY_MS * 4;
    const later = fieldAlpha(world, NOW) as number;
    expect(entered).toBeGreaterThan(early);
    // Halfway through, halfway there. Without this a hard step from nothing to
    // full passes every other assertion here — and a hard step is the pop.
    const half = oneMark();
    half.elapsedMs += ENTRY_MS / 2;
    const midway = fieldAlpha(half, NOW) as number;
    expect(midway / entered).toBeCloseTo(0.5, 2);
    // The ramp is finished, not still climbing: age alone decides from here.
    expect(later).toBeCloseTo(entered, 10);
  });

  it("does not touch what age decides, only when it starts deciding", () => {
    // Rule 2 holds: alpha is a function of age and nothing else. The ramp is a
    // separate factor on time-in-field, so a mark past the ramp reads exactly
    // as it did before the ramp existed.
    const young = oneMark();
    young.elapsedMs += ENTRY_MS;
    const old = oneMark();
    old.elapsedMs += ENTRY_MS;
    const fresh = fieldAlpha(young, NOW) as number;
    const aged = fieldAlpha(old, NOW + 20_000) as number;
    expect(aged).toBeLessThan(fresh);
  });
});

describe("three kinds of arrival, not two", () => {
  /**
   * Measured over three consecutive blocks on the running app: 34, 59 and 47
   * arrivals had really been on screen, 48, 21 and 53 were private flow, and
   * 68, 70 and 50 were public flow the field had never drawn — more of them
   * than the honest case. Every one of those was being given a position derived
   * from its fee and flown out of it, so each block materialised about sixty
   * marks from nothing inside the measured volume. Blocks include the highest
   * fees, so they clustered in the top four deciles of the chamber.
   */
  function blockOf(kinds: readonly ("field" | "offscreen" | "ghost")[]) {
    resetHashes();
    const world = createWorld({ maxEntities: 50, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    // Only the "field" ones are ever sampled into the chamber.
    const hashes = kinds.map((_, i) => hashOf(i));
    kinds.forEach((kind, i) => {
      if (kind !== "field") return;
      enqueue(world, [
        tx({ hash: hashes[i], firstSeen: NOW, fees: eip1559(3, 40) }),
      ]);
      step(world, 40, NOW);
    });
    const block: BlockEvent = {
      number: 21_000_000,
      timestamp: NOW,
      baseFeePerGas: 12e9,
      hashes,
      gasUsed: hashes.map(() => 21_000),
    };
    const arrivals: BlockArrival[] = kinds.map((kind, index) => ({
      hash: hashes[index],
      index,
      origin: kind === "ghost" ? "ghost" : "seen",
      record:
        kind === "ghost"
          ? undefined
          : { firstSeen: NOW - 3000, fees: eip1559(3, 40), gas: 21_000 },
      gasUsed: 21_000,
    }));
    const before = new Map(
      world.entities.map((e) => [e.hash, { x: e.x, y: e.y }]),
    );
    applyBlock(world, block, arrivals, () => 0.5);
    return { world, hashes, before };
  }

  it("starts public flow the field never drew at the chamber's edge", () => {
    const { world, hashes } = blockOf(["field", "offscreen", "ghost"]);
    const offscreen = world.block.find((m) => m.hash === hashes[1]);
    expect(offscreen?.enteredInFlight).toBe(true);
    // The right edge of the chamber in chamber coordinates: the boundary of
    // what the field draws, not a spot inside the measured volume.
    expect(offscreen?.fromX).toBe(1);
  });

  it("leaves a mark that really was on screen exactly where it was", () => {
    const { world, hashes, before } = blockOf(["field", "offscreen", "ghost"]);
    const fromField = world.block.find((m) => m.hash === hashes[0]);
    expect(fromField?.enteredInFlight).toBe(false);
    // Where it was, drift included — not its home, and not the boundary.
    expect(fromField?.fromX).toBe(before.get(hashes[0])?.x);
    expect(fromField?.fromY).toBe(before.get(hashes[0])?.y);
    expect(fromField?.fromX).toBeLessThan(1);
  });

  it("still gives private flow no trajectory at all", () => {
    // The one claim the product makes. Nothing here may blur it.
    const { world, hashes } = blockOf(["field", "offscreen", "ghost"]);
    const ghost = world.block.find((m) => m.hash === hashes[2]);
    expect(ghost?.origin).toBe("ghost");
    expect(ghost?.phase).toBe("settled");
    expect(ghost?.flightProgress).toBe(1);
  });

  it("draws nothing for it until its turn to cross comes", () => {
    /**
     * It waits out its stagger with `flightProgress` at zero, and at zero it is
     * not on screen. Otherwise it would appear at the boundary the instant the
     * block landed and sit there for up to two seconds before moving, which is
     * the pop this replaces, relocated.
     */
    const { world, hashes } = blockOf(["offscreen"]);
    const mark = world.block.find((m) => m.hash === hashes[0]);
    expect(mark?.flightProgress).toBe(0);
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: false,
    });
    const emissive = calls.filter((c) => c.op === "arc" && c.alpha > 0.001);
    expect(emissive).toHaveLength(0);
  });

  it("fades it up across the crossing instead of at a point", () => {
    const { world, hashes } = blockOf(["offscreen"]);
    const mark = world.block.find((m) => m.hash === hashes[0]);
    if (!mark) throw new Error("no mark");
    const alphaAt = (progress: number) => {
      mark.flightProgress = progress;
      const { ctx, calls } = recordingContext();
      render(ctx, world, palette, view, NOW, () => 0.5, {
        showGhosts: true,
        ticks: [],
        markScale: 1,
        reducedMotion: false,
      });
      const arc = calls.find((c) => c.op === "arc");
      return arc?.op === "arc" ? arc.alpha : 0;
    };
    // The fade runs up to this mark's own entry depth, over the quarter of
    // the crossing before it. See `entryDepth`.
    const entry = entryDepth(mark);
    const from = Math.max(0, entry - 0.25);
    const early = alphaAt(from + 0.2 * (entry - from));
    const middle = alphaAt((from + entry) / 2);
    const whole = alphaAt(entry);
    expect(alphaAt(from)).toBe(0);
    expect(early).toBeLessThan(middle);
    expect(middle).toBeLessThan(whole);
    // Halfway through the entry, halfway there — a hard step would pass every
    // other assertion here, and a hard step is the pop.
    expect(middle / whole).toBeCloseTo(0.5, 2);
  });
});

describe("four regions, visible without being explained", () => {
  /**
   * Measured on the running app before this existed: along a scanline through
   * the observed band the chamber fell from 11.01 to 6.79 over 308px — the
   * ground's dissolution — and then nothing changed. Crossing to previous
   * block: 22.8px of ground at 6.79 on both sides. Previous block to block:
   * 18.2px, also 6.79. Two of the three boundaries were marked by nothing.
   */
  function chrome() {
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW, () => 0.5, {
      showGhosts: true,
      // Ticks present, because the separators are drawn from the same place the
      // grid is and a test on an unticked world would not exercise them.
      ticks: [{ gwei: 1, height: 0.5, ruled: true }],
      markScale: 1,
      reducedMotion: false,
    });
    return calls;
  }

  const top = view.height * BLOCK_TOP;
  const bottom = view.height * (BLOCK_TOP + BLOCK_EXTENT);
  const near = (a: number, b: number) => Math.abs(a - b) < 1.5;

  function horizontalsAt(y: number) {
    return chrome().filter(
      (call) => call.op === "line" && near(call.y1, y) && near(call.y2, y),
    );
  }

  it("stands every region on the same two lines", () => {
    for (const y of [top, bottom]) {
      const lines = horizontalsAt(y);
      // Chamber, previous block, block. The crossing is the dissolve on one
      // side and a break on the other, so it draws no segment of its own.
      expect(lines.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("breaks the line where one region ends and the next begins", () => {
    const spans = horizontalsAt(top)
      .map((call) => (call.op === "line" ? [call.x1, call.x2] : [0, 0]))
      .sort((a, b) => a[0] - b[0]);
    // No segment may cross either empty gap: the gap is the boundary.
    const gaps = [
      [view.width * FIELD_FADE_END, view.width * (STRIP_RIGHT - STRIP_WIDTH)],
      [view.width * STRIP_RIGHT, view.width * (BLOCK_RIGHT - BLOCK_WIDTH)],
    ];
    for (const [gapStart, gapEnd] of gaps) {
      const mid = (gapStart + gapEnd) / 2;
      const crossing = spans.filter(([x1, x2]) => x1 < mid && x2 > mid);
      expect(crossing).toHaveLength(0);
    }
  });

  it("draws nothing vertical between them, so nothing is boxed", () => {
    // A full-height divider in the gaps was the other candidate. It marks a
    // boundary without grouping anything, and it puts a wall in the crossing.
    const gapMid =
      (view.width * STRIP_RIGHT + view.width * (BLOCK_RIGHT - BLOCK_WIDTH)) / 2;
    const verticals = chrome().filter(
      (call) =>
        call.op === "line" &&
        near(call.x1, call.x2) &&
        near(call.x1, gapMid) &&
        Math.abs(call.y2 - call.y1) > 40,
    );
    expect(verticals).toHaveLength(0);
  });
});

describe("the block travels to the strip", () => {
  /**
   * The strip is the block a reader has just spent twelve seconds watching. It
   * used to get there by teleport: the wide column vanished and a narrow one
   * appeared three hundred pixels to its left, with nothing on screen to say
   * the two were the same block. A reader cannot compare this block against the
   * last one if they never saw the last one move.
   */
  const OLD_ROWS = 8;
  const NEW_ROWS = 20;
  /** The old block's slot pitch. Nothing else on the canvas is this tall. */
  const oldPitch = (view.height * BLOCK_EXTENT) / OLD_ROWS;

  function twoBlocks(reducedMotion = false) {
    resetHashes();
    const world = createWorld({ maxEntities: 20, topQuota: 0 });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    world.reducedMotion = reducedMotion;
    [OLD_ROWS, NEW_ROWS].forEach((count, n) => {
      const hashes = Array.from({ length: count }, (_, i) => hashOf(n * 100 + i));
      const block: BlockEvent = {
        number: 21_000_000 + n,
        timestamp: NOW,
        baseFeePerGas: 12e9,
        hashes,
        gasUsed: hashes.map(() => 21_000),
      };
      applyBlock(
        world,
        block,
        hashes.map((hash, index) => ({
          hash,
          index,
          origin: "ghost" as const,
          gasUsed: 21_000,
        })),
        () => 0.5,
      );
      if (n === 0) step(world, 4000, NOW);
    });
    return world;
  }

  /**
   * The previous block's rows, picked out by their slot pitch.
   *
   * Position cannot identify them: for most of the handover they are inside the
   * live column's span, which is the whole point of the animation. The two
   * blocks are given different row counts so the old one's rows are the only
   * rectangles on the canvas of that height.
   */
  function stripRows(world: WorldState) {
    const { ctx, calls } = recordingContext();
    render(ctx, world, palette, view, NOW, () => 0.5, {
      showGhosts: true,
      ticks: [],
      markScale: 1,
      reducedMotion: world.reducedMotion,
    });
    return calls.flatMap((call) =>
      call.op === "fillRect" && Math.abs(call.h - oldPitch) < 1.5
        ? [{ left: call.x, right: call.x + call.w }]
        : [],
    );
  }

  it("starts the handover at the column it is leaving", () => {
    const world = twoBlocks();
    const rows = stripRows(world);
    expect(rows.length).toBe(OLD_ROWS);
    const right = Math.max(...rows.map((r) => r.right));
    expect(right).toBeCloseTo(view.width * BLOCK_RIGHT, 0);
  });

  it("has arrived at the strip once the handover is over", () => {
    const world = twoBlocks();
    world.elapsedMs += 2000;
    const rows = stripRows(world);
    expect(rows.length).toBe(OLD_ROWS);
    for (const row of rows) {
      expect(row.right).toBeLessThanOrEqual(view.width * STRIP_RIGHT + 1);
    }
  });

  it("is between the two while it travels", () => {
    const world = twoBlocks();
    world.elapsedMs += 260;
    const rows = stripRows(world);
    expect(rows.length).toBe(OLD_ROWS);
    const right = Math.max(...rows.map((r) => r.right));
    // Past the strip it is heading for, short of the column it left.
    expect(right).toBeGreaterThan(view.width * STRIP_RIGHT + 1);
    expect(right).toBeLessThan(view.width * BLOCK_RIGHT - 1);
  });

  it("does not travel when motion is unwanted", () => {
    // It still lands. It just does not move to get there.
    const world = twoBlocks(true);
    const rows = stripRows(world);
    expect(rows.length).toBe(OLD_ROWS);
    for (const row of rows) {
      expect(row.right).toBeLessThanOrEqual(view.width * STRIP_RIGHT + 1);
    }
  });
});

describe("reduced motion has no fades either", () => {
  /**
   * The flight, the drift and the handover are skipped when motion is
   * unwanted. The entry ramp was not: a mark still faded up over 320ms, and a
   * fade is motion to someone who asked for none. Under reduced motion a mark
   * is simply there, at the brightness its age earns.
   */
  it("shows a new mark at full brightness at once", () => {
    resetHashes();
    const world = createWorld({ maxEntities: 10, topQuota: 0, reducedMotion: true });
    world.heightFor = () => 0.5;
    world.baseFeePerGas = 12e9;
    enqueue(world, [tx({ hash: hashOf(800), firstSeen: NOW, fees: eip1559(3, 40) })]);
    step(world, 20, NOW);
    expect(world.entities).toHaveLength(1);
    const alphaAt = () => {
      const { ctx, calls } = recordingContext();
      render(ctx, world, palette, view, NOW, () => 0.5, {
        showGhosts: true,
        ticks: [],
        markScale: 1,
        reducedMotion: true,
      });
      const arc = calls.find((c) => c.op === "arc");
      return arc?.op === "arc" ? arc.alpha : null;
    };
    const atBirth = alphaAt();
    world.elapsedMs += ENTRY_MS * 4;
    const later = alphaAt();
    expect(atBirth).not.toBeNull();
    expect(atBirth as number).toBeCloseTo(later as number, 10);
    expect(atBirth as number).toBeGreaterThan(0.05);
  });
});

describe("the portrait geometry", () => {
  it("is chosen below the stylesheet's lg breakpoint and nowhere else", () => {
    expect(geometryFor(390)).toBe(NARROW);
    expect(geometryFor(NARROW_BELOW_PX - 1)).toBe(NARROW);
    expect(geometryFor(NARROW_BELOW_PX)).toBe(WIDE);
    expect(geometryFor(1440)).toBe(WIDE);
    // Held sideways: narrow by width, short by height.
    expect(geometryFor(844, 390)).toBe(NARROW_SHORT);
    expect(geometryFor(844, SHORT_BELOW_PX)).toBe(NARROW);
    expect(geometryFor(1440, 390)).toBe(WIDE);
  });

  it("keeps the instrument's invariants: the regions are ordered and nothing overlaps or leaves the canvas", () => {
    for (const g of [WIDE, NARROW, NARROW_SHORT]) {
      // Left to right: frame, chamber, the field's end, the fade, the strip, the block, the margin.
      expect(g.FRAME_LEFT).toBeGreaterThanOrEqual(0);
      expect(g.CHAMBER_LEFT).toBeGreaterThan(g.FRAME_LEFT);
      expect(g.split).toBeGreaterThan(g.CHAMBER_LEFT);
      expect(g.FIELD_FADE_END).toBeGreaterThanOrEqual(g.split);
      expect(g.STRIP_RIGHT - g.STRIP_WIDTH).toBeGreaterThan(g.FIELD_FADE_END);
      expect(g.BLOCK_RIGHT - g.BLOCK_WIDTH).toBeGreaterThan(g.STRIP_RIGHT);
      expect(g.BLOCK_RIGHT).toBeLessThanOrEqual(1);
      // Top to bottom: the header, the block, a margin, the panel band.
      expect(g.BLOCK_TOP).toBeGreaterThan(0);
      expect(g.BLOCK_TOP + g.BLOCK_EXTENT + g.PANEL_BAND).toBeLessThan(1);
      expect(g.CHAMBER_TOP).toBe(g.BLOCK_TOP);
      expect(g.CHAMBER_EXTENT).toBe(g.BLOCK_EXTENT);
    }
  });

  it("gives a phone a block column a reader can see rows in", () => {
    // 24% of 390px is 94px; the wide proportion would be 62px.
    expect(Math.round(NARROW.BLOCK_WIDTH * 390)).toBeGreaterThanOrEqual(90);
    expect(NARROW.BLOCK_WIDTH).toBeGreaterThan(WIDE.BLOCK_WIDTH);
    // And the wide constants are the wide geometry, exactly: nothing pinned
    // by the tests above has moved.
    expect(WIDE.BLOCK_WIDTH).toBe(BLOCK_WIDTH);
    expect(WIDE.PANEL_BAND).toBe(PANEL_BAND);
    expect(WIDE.split).toBe(0.55);
  });
});
