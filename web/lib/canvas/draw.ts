import type { Hex } from "@/types/stream";
import { rgba, type Palette, type Rgb } from "@/lib/tokens";
import { tipOf, type WorldState } from "@/lib/canvas/world";
import { FLOOR_BAND, type FeeTick } from "@/lib/canvas/layout";

/**
 * Drawing. Pure in `(ctx, state, palette, view, now)` — no clock, no stream,
 * no React. Call it twice with the same arguments and you get the same pixels,
 * which is what makes it verifiable without a running animation.
 *
 * ## Pass order is load-bearing
 *
 * `lighter` and `source-over` cannot be mixed per entity in a single pass, so
 * the frame is drawn in a fixed order:
 *
 *   1. clear to `--void`
 *   2. **emissive pass** (`lighter`) — the pending field. Additive, so density
 *      is what produces brightness.
 *   3. **matte pass** (`source-over`) — the settled block. Opaque, sits on top.
 *   4. chrome — rules and labels.
 *
 * The mempool must come first. Drawn after the block, additive blending would
 * brighten the settled stack, and "pending glows, confirmed weighs" is the
 * whole metaphor.
 */

export type View = {
  /** CSS pixels. The backing store is this times `dpr`. */
  width: number;
  height: number;
  dpr: number;
  /** Fraction of the width where the mempool field ends and the block begins. */
  split: number;
  /**
   * The instrument's proportions for this width. Absent on a hand-made view
   * (tests), which means the wide instrument.
   */
  g?: Geometry;
};

/** Maps a fee to a position on the cold ramp. Phase 3 replaces this. */
export type FeeScale = (fee: number) => number;

export type DrawOptions = {
  /** During calibration nothing may be marked. Rule 1. */
  showGhosts: boolean;
  /** Fee-axis ticks. Empty until the rolling window has enough samples. */
  ticks: readonly FeeTick[];
  /**
   * Multiplier on the mark radius.
   *
   * The honest lever on how much of the screen the field occupies: it changes
   * the surface one transaction takes up and nothing else. No datum moves, no
   * ramp floor is lifted, no distribution is reshaped.
   */
  markScale: number;
  /** No drift, no flash, no flight. Everything still lands. */
  reducedMotion: boolean;
  /**
   * The transaction the reader is pointing at, or has pinned.
   *
   * Drawn as a ring around the mark or the row, and — for a public row — its
   * track brought up and its origin ringed too, so pointing at a row answers
   * "where did this come from" on the picture and not only on the panel. A
   * private row gets the ring and nothing else, because nothing else is
   * there; that absence is the answer.
   */
  highlight?: { hash: Hex; where: "mempool" | "block" | "previous" } | null;
  /**
   * Which tracks are drawn: every public row's, or only the pointed-at one's.
   *
   * A rendering budget, like the entity cap. Tracks are up to a block's worth
   * of additive one-pixel lines for eleven seconds after every block, and on
   * a device the governor has already had to cut they are the next thing to
   * give. The pointed-at row keeps its track either way, because that one is
   * an answer to a question and not atmosphere. Default `"all"`.
   *
   * Measured before the lever was wired: on a desktop at a full block of 113
   * public rows, the tracks cost 0.10ms of a 0.52ms frame — a tenth of a
   * frame budget nobody was near. The cut exists for the devices the governor
   * has already had to cut, where the same tenth is not free.
   */
  tracks?: "all" | "lit";
};

/** Ring radius around a highlighted mark, in CSS pixels. */
const HIGHLIGHT_RING = 6;

const DEFAULT_OPTIONS: DrawOptions = {
  showGhosts: true,
  ticks: [],
  markScale: 1,
  reducedMotion: false,
};

/**
 * The grid.
 *
 * Drawn in --rule-hair, which is two steps off the field it sits on. It has to
 * be at the very edge of visible: squint and it should go before the traces do,
 * because a grid that competes with the data is a grid that has stopped being a
 * reference and started being a pattern.
 *
 * The lines are the fee axis. Putting them at round gwei values rather than at
 * even spacings is the whole point — it is what turns a scattered field into a
 * set of readings.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  view: View,
  ticks: readonly FeeTick[],
): void {
  const geo = geom(view);
  const right = view.width * geo.FIELD_FADE_END;
  const half = 0.5 / view.dpr;
  const snap = (y: number) =>
    Math.round(y * view.dpr) / view.dpr + half;

  /**
   * The grid is the chamber's axis. It exists where the chamber measures and
   * nowhere else.
   *
   * It first ran to `FIELD_FADE_END` at full strength and stopped dead, which
   * put a hard terminus at 75% of the width while the fog ended at 55%. That
   * was replaced by a dissolve across the whole crossing — which fixed the hard
   * edge and introduced a subtler version of the same fault: two rectangles
   * that do not coincide. Measured on the 0.2 gwei rule, luminance over the
   * ground beneath it:
   *
   *     x/width   0.40   0.50   0.55*   0.60   0.65   0.70   0.74
   *     grid     14.44  15.23  14.51  11.94   9.29   5.65   2.00
   *                            *the bracket
   *
   * Full strength ended at the bracket, correctly, but a legible tail carried
   * on for another 200px toward the strip, so the registration marks framed one
   * rectangle and the grid suggested a wider one.
   *
   * The tail is now a quarter of the crossing: long enough that the axis ends
   * by dissolving rather than by being cut, short enough that it does not claim
   * ground the chamber does not measure.
   *
   * Not the ground's literal alpha stops, which would be the other reading of
   * "the same curve": the ground steps to 0.78 across the field before it
   * begins to dissolve, and copying that would make the axis fainter to the
   * right. An axis has to be uniform wherever it measures — a rule that dims
   * along its own length is a scale that changes as you read it.
   */
  const dissolve = ctx.createLinearGradient(0, 0, right, 0);
  const hold = view.split / geo.FIELD_FADE_END;
  const GRID_TAIL = 0.25;
  const gone = hold + (1 - hold) * GRID_TAIL;
  dissolve.addColorStop(0, rgba(palette.ruleHair, 1));
  dissolve.addColorStop(hold, rgba(palette.ruleHair, 1));
  dissolve.addColorStop(gone, rgba(palette.ruleHair, 0));
  dissolve.addColorStop(1, rgba(palette.ruleHair, 0));

  if (ticks.length > 0) {
    ctx.strokeStyle = dissolve;
    ctx.lineWidth = 1 / view.dpr;
    ctx.beginPath();
    for (const tick of ticks) {
      // Only the 1-2-5 spine carries a rule. Every tick gets a numeral at the
      // margin, but a rule costs ink across the measured volume and the grid
      // has to disappear before the traces do.
      if (!tick.ruled) continue;
      // Snapped, or a hairline at a fractional y is smeared across two rows and
      // ends up dimmer than intended in one place and brighter in another.
      const y = snap(chamberY(view, tick.height));
      ctx.moveTo(view.width * geo.CHAMBER_LEFT, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();

    // A tick on the spine for every labelled value, longer for the ruled ones.
    // A rule alone is a guide; a tick is a scale, and this is a measurement.
    ctx.strokeStyle = rgba(palette.rule, 1);
    ctx.beginPath();
    for (const tick of ticks) {
      const y = snap(chamberY(view, tick.height));
      const spine = view.width * geo.CHAMBER_LEFT;
      ctx.moveTo(spine, y);
      ctx.lineTo(spine + (tick.ruled ? 9 : 5), y);
    }
    ctx.stroke();

    // The halfway minor ticks are gone: the candidate sequence is dense enough
    // that they landed on top of real values and implied subdivisions that are
    // not where they appeared to be.
  }

  // The band's top: where the axis ends and the floor begins. One hairline on
  // the grid's own dissolve, so it is a rule of the scale and not a box.
  if (ticks.length > 0) {
    ctx.strokeStyle = dissolve;
    ctx.lineWidth = 1 / view.dpr;
    ctx.beginPath();
    const y = snap(chamberY(view, 1 - FLOOR_BAND));
    ctx.moveTo(view.width * geo.CHAMBER_LEFT, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }

  drawScaleSpine(ctx, palette, view, ticks.length > 0);
  drawRegionSeparators(ctx, palette, view);
  drawChamberMarks(ctx, palette, view);
}

/**
 * The vertical rule the fee ticks hang from.
 *
 * Without it the ticks are marks floating at the edge of the screen. With it
 * they are subdivisions of one axis, which is the difference between a set of
 * labels and a scale.
 */
function drawScaleSpine(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  view: View,
  active: boolean,
): void {
  const geo = geom(view);
  if (!active) return;
  const x =
    Math.round(view.width * geo.CHAMBER_LEFT * view.dpr) / view.dpr +
    0.5 / view.dpr;
  ctx.strokeStyle = rgba(palette.rule, 1);
  ctx.lineWidth = 1 / view.dpr;
  ctx.beginPath();
  ctx.moveTo(x, chamberY(view, 0));
  ctx.lineTo(x, chamberY(view, 1));
  ctx.stroke();
}

/**
 * Registration marks at the corners of the observed volume.
 *
 * Not a border — a border would box the chamber in and fight the gradient that
 * dissolves it into the block. Corner marks state the extent of the
 * measurement without enclosing it, which is what they do on an optical bench.
 */
/**
 * What tells the four regions apart.
 *
 * Measured on the running app before this existed, luminance along a scanline
 * through the observed band: chamber to crossing fell 11.01 to 6.79 over 308px,
 * which is the ground's dissolution doing its job. The other two junctions were
 * flat: crossing to previous block, 22.8px of ground at 6.79 either side, and
 * previous block to block, 18.2px at 6.79. Two of the three boundaries were
 * marked by nothing at all, and the chamber's four registration marks carry
 * 13px arms across an 822px span — 1.6% of the width — so they read as four
 * loose corners rather than as one rectangle.
 *
 * Two candidates were drawn and measured. Vertical hairlines down the middle of
 * each empty gap read 25.23 against the ground's 6.79 and marked both missing
 * boundaries, for 1,714,451 units of ink above ground across the observed band.
 * These rules cost 1,773,975 — 3.5% more — and were chosen anyway, because the
 * dividers answer only half the question. They mark boundaries; they do not
 * group. Four regions standing on the same two lines are legible as four
 * *regions*, and the breaks between the lines are the boundaries, so one gesture
 * does both. Nothing vertical is drawn, so nothing is boxed in, and the
 * chamber's segment dissolves on exactly the curve the ground and the grid use
 * — a hard edge there would fight a dissolution that is already correct.
 *
 * The corner marks stay brighter: --rule at 38.7 against --rule-hair at 25.2,
 * so the ends of the chamber's line still read as registration marks rather
 * than dissolving into it.
 */
function drawRegionSeparators(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  view: View,
): void {
  const geo = geom(view);
  const half = 0.5 / view.dpr;
  const snap = (n: number) => Math.round(n * view.dpr) / view.dpr + half;
  const top = snap(chamberY(view, 0));
  const bottom = snap(chamberY(view, 1));
  const stripLeft = view.width * (geo.STRIP_RIGHT - geo.STRIP_WIDTH);
  const stripRight = view.width * geo.STRIP_RIGHT;
  const blockLeft = view.width * (geo.BLOCK_RIGHT - geo.BLOCK_WIDTH);
  const blockRight = view.width * geo.BLOCK_RIGHT;

  ctx.lineWidth = 1 / view.dpr;

  // Rules: each region stands on the same two lines, and the breaks between
  // them are the boundaries. Nothing vertical, so nothing is boxed in.
  for (const y of [top, bottom]) {
    // The chamber's runs at full strength across the measured volume and then
    // dissolves on exactly the curve the ground and the grid use, so the
    // crossing is defined by the dissolve on one side and a break on the other.
    const fade = ctx.createLinearGradient(0, 0, view.width * geo.FIELD_FADE_END, 0);
    const hold = view.split / geo.FIELD_FADE_END;
    fade.addColorStop(0, rgba(palette.ruleHair, 1));
    fade.addColorStop(hold, rgba(palette.ruleHair, 1));
    fade.addColorStop(1, rgba(palette.ruleHair, 0));
    ctx.strokeStyle = fade;
    ctx.beginPath();
    ctx.moveTo(snap(view.width * geo.FRAME_LEFT), y);
    ctx.lineTo(view.width * geo.FIELD_FADE_END, y);
    ctx.stroke();

    ctx.strokeStyle = rgba(palette.ruleHair, 1);
    ctx.beginPath();
    ctx.moveTo(snap(stripLeft), y);
    ctx.lineTo(snap(stripRight), y);
    ctx.moveTo(snap(blockLeft), y);
    ctx.lineTo(snap(blockRight), y);
    ctx.stroke();
  }
}

function drawChamberMarks(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  view: View,
): void {
  const geo = geom(view);
  const half = 0.5 / view.dpr;
  const snap = (n: number) => Math.round(n * view.dpr) / view.dpr + half;
  const left = snap(view.width * geo.FRAME_LEFT);
  // The measured volume, which is where the fog is — not where the ground
  // finishes dissolving. Marking the far edge of the dissolve claimed a volume
  // 37% wider than anything ever entered, so the chamber read as mostly empty
  // when it was in fact full.
  const right = snap(view.width * view.split);
  const top = snap(chamberY(view, 0));
  const bottom = snap(chamberY(view, 1));
  const arm = 13;

  ctx.strokeStyle = rgba(palette.rule, 1);
  ctx.lineWidth = 1 / view.dpr;
  ctx.beginPath();
  for (const [x, y, dx, dy] of [
    [left, top, 1, 1],
    [right, top, -1, 1],
    [left, bottom, 1, -1],
    [right, bottom, -1, -1],
  ] as const) {
    ctx.moveTo(x + dx * arm, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * arm);
  }
  ctx.stroke();
}

/**
 * Samples the cold ramp at `position` in 0..1, interpolating between stops.
 *
 * Rule 2: this axis carries fee priority and nothing else. Age is applied
 * separately, as alpha, and the two never cross.
 */
export function sampleRamp(palette: Palette, position: number): Rgb {
  const ramp = palette.trace;
  const clamped = Math.min(1, Math.max(0, position));
  const scaled = clamped * (ramp.length - 1);
  const low = Math.floor(scaled);
  const high = Math.min(ramp.length - 1, low + 1);
  const t = scaled - low;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return {
    r: mix(ramp[low].r, ramp[high].r),
    g: mix(ramp[low].g, ramp[high].g),
    b: mix(ramp[low].b, ramp[high].b),
    a: 1,
  };
}

/**
 * Radius in CSS pixels for a given ramp position.
 *
 * Fee drives thickness as well as luminance. That is not a second axis — it is
 * the same axis expressed twice, which is what makes an expensive transaction
 * read as expensive at a glance rather than after a colour comparison.
 */
/**
 * Mark radius, in CSS pixels before the device scale.
 *
 * Constant, and that is the point. It used to be `(0.9 + position * 1.9)`,
 * which made the mark bigger the more the transaction paid — an undeclared
 * third channel for fee, on top of the two the design system names.
 *
 * Fee is already luminance (a 4.36x range across the ramp) and height. Adding
 * area to that gave it a 9.7x range as well, and the three compounded: a cheap
 * transaction was dim *and* small *and* low, so it vanished three times over,
 * while an expensive one shouted three times. Measured on a live pool of 300,
 * the cheapest fifth held 24% of the population and 7.9% of the ink; the
 * dearest fifth held 19% of the population and 34.7%. The chamber read as
 * uniform noise at the bottom and as a handful of stars at the top, and neither
 * was the distribution.
 *
 * A cloud chamber has no large and small particles. A track is a track; what
 * varies is how bright it is and where. Radius proportional to fee was an
 * infographic habit that crept in.
 *
 * The value is area-preserving against the old ramp: the same total ink over
 * the same population, redistributed to match it.
 */
const MARK_RADIUS = 1.9;

function radiusFor(_position: number, scale: number): number {
  return MARK_RADIUS * scale;
}

/**
 * Ceiling on what a single mark may contribute in the additive pass.
 *
 * Without it, one transaction at the top of the ramp renders at full `--t-core`
 * and clips to white on its own — measured at luminance 255 against a ramp top
 * of 250, with a single 10 gwei transaction already saturating. Two overlapping
 * marks then read only 1.5× one instead of 2×, because there is no headroom
 * left, and the entire fee axis collapses into "bright".
 *
 * Holding a single mark well under the top keeps the ramp legible and leaves
 * accumulation somewhere to go, which is what `lighter` is for.
 *
 * Raised from 0.38 after measuring the headroom it was protecting: across the
 * whole chamber at a full pool, the brightest channel reached 111 of 255 with
 * zero pixels within five counts of clipping — a 2.3x margin. The cheapest
 * fresh mark, meanwhile, sat at a Weber ratio of about 2.2 over its ground:
 * legible but tight, and the whole emissive range scales with this constant.
 * 0.45 spends a measured slice of a measured margin on the end of the ramp
 * that needed it; the worst pixel lands near 131, still under half of
 * clipping.
 */
const SINGLE_MARK_CEILING = 0.45;

/** Rec. 709 luminance. The same weighting every measurement here has used. */
function luminance(colour: Rgb): number {
  return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
}

/**
 * The luminance, over the field, at which a mark stops being perceptible.
 *
 * Not a chosen number: it is `--rule-hair` over `--field`, and the design
 * system already declares the grid drawn in `--rule-hair` to be at the limit of
 * visible. Deriving it from the tokens means the floor follows the palette
 * instead of drifting away from it.
 *
 * Measured on canvas at 14.3 against 13.4 computed, the gap being the field's
 * fade gradient under the sample point.
 */
function perceptibleFloor(palette: Palette): number {
  return Math.max(1, luminance(palette.ruleHair) - luminance(palette.field));
}

/** Curvature of the decay. Higher fades early, lower fades late. */
const DECAY_SHAPE = 3;
const DECAY_END = Math.exp(-DECAY_SHAPE);

export function render(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  palette: Palette,
  view: View,
  now: number,
  feeScale: FeeScale,
  options: DrawOptions = DEFAULT_OPTIONS,
): void {
  const geo = geom(view);
  const { width, height } = view;

  // 1. Clear. Rule 3: the ground is --void, never #000.
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = rgba(palette.void, 1);
  ctx.fillRect(0, 0, width, height);

  // The field is a hair lighter than the canvas, so it reads as a place rather
  // than as the absence of one — but it fades out rather than ending.
  //
  // A hard edge at the split would turn the 420ms flight into a transaction
  // hopping from one widget to another. It has to read as crossing the same
  // chamber, so the boundary is a gradient and there is no rule drawn on it.
  //
  // The gradient runs all the way to where the block begins rather than
  // stopping shortly after the entities do. Ending it early left a band of
  // flat void between the two, which is what made the composition read as two
  // panels with a hole between them.
  const fadeEnd = width * geo.FIELD_FADE_END;
  const fade = ctx.createLinearGradient(0, 0, fadeEnd, 0);
  fade.addColorStop(0, rgba(palette.field, 1));
  // Held near full across the populated field, then dissolving over the empty
  // run, so the field ends by dissolving rather than by stopping.
  fade.addColorStop(view.split / geo.FIELD_FADE_END, rgba(palette.field, 0.78));
  fade.addColorStop(1, rgba(palette.field, 0));
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, fadeEnd, height);

  // 2. The grid, under everything. It is the fee axis, not decoration: each
  //    line is where a round gwei value falls, so a trace's height is readable
  //    instead of merely relative.
  drawGrid(ctx, palette, view, options.ticks);

  // 3. Emissive. Mempool first, always: drawn after the block, additive
  //    blending would brighten the settled stack and "pending glows, confirmed
  //    weighs" would stop being true.
  drawEmissivePass(ctx, state, palette, view, now, feeScale, options.markScale);
  drawTracks(
    ctx,
    state,
    palette,
    view,
    feeScale,
    options.highlight ?? null,
    options.tracks ?? "all",
  );
  drawHighlight(ctx, state, palette, view, options.highlight ?? null);

  // 3. Matte.
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  drawBlockPass(ctx, state, palette, view, now, feeScale, options);

  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
}

/**
 * Block geometry, as fractions of the canvas width.
 *
 * The live column sits against the right edge with only a breathing margin.
 * It used to end at 0.9, which left 153px of dead canvas beyond it for no
 * reason — measured, the right-hand tenth of the screen carried zero ink.
 */
export const BLOCK_RIGHT = 0.975;
export const BLOCK_WIDTH = 0.16;
/** The compressed previous block, tucked just left of the live one. */
export const STRIP_WIDTH = 0.035;
const STRIP_GAP = 0.012;
export const STRIP_RIGHT = BLOCK_RIGHT - BLOCK_WIDTH - STRIP_GAP;
/** Where the field's gradient stops, just short of the receding strip. */
export const FIELD_FADE_END = STRIP_RIGHT - STRIP_WIDTH - 0.015;

/**
 * Vertical margins for the block column.
 *
 * The top margin is not only breathing room: the column headers live in it,
 * and they have to clear the calibration bar when it is showing.
 */
/**
 * Where the chamber begins: the axis line, and the left edge of the fog.
 *
 * The left of the instrument used to be three alignments in forty-four pixels —
 * spine at 0.5, bracket corner at 2.5, numerals at 14 — all jammed against the
 * viewport edge, so the frame did not read as enclosing anything and the scale
 * read as hanging off the side.
 *
 * Now there is one rectangle. The frame encloses the measured volume *and* its
 * scale, because the scale is part of the instrument and not an annotation
 * beside it: numerals in the gutter, axis line, then the volume.
 */
export const CHAMBER_LEFT = 0.04;

/** Room between the frame's edge and the axis, for the numerals. */
const SCALE_GUTTER = 0.031;

/** The frame's left edge. Derived, so the two can never drift apart. */
export const FRAME_LEFT = CHAMBER_LEFT - SCALE_GUTTER;

export const BLOCK_TOP = 0.105;

/**
 * Height reserved at the foot of the canvas for the instrument panel.
 *
 * The panel is the apparatus; the chamber and the stack are what it reads. It
 * must never sit over them — a readout covering its own measurement is the one
 * thing an instrument may not do.
 */
export const PANEL_BAND = 0.175;
export const BLOCK_EXTENT = 1 - BLOCK_TOP - PANEL_BAND - 0.02;

/**
 * The observed volume.
 *
 * Registered to the block: same top edge, same bottom edge. The chamber and
 * the stack are two readings of one apparatus, so they share a vertical
 * register rather than each floating in its own margin. It also gives the
 * corner marks something true to delimit — the rectangle is where the
 * measurement happens, not a decorative frame.
 */
export const CHAMBER_TOP = BLOCK_TOP;
export const CHAMBER_EXTENT = BLOCK_EXTENT;

/**
 * The instrument's proportions, as one object, so that a portrait screen can
 * have its own.
 *
 * The constants above are the wide instrument and stay exported: every
 * calibration in the tests pins them. `NARROW` is the same instrument laid
 * out for a phone held upright — the chamber and the block keep their
 * meaning and their register, and only the split of the width changes: a
 * wider block column (rows have to read at 390px), a shorter crossing, and
 * a taller panel band for a panel that stacks. Everything that draws or
 * places reads `view.g` rather than a constant; a view without one is wide.
 */
export type Geometry = {
  BLOCK_RIGHT: number;
  BLOCK_WIDTH: number;
  STRIP_WIDTH: number;
  STRIP_RIGHT: number;
  FIELD_FADE_END: number;
  CHAMBER_LEFT: number;
  FRAME_LEFT: number;
  BLOCK_TOP: number;
  PANEL_BAND: number;
  BLOCK_EXTENT: number;
  CHAMBER_TOP: number;
  CHAMBER_EXTENT: number;
  /** Fraction of the width where the populated field ends. */
  split: number;
};

export const WIDE: Geometry = {
  BLOCK_RIGHT,
  BLOCK_WIDTH,
  STRIP_WIDTH,
  STRIP_RIGHT,
  FIELD_FADE_END,
  CHAMBER_LEFT,
  FRAME_LEFT,
  BLOCK_TOP,
  PANEL_BAND,
  BLOCK_EXTENT,
  CHAMBER_TOP,
  CHAMBER_EXTENT,
  /**
   * Lowered from 0.62 after measuring: the field carried 0.32% ink coverage
   * across 62% of the screen while the block column carried 78% across 11%.
   * Narrowing the field also lengthens the flight rather than shortening it —
   * mean travel 973px → 1060px, and the shortest flight, which is the one at
   * risk of being unreadable, 422px → 623px.
   */
  split: 0.55,
};

/** Below this CSS width the instrument is the portrait one. Shared with the stylesheet's lg breakpoint. */
export const NARROW_BELOW_PX = 1024;

export const NARROW: Geometry = (() => {
  // A block column a reader can see rows in: 24% of 390px is 94px, against
  // 62px for the wide proportion. The strip stays, thin; the crossing shrinks
  // to what a 390px flight can use. The numerals sit inside the chamber on a
  // phone (see the stylesheet), so the gutter is a margin, not a column.
  const BLOCK_RIGHT = 0.97;
  const BLOCK_WIDTH = 0.24;
  const STRIP_WIDTH = 0.03;
  const STRIP_GAP = 0.012;
  const STRIP_RIGHT = BLOCK_RIGHT - BLOCK_WIDTH - STRIP_GAP;
  const FIELD_FADE_END = STRIP_RIGHT - STRIP_WIDTH - 0.015;
  const CHAMBER_LEFT = 0.06;
  const FRAME_LEFT = 0.02;
  const BLOCK_TOP = 0.11;
  // The stacked panel: the figure with its scale, four readings, the plate.
  // Measured at 390×844: 150 + 60 + 36px, under 0.30 of the height.
  const PANEL_BAND = 0.3;
  const BLOCK_EXTENT = 1 - BLOCK_TOP - PANEL_BAND - 0.02;
  return {
    BLOCK_RIGHT,
    BLOCK_WIDTH,
    STRIP_WIDTH,
    STRIP_RIGHT,
    FIELD_FADE_END,
    CHAMBER_LEFT,
    FRAME_LEFT,
    BLOCK_TOP,
    PANEL_BAND,
    BLOCK_EXTENT,
    CHAMBER_TOP: BLOCK_TOP,
    CHAMBER_EXTENT: BLOCK_EXTENT,
    split: 0.63,
  };
})();

/**
 * A phone held sideways: narrow by the stylesheet's rule, but short. The
 * region names need the same pixels they always need, so the header takes a
 * larger share; the panel keeps its share and drops what a 390px-tall screen
 * cannot hold (see `.df-phone-extra` in the stylesheet).
 */
export const SHORT_BELOW_PX = 500;
export const NARROW_SHORT: Geometry = (() => {
  const BLOCK_TOP = 0.16;
  // Measured at 844×390: the figure with its scale and the plate are 128px,
  // a third of the height, not the portrait panel's 0.30.
  const PANEL_BAND = 0.33;
  const BLOCK_EXTENT = 1 - BLOCK_TOP - PANEL_BAND - 0.02;
  return { ...NARROW, BLOCK_TOP, PANEL_BAND, BLOCK_EXTENT, CHAMBER_TOP: BLOCK_TOP, CHAMBER_EXTENT: BLOCK_EXTENT };
})();

export function geometryFor(width: number, height = Number.POSITIVE_INFINITY): Geometry {
  if (width >= NARROW_BELOW_PX) return WIDE;
  return height < SHORT_BELOW_PX ? NARROW_SHORT : NARROW;
}

/** The view's geometry, wide when the view carries none. */
export function geom(view: View): Geometry {
  return view.g ?? WIDE;
}

/** Normalised field height → CSS pixels, for canvas and chrome alike. */
/** Normalised chamber position → an x in CSS pixels. Mate of `chamberY`. */
export function chamberX(view: View, normalised: number): number {
  const geo = geom(view);
  return (
    view.width * (geo.CHAMBER_LEFT + normalised * (view.split - geo.CHAMBER_LEFT))
  );
}

export function chamberY(view: View, normalised: number): number {
  const geo = geom(view);
  return view.height * (geo.CHAMBER_TOP + normalised * geo.CHAMBER_EXTENT);
}
/** How far position 0 sticks out to the left of the column. */
export const TOP_SLOT_TAB = 9;

/**
 * Narrowest a row may be drawn, as a fraction of the column.
 *
 * Gas spans roughly twenty to one within a block, so a plain 21,000 transfer
 * against a 400,000 contract call would come out at 5% of the width and read
 * as absent rather than as small. The floor keeps the cheapest transaction on
 * the chain legible while leaving most of the range to say something.
 */
export const MIN_ROW_WIDTH = 0.18;

/**
 * The share of the column a row takes, from its gas over the block's largest.
 *
 * Square root, not linear — and this was measured on mainnet, not chosen.
 * The generator's gas tops out at 500,000, so a plain transfer against the
 * biggest call in a block came out near the 18% floor and everything else
 * spread across the column. A real block carries rollup batches: in the
 * recording, 6.66M gas at the top of one block and 5.22M in another. Linear
 * over that, a 21,000 transfer is 0.3% of the column and *every* ordinary
 * transaction sits on the floor — measured, the live column read as a spine
 * with one bar, and width said nothing about 95% of the rows.
 *
 * The root keeps the order and the endpoints and spends the column on the
 * range where the rows actually are: 21,000 against 400,000 is 0.23 of the
 * span instead of 0.05; against 6.66M it is 0.056 instead of 0.003, which is
 * the difference between a legible row and the floor. The reference under
 * the column says √, because a scale a reader cannot name is a scale they
 * will read as linear.
 */
export function gasWidthFraction(gas: number, maxGas: number): number {
  if (maxGas <= 0) return 1;
  const share = Math.sqrt(Math.min(1, Math.max(0, gas / maxGas)));
  return MIN_ROW_WIDTH + (1 - MIN_ROW_WIDTH) * share;
}

/**
 * Row width from gas used, normalised over the largest in the same block.
 *
 * Gas is the horizontal axis, class is the tone, and the two never cross: a
 * ghost and a seen transaction of the same size are drawn at exactly the same
 * width and exactly the same thickness. Only the colour differs.
 */
export function widthForGas(
  fullWidth: number,
  gas: number,
  maxGas: number,
): number {
  return fullWidth * gasWidthFraction(gas, maxGas);
}

/**
 * Where a block slot sits, in CSS pixels.
 *
 * Snapped to whole device pixels. A block of 150 rows gives a ~5px pitch, and
 * an unsnapped 1.26px gap lands on fractional coordinates where antialiasing
 * smears it into the rows either side — measured, only 45% of the 149 gaps were
 * dark enough to read, so the stack looked like one solid brick rather than a
 * countable list of transactions. Snapping spends a fraction of a pixel of
 * regularity to buy a gap that is actually there.
 */
export function slotRect(
  view: View,
  index: number,
  count: number,
  compressed: boolean,
) {
  const geo = geom(view);
  const columnWidth = view.width * (compressed ? geo.STRIP_WIDTH : geo.BLOCK_WIDTH);
  const right = view.width * (compressed ? geo.STRIP_RIGHT : geo.BLOCK_RIGHT);
  const left = right - columnWidth;
  const top = view.height * geo.BLOCK_TOP;
  const pitch = (view.height * geo.BLOCK_EXTENT) / Math.max(1, count);

  const device = 1 / view.dpr;
  const snap = (value: number) => Math.round(value * view.dpr) / view.dpr;
  const y = snap(top + index * pitch);
  const next = snap(top + (index + 1) * pitch);

  return {
    x: left,
    y,
    width: columnWidth,
    // One device pixel of gap, guaranteed, whatever the pitch works out to.
    height: Math.max(device, next - y - device),
  };
}

/**
 * The settled block. Matte: opaque, edged, no glow.
 *
 * Everything about this pass is the opposite of the emissive one, and that is
 * the point — the transition from one material to the other is what the
 * project is about. Pending glows because it might still happen; confirmed
 * weighs because it did.
 */
/**
 * The line a full-width row ends on.
 *
 * Row width is gas normalised over the block's own maximum, so the left edge of
 * the column is a datum: it is where the largest transaction in this block
 * reaches, and the figure beside it on the panel — "247K largest in this
 * block" — names exactly this width.
 *
 * It was not drawn, and its absence was legible as a fault: a row at full width
 * ended in open canvas with nothing to end against, so it read as spilling into
 * the gap. Measured, nothing spills — the widest row is 243.04px against a
 * 243.0px column, a ratio of 1.000. What was missing was the edge that says so.
 *
 * Behind the rows, in --rule, one device pixel. It is a reference, not a frame:
 * the column has no other sides, because the other three are not data.
 */
function drawGasDatum(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  view: View,
  rightFraction: number,
  widthFraction: number,
): void {
  const geo = geom(view);
  const half = 0.5 / view.dpr;
  const x =
    Math.round(view.width * (rightFraction - widthFraction) * view.dpr) /
      view.dpr +
    half;
  ctx.strokeStyle = rgba(palette.rule, 1);
  ctx.lineWidth = 1 / view.dpr;
  ctx.beginPath();
  ctx.moveTo(x, view.height * geo.BLOCK_TOP);
  ctx.lineTo(x, view.height * (geo.BLOCK_TOP + geo.BLOCK_EXTENT));
  ctx.stroke();
}

function drawBlockPass(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  palette: Palette,
  view: View,
  now: number,
  feeScale: FeeScale,
  options: DrawOptions,
): void {
  const geo = geom(view);
  // Datums first: the rows are marks on the scale, so they sit on top of it.
  /**
   * How far the previous block has travelled from the column to the strip.
   *
   * Eased with the same curve the flight uses, so the two motions on this
   * screen are the same motion. Reduced motion skips it: the strip is simply
   * there, which is the honest presentation when movement is unwanted.
   */
  const handover = state.reducedMotion
    ? 1
    : state.landEase(
        Math.min(
          1,
          Math.max(
            0,
            (state.elapsedMs - state.handoverStartMs) / BLOCK_HANDOVER_MS,
          ),
        ),
      );

  if (state.previousBlock.length > 0) {
    // Faded in rather than moved: at the start of the handover the strip's own
    // datum would sit exactly under the live column's, and two scales drawn on
    // top of each other is not a scale.
    ctx.globalAlpha = 0.45 * handover;
    drawGasDatum(ctx, palette, view, geo.STRIP_RIGHT, geo.STRIP_WIDTH);
    ctx.globalAlpha = 1;
  }
  drawGasDatum(ctx, palette, view, geo.BLOCK_RIGHT, geo.BLOCK_WIDTH);

  if (state.previousBlock.length > 0) {
    // History, compressed to a strip: the block before this one, and nothing
    // more. It keeps its ghost rows, because a past block flattened to one grey
    // throws away the only thing about it still worth seeing.
    //
    // It used to be justified as the comparison — is this block unusual, or is
    // a quarter of every block private flow? It is not, and it cannot be. That
    // is a question about a population and this is a sample of two, drawn with
    // no threshold and read by eye. The band under the primary reading answers
    // it properly: twelve blocks minimum, an explicit n/N while it fills, and
    // a stated 82% recovery of the true spread even then.
    //
    // Growing this into N columns was measured rather than assumed. At the
    // band's own threshold of twelve, each strip comes out 14.6px wide with its
    // narrowest row at 2.6px — under the 8px floor this project already fixed
    // as the difference between a mark and a hairline, and at 45% alpha on top.
    // Twelve columns would also consume the entire 314px crossing, which is the
    // one region the 420ms flight needs in order to read as crossing a chamber
    // rather than hopping between panels. Five fit at current legibility, and
    // five is not twelve: it would reproduce the same two-standards problem
    // with different numbers.
    // Full strength where it left, 45% where it lands: it is receding, and
    // dimming as it goes is what receding looks like.
    ctx.globalAlpha = 1 + (0.45 - 1) * handover;
    for (const mark of state.previousBlock) {
      const from = slotRect(view, mark.slotIndex, state.previousBlock.length, false);
      const to = slotRect(view, mark.slotIndex, state.previousBlock.length, true);
      // Only x and width differ: both columns run the same slot pitch down the
      // same extent, so a row keeps its height and its place in the order the
      // whole way across, and the block narrows rather than reshuffling.
      const rect = {
        x: from.x + (to.x - from.x) * handover,
        y: to.y,
        width: from.width + (to.width - from.width) * handover,
        height: to.height,
      };
      // The same width function as the live block, over this block's own gas
      // maximum. Not an accident of symmetry — the comparison depends on it.
      //
      // This strip used to draw every row at the full column width, on the
      // argument that a 50px column could not afford a second variable. That
      // was wrong, and measurably so: with width carrying gas in one column and
      // nothing in the other, the two warm areas answer different questions.
      // Measured on two blocks of identical composition (25.3% by count, 50.4%
      // by gas), the live column read 42.6% warm and the strip read 25.4% — a
      // seventeen-point gap produced entirely by the encoding, with nothing on
      // screen to say the two figures were not the same figure.
      //
      // The strip exists so a reader can ask whether this block is unusual.
      // Two columns measuring different quantities cannot answer that, and a
      // label saying so would not fix it: nobody re-weights two pictures in
      // their head. Legibility was never really the cost either — the 18%
      // floor puts the narrowest row at 9.1px of 50.4px, which is a mark.
      const isGhost = mark.origin === "ghost" && options.showGhosts;
      const gasWidth = widthForGas(
        rect.width,
        mark.gas,
        state.previousBlockMaxGas,
      );
      ctx.fillStyle = rgba(isGhost ? palette.ghostSettled : palette.settled, 1);
      // Right-anchored, like the live block, so the variation reads leftward
      // off a straight spine in both columns.
      ctx.fillRect(
        rect.x + rect.width - gasWidth,
        rect.y,
        gasWidth,
        rect.height,
      );
    }
    ctx.globalAlpha = 1;
  }

  if (state.block.length === 0) {
    // Nothing has landed yet. Drawing the slot rather than leaving a hole is
    // the difference between an instrument warming up and one that looks
    // broken — and the first minute after someone opens the link is the only
    // impression most readers will ever form.
    drawReservedColumn(ctx, palette, view);
    return;
  }

  const count = state.block.length;
  for (const mark of state.block) {
    const slot = slotRect(view, mark.slotIndex, count, false);
    const isTop = mark.slotIndex === 0;

    /**
     * The row's final geometry, computed once and used by both states.
     *
     * Width is gas. Rows are anchored to the column's right edge so the
     * silhouette stays straight against the screen edge and the variation
     * reads leftward, like a bar off a spine. Slot 0 also carries a tab
     * protruding left, which marks position and is not gas — and which it
     * carries while it is landing too, because position 0 is position 0 the
     * whole way down.
     */
    const gasWidth = widthForGas(slot.width, mark.gas, state.blockMaxGas);
    const right = slot.x + slot.width;
    const rect = {
      x: isTop ? right - gasWidth - TOP_SLOT_TAB : right - gasWidth,
      y: slot.y,
      width: isTop ? gasWidth + TOP_SLOT_TAB : gasWidth,
      height: slot.height,
    };

    // Its turn has not come. A row that is still in the field is drawn by the
    // flight, at its field position; one that has no journey is not drawn at
    // all, because it has not arrived.
    const waiting = state.elapsedMs < mark.phaseStartMs;

    if (mark.phase === "flying") {
      drawFlight(ctx, state, palette, view, now, feeScale, mark, rect);
      continue;
    }
    if (waiting) continue;

    // Ghosts arrive over --ghost-appear with no trajectory: they were never
    // anywhere else, so a path would be a fiction.
    const appearing =
      mark.origin === "ghost" && !options.reducedMotion
        ? Math.min(1, (state.elapsedMs - mark.phaseStartMs) / state.ghostAppearMs)
        : 1;

    ctx.globalAlpha = appearing;

    const isGhost = mark.origin === "ghost" && options.showGhosts;

    // The ghost IS the row. Marking it beside the stack would say "something
    // about this line" instead of "this transaction never touched the public
    // mempool", and the second is the only claim the product makes.
    //
    // Identical drawing for both classes: one filled rect at the same
    // thickness, the same gap, the same position within the pitch. The only
    // thing that differs is the fill colour.
    //
    // Seen rows used to carry an extra outline that ghost rows did not. It did
    // not change measured thickness — 3.36px against 3.40px, a ratio of 1.01 —
    // but it was a structural asymmetry between two classes that are supposed
    // to differ only in tone, and an asymmetry like that is exactly where a
    // later reader would go looking for a bias. So it is gone from both, and
    // the one-device-pixel snapped gap does the separating on its own.
    // Tone is class, and only class. Position 0 used to also take a lighter
    // fill, which crossed two meanings onto one channel — the same crossing
    // rule 2 forbids for fee and age. It was already inconsistent: the ghost
    // branch wins, so a top slot that was private flow never got the lighter
    // fill at all, and in roughly a quarter of blocks the tab and the cap have
    // always carried position 0 alone.
    //
    // It had also stopped doing much. Raising --settled took the step from
    // 1.66x down to 1.17x. Two geometric markers that are always present beat
    // a third that is sometimes present and shrinking.
    ctx.fillStyle = rgba(isGhost ? palette.ghostSettled : palette.settled, 1);
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

    // The halo fires only while the ghost is arriving. At rest it is a solid
    // row and nothing else — a resting halo bleeds into neighbouring rows and
    // makes *which* transaction is private ambiguous.
    if (isGhost && appearing < 1) {
      drawGhostFlash(ctx, palette, rect, appearing);
    }
    ctx.globalAlpha = 1;
  }

  if (count > 0) {
    const top = state.block.find((mark) => mark.slotIndex === 0);
    const rect = slotRect(view, 0, count, false);
    const gasWidth = top
      ? widthForGas(rect.width, top.gas, state.blockMaxGas)
      : rect.width;
    drawBlockCap(ctx, palette, view, {
      ...rect,
      x: rect.x + rect.width - gasWidth,
      width: gasWidth,
    });
  }
}

/**
 * The block column before any block has arrived.
 *
 * A faint frame with its slot rhythm sketched in, so the shape of what is
 * coming is visible while it is still coming. An empty region says nothing
 * happened; a reserved one says something is expected.
 */
function drawReservedColumn(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  view: View,
): void {
  const slots = 150;
  const frame = slotRect(view, 0, slots, false);
  const bottom = slotRect(view, slots - 1, slots, false);
  const height = bottom.y + bottom.height - frame.y;

  ctx.strokeStyle = rgba(palette.ruleHair, 1);
  ctx.lineWidth = 1 / view.dpr;
  ctx.strokeRect(
    frame.x + 0.5 / view.dpr,
    frame.y + 0.5 / view.dpr,
    frame.width - 1 / view.dpr,
    height - 1 / view.dpr,
  );

  // Every eighth slot, so the rhythm reads without the frame filling in.
  ctx.fillStyle = rgba(palette.ruleHair, 1);
  for (let index = 0; index < slots; index += 8) {
    const rect = slotRect(view, index, slots, false);
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }
}

/**
 * A transaction crossing from the field to the block.
 *
 * It changes material in mid-air, so it is drawn in both passes with
 * complementary alpha along the same eased curve that moves it. The extra draw
 * call buys the one transition the whole project is built around.
 */
function drawFlight(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  palette: Palette,
  view: View,
  now: number,
  feeScale: FeeScale,
  mark: WorldState["block"][number],
  rect: { x: number; y: number; width: number; height: number },
): void {
  const progress = mark.flightProgress;
  const fromX = chamberX(view, mark.fromX);
  const fromY = chamberY(view, mark.fromY);
  const toX = rect.x + rect.width / 2;
  const toY = rect.y + rect.height / 2;
  const x = fromX + (toX - fromX) * progress;
  const y = fromY + (toY - fromY) * progress;

  /**
   * Emissive half, fading out — in the mark's own colour, at the brightness the
   * field would have given it.
   *
   * It used to be a fixed `trace[3]` disc at half alpha, which meant that the
   * instant a block landed every departing transaction changed colour and
   * brightness. Since the stagger, a mark can sit waiting its turn for up to
   * two seconds, so that discontinuity would be a two-second lie about its fee
   * rather than a 420ms one. It is the same mark; it is drawn as itself.
   */
  /**
   * It is the same mark until it lands.
   *
   * The emissive half is drawn at exactly the brightness the field gave it —
   * unscaled — for the first four fifths of the crossing, then hands over.
   *
   * Scaling it down across the journey does not work, and this was measured
   * rather than guessed. A mark's field brightness already sits between the
   * ramp and the perceptible floor, and most of the pool is near the floor;
   * multiplying that by a hand-over weight puts it under. Sampled mid-assembly:
   * of nine marks in transit, eight rendered below the floor, median peak 0.8
   * over ground against a floor of 14.3. The one event the apparatus exists to
   * show was, for 89% of the transactions in it, invisible.
   *
   * So the dimming happens where it is true — the mark keeps being a pending
   * mark while it crosses, because that is what it is — and the hand-off is a
   * hand-off rather than a fade to nothing in the middle of the gap.
   */
  const fade = progress * progress;
  const HANDOVER_FROM = 0.8;
  const exit =
    progress < HANDOVER_FROM ? 1 : (1 - progress) / (1 - HANDOVER_FROM);
  const colour = sampleRamp(palette, feeScale(tipOf(state, mark)));
  ctx.globalCompositeOperation = "lighter";
  /**
   * A mark that was never drawn in the field emerges from the crossing.
   *
   * Zero at the boundary and whole a quarter of the way over, so it is not on
   * screen at all while it waits its turn in the stagger — `flightProgress` is
   * exactly zero until a mark's delay elapses — and it does not appear at the
   * edge either. It comes out of the part of the mempool the chamber does not
   * draw, which is the truth about it.
   */
  const entry = entryDepth(mark);
  const entryFrom = Math.max(0, entry - CROSSING_ENTRY);
  const arrival =
    mark.enteredInFlight && !state.reducedMotion
      ? smoothstep(
        Math.min(
          1,
          Math.max(0, (progress - entryFrom) / (entry - entryFrom)),
        ),
      )
    : 1;
  ctx.globalAlpha = arrival * exit * emissiveAlpha(palette, colour, mark, now);
  ctx.fillStyle = rgba(colour, 1);
  ctx.beginPath();
  ctx.arc(x, y, MARK_RADIUS * 1.8, 0, Math.PI * 2);
  ctx.fill();

  /**
   * Matte half, fading in at its final width.
   *
   * It used to grow from zero: `rect.width * progress`, centred. Width is gas,
   * so a row that grows is showing a gas figure that rises from nothing to the
   * true one over the whole landing — a channel saying something false for as
   * long as the animation lasts. Harmless-looking when a landing was 420ms once
   * every twelve seconds; not once the block assembles over two and a half
   * seconds with rows arriving continuously.
   *
   * It also anchored to the centre while every settled row anchors right, so
   * mid-assembly the column bulged into a lens.
   *
   * And it travelled vertically with the dot, which is the same mistake on the
   * other axis: a row's Y is its position in the block, so a matte row drifting
   * up the column is claiming a place in the block it does not have. What
   * travels is the mark. The row is where it will be, and only its alpha moves.
   */
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = fade;
  ctx.fillStyle = rgba(palette.settled, 1);
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.globalAlpha = 1;
}

/**
 * The arrival flash on a ghost row. Transient only — see the call site.
 *
 * It overshoots and settles back, so private flow announces itself rather than
 * fading in politely. Because it lasts `--ghost-appear` and then stops, it may
 * bleed past the row: a momentary flare is unambiguous in a way a permanent
 * glow is not.
 */
function drawGhostFlash(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  rect: { x: number; y: number; width: number; height: number },
  appearing: number,
): void {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const extent = rect.height * (1 + (1 - appearing) * 6);
  const strength = 1 - appearing;

  ctx.globalCompositeOperation = "lighter";
  const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, extent);
  halo.addColorStop(0, rgba(palette.ghostHalo, palette.ghostHalo.a * strength));
  halo.addColorStop(1, rgba(palette.ghostHalo, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, extent, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = rgba(palette.ghostCore, strength * 0.8);
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.globalCompositeOperation = "source-over";
}

/**
 * A rule capping the top of the block.
 *
 * Position 0 is the most valuable slot in the block and has to be the most
 * marked thing in the stack. A lighter fill was tried first and was never
 * enough on its own — one slightly paler row among a hundred and fifty is not
 * a signal — so the row also got a tab protruding to the left, and this cap.
 *
 * The fill is gone now and these two are the whole marker. That is the right
 * split: they are geometry, so they survive the row being private flow, which
 * the fill never did.
 */
function drawBlockCap(
  ctx: CanvasRenderingContext2D,
  palette: Palette,
  view: View,
  first: { x: number; y: number; width: number; height: number },
): void {
  const x = first.x - TOP_SLOT_TAB;
  const width = first.width + TOP_SLOT_TAB;
  const thickness = Math.max(1, Math.round(2 * view.dpr) / view.dpr);
  // --settled-hi, not the cold ramp. The ramp carries fee priority for pending
  // traces; borrowing it to decorate the settled block muddles the one
  // distinction the two halves exist to draw.
  ctx.fillStyle = rgba(palette.settledHi, 1);
  ctx.fillRect(x, first.y - thickness - 1 / view.dpr, width, thickness);
}

/**
 * The pending field. Additive.
 *
 * The cold ramp is deliberately dim at the bottom because `lighter` accumulates:
 * start bright and a busy field clips to white and loses all fee information.
 * Density is what should produce brightness, not the individual mark.
 */
/** How much of the crossing a mark takes to fade up, at most. */
const CROSSING_ENTRY = 0.25;

/**
 * Where, across the crossing, a mark that was never in the field becomes
 * fully visible. 0 is the chamber's edge, 1 is its row.
 *
 * It used to be one value for every such mark, a quarter of the way over —
 * and on mainnet that put hundreds of tracks through one point. Most public
 * transactions the field never drew pay a tip at the axis floor, so they
 * share a height; sharing an entry as well made every one of their tracks
 * start at the same pixel, and the crossing read as a beam from a source.
 * Nothing came from that point. The mark was somewhere in the unobserved
 * pool, and the only honest thing to say about where is "not here".
 *
 * So the depth is per mark, from the seed the drift already uses, spread
 * over the near half of the crossing. x carries no datum anywhere in this
 * apparatus — see the note on `Entity.x` — and this is x. Fee and slot,
 * which are data, are untouched: the track still ends at the true row from
 * the true height.
 */
export function entryDepth(mark: { driftSeedA: number }): number {
  return 0.15 + 0.4 * (mark.driftSeedA / (Math.PI * 2));
}

/**
 * How long a track stays after its mark lands. Just under a block, so the
 * last of a block's tracks are dissipating as the next block's are laid.
 */
export const TRACK_LIFE_MS = 11_000;

/**
 * A fresh track's luminance over the ground, and a spent one's, as multiples
 * of the perceptible floor. Above the floor at both ends: a track that falls
 * under it is culled by the eye before it is culled by the clock, and the
 * crossing would empty twice — once visibly, once not.
 */
const TRACK_PEAK = 1.6;
const TRACK_END = 0.55;

/**
 * Public rows a block may have before its tracks start sharing their ink.
 *
 * Measured on a real block of 369 rows, 89 of them public, at the moment its
 * tracks were laid: the tracks were 48.8% of the chamber's ink — as much as
 * every mark in the field together. A block of 446 rows is in the same
 * recording. Left alone, the record of where a block came from outgrows the
 * thing it is a record of, and the chamber reads as a hatch.
 *
 * So above this count each track dims by the square root of the excess: ink
 * grows with the root of the block instead of with the block. Root rather
 * than a fixed total, because a fixed total at 400 rows puts every track
 * under the floor, and a track that cannot be read is a record that was
 * dropped with extra steps. The scale never falls below a half for the same
 * reason.
 *
 * Forty, not sixty: at sixty the same 89-row block re-measured at 46.3% —
 * the root barely bit. Forty puts that block at two thirds and anything past
 * 160 public rows at the half, which is where the hatch was.
 */
export const TRACK_BUDGET_ROWS = 40;

/** How much each of `publicRows` tracks is dimmed to share the budget. */
export function trackBudgetScale(publicRows: number): number {
  if (publicRows <= TRACK_BUDGET_ROWS) return 1;
  return Math.max(0.5, Math.sqrt(TRACK_BUDGET_ROWS / publicRows));
}

/**
 * The tracks: where every public transaction in this block came from.
 *
 * A cloud chamber does not show the particle. It shows the trail the particle
 * left, and the trail persists after the particle is gone. Until now this
 * chamber showed the particle — a mark crossing for 420ms — and then a block
 * of rows with nothing to say which of them had crossed. For the other eleven
 * and a half seconds the one event the apparatus exists to show was over.
 *
 * So a mark that flew leaves a line from where it was to the row it became,
 * and the line stays, dissipating, until the next block lands. Private flow
 * leaves nothing: a row with no line reaching it is a transaction that was
 * never anywhere, which is the claim, drawn. Every value on the line is a
 * value the mark already had — its field position, its slot, its fee colour
 * — and the only thing added is time since landing, on alpha, which is what
 * alpha already means here.
 *
 * A mark that entered already crossing (see `Entity.enteredInFlight`) was
 * not visible at the chamber's edge: its flight fades up to its own entry
 * depth (`entryDepth`), from nothing. Its track is the same — a faint
 * lead-in over the fade, then the line — because a track is the record of
 * where the particle was seen, and it was not seen at the edge.
 *
 * Drawn additively with the field, one CSS pixel wide, and kept near the
 * floor: this is the reticle's register, not the mark's. Measured before it
 * was shipped — see the note on TRACK_PEAK — so the tracks read as a record
 * over the grid and not as a second grid.
 */
function drawTracks(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  palette: Palette,
  view: View,
  feeScale: FeeScale,
  highlight: DrawOptions["highlight"],
  tracks: NonNullable<DrawOptions["tracks"]>,
): void {
  const count = state.block.length;
  if (count === 0) return;
  const floor = perceptibleFloor(palette);
  const lit = highlight?.where === "block" ? highlight.hash : null;
  let publicRows = 0;
  for (const mark of state.block) if (mark.origin === "seen") publicRows += 1;
  const budget = trackBudgetScale(publicRows);

  ctx.globalCompositeOperation = "lighter";
  ctx.lineWidth = 1;
  for (const mark of state.block) {
    if (mark.phase !== "settled" || mark.origin !== "seen") continue;
    if (tracks === "lit" && mark.hash !== lit) continue;
    // Settled is landed. Under reduced motion a mark settles the instant it
    // is placed, and its track appears with it rather than 420ms later for
    // a flight that never happened — hence the clamp, not a guard.
    const age = Math.max(
      0,
      state.elapsedMs - (mark.phaseStartMs + state.landBlockMs),
    );
    const through = Math.min(1, age / TRACK_LIFE_MS);
    const decay =
      (Math.exp(-DECAY_SHAPE * through) - DECAY_END) / (1 - DECAY_END);
    // The pointed-at track is exempt from the budget: it is an answer, and an
    // answer at a quarter strength is not one.
    const share = mark.hash === lit ? 1 : budget;
    const target = floor * (TRACK_END + (TRACK_PEAK - TRACK_END) * decay) * share;
    const colour = sampleRamp(palette, feeScale(tipOf(state, mark)));
    // The pointed-at row's track, brought up to the mark's own register so
    // it reads as a line and not as a hair; every other track stays where
    // the reticle is.
    const emphasis = mark.hash === lit ? 3 : 1;
    ctx.globalAlpha = Math.min(
      SINGLE_MARK_CEILING,
      (target * emphasis) / Math.max(1, luminance(colour)),
    );
    ctx.lineWidth = mark.hash === lit ? 1.5 : 1;
    const slot = slotRect(view, mark.slotIndex, count, false);
    const rowLeft =
      slot.x + slot.width - widthForGas(slot.width, mark.gas, state.blockMaxGas);
    const x0 = chamberX(view, mark.fromX);
    const y0 = chamberY(view, mark.fromY);
    const x1 = rowLeft;
    const y1 = slot.y + slot.height / 2;
    ctx.strokeStyle = rgba(colour, 1);

    if (mark.enteredInFlight) {
      // The lead-in: the part of the crossing over which the flight was
      // fading up. Half alpha from its midpoint, nothing before it.
      const alpha = ctx.globalAlpha;
      const b = entryDepth(mark);
      const a = (Math.max(0, b - CROSSING_ENTRY) + b) / 2;
      ctx.globalAlpha = alpha * 0.5;
      ctx.beginPath();
      ctx.moveTo(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a);
      ctx.lineTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
      ctx.stroke();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.moveTo(x0 + (x1 - x0) * b, y0 + (y1 - y0) * b);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

/**
 * The ring around what the reader is pointing at.
 *
 * A mark is 1.9px and a row can be two device pixels tall; neither can show
 * that it has been noticed. The ring is the instrument's answer — the same
 * ring for a mark, a public row and a private row, in the cold text tone for
 * the first two and in --ghost-core for the third, because that row is
 * private flow and rule 1 lets it say so. For a public row the origin of its
 * track is ringed as well, so "this row came from there" is one glance.
 */
function drawHighlight(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  palette: Palette,
  view: View,
  highlight: DrawOptions["highlight"],
): void {
  if (!highlight) return;
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  if (highlight.where === "mempool") {
    const entity = state.entities.find((e) => e.hash === highlight.hash);
    if (!entity) return;
    ctx.strokeStyle = rgba(palette.text, 0.9);
    ctx.beginPath();
    ctx.arc(
      chamberX(view, entity.x),
      chamberY(view, entity.y),
      HIGHLIGHT_RING,
      0,
      Math.PI * 2,
    );
    ctx.stroke();
    return;
  }

  const compressed = highlight.where === "previous";
  const marks = compressed ? state.previousBlock : state.block;
  const mark = marks.find((m) => m.hash === highlight.hash);
  if (!mark) return;
  const slot = slotRect(view, mark.slotIndex, marks.length, compressed);
  const maxGas = compressed ? state.previousBlockMaxGas : state.blockMaxGas;
  const gasWidth = widthForGas(slot.width, mark.gas, maxGas);
  const isGhost = mark.origin === "ghost";
  ctx.strokeStyle = rgba(isGhost ? palette.ghostCore : palette.text, 0.9);
  // One device pixel outside the row on every side, snapped, so the ring is
  // a ring and not a thicker row.
  const pad = 1 / view.dpr + 1;
  ctx.strokeRect(
    slot.x + slot.width - gasWidth - pad,
    slot.y - pad,
    gasWidth + pad * 2,
    slot.height + pad * 2,
  );

  if (!compressed && mark.origin === "seen" && mark.phase === "settled") {
    ctx.strokeStyle = rgba(palette.text, 0.7);
    ctx.beginPath();
    const x0 = chamberX(view, mark.fromX);
    const y0 = chamberY(view, mark.fromY);
    if (mark.enteredInFlight) {
      // It was never at the edge. Its origin is where its track begins.
      const x1 = slot.x + slot.width - gasWidth;
      const y1 = slot.y + slot.height / 2;
      const e = entryDepth(mark);
      ctx.arc(x0 + (x1 - x0) * e, y0 + (y1 - y0) * e, HIGHLIGHT_RING * 0.6, 0, Math.PI * 2);
    } else {
      ctx.arc(x0, y0, HIGHLIGHT_RING, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
}

function drawEmissivePass(
  ctx: CanvasRenderingContext2D,
  state: WorldState,
  palette: Palette,
  view: View,
  now: number,
  feeScale: FeeScale,
  markScale: number,
): void {
  ctx.globalCompositeOperation = "lighter";

  for (const entity of state.entities) {
    if (entity.phase !== "pending") continue;
    const position = feeScale(tipOf(state, entity));
    const colour = sampleRamp(palette, position);
    // A fade is motion to someone who asked for none: the entry ramp is
    // skipped and the mark is simply there, at the brightness its age earns.
    ctx.globalAlpha =
      emissiveAlpha(palette, colour, entity, now) *
      (state.reducedMotion ? 1 : entryRamp(entity, state.elapsedMs));
    ctx.fillStyle = rgba(colour, 1);
    ctx.beginPath();
    ctx.arc(
      chamberX(view, entity.x),
      chamberY(view, entity.y),
      radiusFor(position, markScale),
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  ctx.globalAlpha = 1;
}

/**
 * How bright a pending mark is right now.
 *
 * One copy, because the field pass and the flight both need it: a transaction
 * waiting its turn to fly is still the same mark it was a frame ago, and
 * computing its brightness twice is how the two drift apart and produce a pop
 * at the moment the block lands.
 */
/**
 * How long the live block takes to become the strip.
 *
 * The strip is the block a reader has just spent twelve seconds watching, and
 * it used to arrive there by teleport: the wide column vanished and a narrow
 * one appeared 300px to its left, with nothing to say the two were the same
 * thing. A reader cannot compare this block against the last one if they never
 * saw the last one move.
 *
 * Shorter than the 2000ms the incoming block takes to assemble, so the old one
 * is clear of the column before the new one has filled it, and long enough to
 * be followed rather than merely noticed.
 */
const BLOCK_HANDOVER_MS = 520;

/** How long a mark takes to reach the brightness its age entitles it to. */
export const ENTRY_MS = 320;

/**
 * A mark entering the field is a rendering event, not a mempool event.
 *
 * The pool draws a sample of what is pending. A transaction admitted to it did
 * not arrive at that instant — it may have been waiting for minutes, and the
 * moment it becomes visible is the moment the *renderer* had room for it. Under
 * the old behaviour every admission popped into existence at the brightness its
 * age entitled it to, which announced a rendering decision in the same visual
 * language the field uses for arrivals.
 *
 * That reads worst exactly where it is least true. Admission is fee-ordered:
 * the top quota is filled before the sample, so the first marks admitted after
 * a block are the highest fees, and the highest fees sit at the top of the
 * chamber. A block empties that band and the refill repopulated it with a run
 * of full-brightness marks — reported from the running app as transactions
 * spawning at the top whenever a block lands. Metering the rate spread the run
 * over 208ms but did not change what each mark did on arrival.
 *
 * So entry is a ramp. Alpha stays a function of age and nothing else, which is
 * rule 2 intact; the ramp is keyed on time in the field, not on age, because a
 * transaction that has been pending for three minutes is dim when it is
 * admitted and must still enter rather than appear.
 */
/** Zero slope at both ends, so a ramp has no visible start and no seam. */
function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

function entryRamp(
  entity: { phaseStartMs: number },
  elapsedMs: number,
): number {
  return smoothstep(
    Math.min(1, Math.max(0, (elapsedMs - entity.phaseStartMs) / ENTRY_MS)),
  );
}

function emissiveAlpha(
  palette: Palette,
  colour: Rgb,
  entity: { firstSeen: number; cullAtMs: number },
  now: number,
): number {
  /**
     * Age decays the mark from its full brightness down to the floor — not
     * down to nothing.
     *
     * The old form multiplied the ramp luminance by `e^(-age/tau)`, which made
     * the age at which a mark drops below perceptibility a function of its own
     * base luminance: `tau * ln(L * ceiling / floor)`. Measured across the
     * ramp, that was 3.4s at the cheap end against 15.1s at the expensive one,
     * so a cheap transaction vanished from the picture in three seconds while
     * still sitting in the pool for another twenty. The field was not showing
     * the mempool, it was showing the last four seconds of arrivals.
     *
     * Here the decay runs between two fixed luminances instead, so every mark
     * reaches the floor exactly when it is culled, whatever its fee. The cull
     * also stops being a pop: today a trace is long invisible before it is
     * removed, which hides the removal by accident rather than by design.
     */
  const fullOverGround = luminance(colour) * SINGLE_MARK_CEILING;
  const floorOverGround = perceptibleFloor(palette);
  const through = Math.min(
    1,
    Math.max(0, now - entity.firstSeen) / entity.cullAtMs,
  );
  // Exponential in shape, so a trace still reads as dissipating rather than
  // as a linear countdown, but scaled to land on zero at the cull.
  const decay =
    (Math.exp(-DECAY_SHAPE * through) - DECAY_END) / (1 - DECAY_END);
  const target =
    floorOverGround + (fullOverGround - floorOverGround) * decay;

  // Additive blending puts `luminance(colour) * globalAlpha` over the ground,
  // so this is the alpha that lands the mark on the luminance we want.
  return Math.min(
    SINGLE_MARK_CEILING,
    target / Math.max(1, luminance(colour)),
  );
}
