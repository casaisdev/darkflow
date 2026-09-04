import type { Hex } from "@/types/stream";
import { offeredFee } from "@/lib/fees";
import {
  BLOCK_RIGHT,
  BLOCK_WIDTH,
  STRIP_RIGHT,
  STRIP_WIDTH,
  chamberX,
  chamberY,
  slotRect,
  type View,
} from "@/lib/canvas/draw";
import { tipOf, type Entity, type Origin, type WorldState } from "@/lib/canvas/world";

/**
 * What is under the pointer.
 *
 * Hit-testing lives here, apart from both the renderer and React, because it is
 * the one thing on this screen that has to agree with the drawing exactly: a
 * reader points at a mark and is told what that mark is. If the test and the
 * draw disagree by a few pixels the panel describes a different transaction
 * than the one under the cursor, and nothing on screen would reveal it. Both
 * use `chamberX`, `chamberY` and `slotRect`; neither has its own copy.
 *
 * Pure, so it can be checked against the recorded draw calls in a test rather
 * than by pointing at a running browser.
 */

/** A transaction the reader has pointed at. Plain data — crosses into React. */
export type Inspected = {
  where: "mempool" | "block" | "previous";
  hash: Hex;
  /**
   * Effective priority fee in gwei, or `null` when it was never announced.
   *
   * Private flow has no pending record. Its fee is not zero and it is not
   * small — it is unknown, because the only place a fee is announced is the
   * mempool and this transaction never appeared there. A zero here would be the
   * same lie as a zero ghost ratio.
   */
  tipGwei: number | null;
  /** What it offered before the base fee, or `null` for the same reason. */
  offeredGwei: number | null;
  feeKind: "eip1559" | "legacy" | null;
  /** Gas: the announced limit while pending, what it consumed once included. */
  gas: number;
  gasIsUsed: boolean;
  /** Seconds since the ingest first saw this hash, or `null` if it never did. */
  ageSeconds: number | null;
  /** Where it sits on the fee ramp, 0..1, or `null` outside the mempool. */
  percentile: number | null;
  /** Position in the block, or `null` in the mempool. */
  slotIndex: number | null;
  /**
   * Classification, or `null` while calibrating.
   *
   * Rule 1: during warm-up the verdict is not computed, so there is none to
   * report. `"unknown"` marks carry that through.
   */
  origin: Origin | null;
  /** Where to anchor the panel, in CSS pixels. */
  screen: { x: number; y: number };
};

/**
 * How close the pointer must be to a mark, in CSS pixels.
 *
 * Twelve, from ten: a mark is 1.9px and the pointer is a person. Measured on
 * the running app, ten missed roughly one approach in four by a pixel or two
 * and read as "nothing here"; twelve catches them and still resolves marks
 * that sit a mark's width apart, because the nearest wins.
 */
const MARK_PICK_RADIUS = 12;

export type PickOptions = {
  /** False while calibrating: no classification exists to report. Rule 1. */
  showGhosts: boolean;
  /** Maps a tip to its place on the ramp, for the percentile readout. */
  feeScale: (tip: number) => number;
  /** ms since epoch. Passed in, never read, so a pick is reproducible. */
  now: number;
};

export function pick(
  state: WorldState,
  view: View,
  pointer: { x: number; y: number },
  options: PickOptions,
): Inspected | null {
  return (
    pickBlockRow(state, view, pointer, options) ??
    pickMark(state, view, pointer, options)
  );
}

/**
 * A row by its position, for stepping through a column from the keyboard.
 * `null` when there is no such row; the caller clamps or stops.
 */
export function pickSlot(
  state: WorldState,
  view: View,
  where: "block" | "previous",
  slotIndex: number,
  options: PickOptions,
): Inspected | null {
  const marks = where === "block" ? state.block : state.previousBlock;
  const mark = marks.find((m) => m.slotIndex === slotIndex);
  if (!mark) return null;
  const compressed = where === "previous";
  const rect = slotRect(view, slotIndex, marks.length, compressed);
  const right = view.width * (compressed ? STRIP_RIGHT : BLOCK_RIGHT);
  const left = right - view.width * (compressed ? STRIP_WIDTH : BLOCK_WIDTH);
  return describe(state, mark, where, options, {
    x: left,
    y: rect.y + rect.height / 2,
  });
}

/** The block and the strip.
 *
 * Tested first: the columns are dense and unambiguous, a row is a rectangle,
 * and a reader pointing inside one means that row. The chamber is sparse and
 * needs a radius, so it answers second.
 */
function pickBlockRow(
  state: WorldState,
  view: View,
  pointer: { x: number; y: number },
  options: PickOptions,
): Inspected | null {
  const columns = [
    {
      where: "block" as const,
      marks: state.block,
      right: BLOCK_RIGHT,
      width: BLOCK_WIDTH,
      compressed: false,
    },
    {
      where: "previous" as const,
      marks: state.previousBlock,
      right: STRIP_RIGHT,
      width: STRIP_WIDTH,
      compressed: true,
    },
  ];

  for (const column of columns) {
    if (column.marks.length === 0) continue;
    const right = view.width * column.right;
    const left = right - view.width * column.width;
    // Generous by a few pixels on the left, because a narrow row ends well
    // short of the column and the reader is pointing at the row's *slot*.
    if (pointer.x < left - 2 || pointer.x > right + 2) continue;

    for (const mark of column.marks) {
      const rect = slotRect(
        view,
        mark.slotIndex,
        column.marks.length,
        column.compressed,
      );
      // A slot can be under two device pixels tall, which nobody can point
      // at. The pick region is the slot pitch with a floor, not the drawn row.
      const reach = Math.max(rect.height, 4);
      if (pointer.y < rect.y - 1 || pointer.y > rect.y + reach) continue;
      return describe(state, mark, column.where, options, {
        x: left,
        y: rect.y + rect.height / 2,
      });
    }
  }
  return null;
}

/** The chamber. Nearest mark within a radius, not the first one found. */
function pickMark(
  state: WorldState,
  view: View,
  pointer: { x: number; y: number },
  options: PickOptions,
): Inspected | null {
  let best: Entity | null = null;
  let bestDistance = MARK_PICK_RADIUS * MARK_PICK_RADIUS;
  let bestScreen = { x: 0, y: 0 };

  for (const entity of state.entities) {
    if (entity.phase !== "pending") continue;
    const x = chamberX(view, entity.x);
    const y = chamberY(view, entity.y);
    const dx = x - pointer.x;
    const dy = y - pointer.y;
    const distance = dx * dx + dy * dy;
    if (distance > bestDistance) continue;
    bestDistance = distance;
    best = entity;
    bestScreen = { x, y };
  }

  if (!best) return null;
  return describe(state, best, "mempool", options, bestScreen);
}

function describe(
  state: WorldState,
  mark: Entity,
  where: Inspected["where"],
  options: PickOptions,
  screen: { x: number; y: number },
): Inspected {
  const inMempool = where === "mempool";
  /**
   * Whether this transaction was ever announced.
   *
   * A block mark that came from the field carries the record the mempool had.
   * One that did not was minted with a placeholder fee of zero, and reporting
   * that as a fee would be inventing a number for the one class of transaction
   * whose fee we cannot know.
   */
  const announced = inMempool || mark.origin === "seen";
  const tip = announced ? tipOf(state, mark) : null;

  return {
    where,
    hash: mark.hash,
    tipGwei: tip === null ? null : tip / 1e9,
    offeredGwei: announced ? offeredFee(mark.fees) / 1e9 : null,
    feeKind: announced ? mark.fees.kind : null,
    gas: mark.gas,
    gasIsUsed: !inMempool,
    /**
     * Only announced transactions have one.
     *
     * A block mark that never passed through the mempool is spawned carrying
     * the block's own timestamp, so that the world has a finite number to age
     * it by. Printing that as "first seen" would put a moment on a sighting
     * that never happened — the same invention as a zero fee, and worse for
     * being plausible: it reads as a transaction that waited a few seconds.
     */
    ageSeconds:
      announced && Number.isFinite(mark.firstSeen)
        ? Math.max(0, options.now - mark.firstSeen) / 1000
        : null,
    percentile: inMempool ? options.feeScale(tipOf(state, mark)) : null,
    slotIndex: inMempool ? null : mark.slotIndex,
    origin: inMempool ? null : options.showGhosts ? mark.origin : null,
    screen,
  };
}

