import { describe, expect, it } from "vitest";
import {
  INITIAL_INTERACTION,
  interact,
  type InteractionEnv,
  type InteractionEvent,
  type InteractionState,
} from "@/lib/interact";
import type { Inspected } from "@/lib/canvas/pick";
import { hashOf } from "./helpers";

/**
 * Pointing, pinning and walking, without a browser.
 *
 * Until this reducer existed the only way to check that a click held a row,
 * that Escape let go, or that ↓ from nothing pinned the first row, was to
 * drive a headless page and read the panel back. That is a fine way to look
 * and a poor way to guard: nothing failed when the logic drifted. Now the
 * rules are inputs and outputs.
 */

function row(where: "block" | "previous", slotIndex: number): Inspected {
  return {
    where,
    hash: hashOf(1000 + slotIndex + (where === "previous" ? 500 : 0)),
    tipGwei: 1,
    offeredGwei: 10,
    feeKind: "eip1559",
    gas: 21_000,
    gasIsUsed: true,
    ageSeconds: 3,
    percentile: null,
    slotIndex,
    origin: "seen",
    screen: { x: 100, y: 100 + slotIndex },
  };
}

const mark: Inspected = {
  ...row("block", 0),
  where: "mempool",
  slotIndex: null,
  percentile: 0.4,
  gasIsUsed: false,
  origin: null,
};

const env = (overrides: Partial<InteractionEnv> = {}): InteractionEnv => ({
  slot: (where, index) => (index >= 0 && index < 5 ? row(where, index) : null),
  rows: () => 5,
  hasTransport: false,
  ...overrides,
});

const run = (
  state: InteractionState,
  events: InteractionEvent[],
  e: InteractionEnv = env(),
) => {
  const effects = [];
  for (const event of events) {
    const out = interact(state, event, e);
    state = out.state;
    effects.push(...out.effects);
  }
  return { state, effects };
};

const shows = (effects: ReturnType<typeof run>["effects"]) =>
  effects.flatMap((f) => (f.type === "show" ? [f] : []));

describe("pointing", () => {
  it("shows a target once, not on every pointer event", () => {
    const { effects } = run(INITIAL_INTERACTION, [
      { type: "move", target: mark, inChamber: true },
      { type: "move", target: mark, inChamber: true },
      { type: "move", target: mark, inChamber: true },
    ]);
    // Sixty pointer events a second over the same mark must not re-render
    // the chrome sixty times a second.
    expect(shows(effects)).toHaveLength(1);
  });

  it("offers the crosshair over the chamber even with nothing under the pointer", () => {
    const { effects } = run(INITIAL_INTERACTION, [
      { type: "move", target: null, inChamber: true },
    ]);
    expect(effects).toContainEqual({ type: "cursor", value: "crosshair" });
  });

  it("clears on leave", () => {
    const { state, effects } = run(INITIAL_INTERACTION, [
      { type: "move", target: mark, inChamber: true },
      { type: "leave" },
    ]);
    expect(state.hovered).toBeNull();
    expect(shows(effects).at(-1)).toEqual({ type: "show", target: null, pinned: false });
  });
});

describe("pinning", () => {
  it("holds a row through pointer movement", () => {
    const first = row("block", 2);
    const { state, effects } = run(INITIAL_INTERACTION, [
      { type: "click", target: first },
      { type: "move", target: mark, inChamber: true },
      { type: "move", target: null, inChamber: false },
      { type: "leave" },
    ]);
    expect(state.pinned).toEqual(first);
    // Nothing after the pin may have re-shown something else.
    expect(shows(effects)).toEqual([{ type: "show", target: first, pinned: true }]);
  });

  it("releases on a second click of the same thing, and on empty space", () => {
    const first = row("block", 2);
    const again = run(INITIAL_INTERACTION, [
      { type: "click", target: first },
      { type: "click", target: first },
    ]);
    expect(again.state.pinned).toBeNull();
    const empty = run(INITIAL_INTERACTION, [
      { type: "click", target: first },
      { type: "click", target: null },
    ]);
    expect(empty.state.pinned).toBeNull();
  });

  it("swaps the pin when another row is clicked", () => {
    const { state } = run(INITIAL_INTERACTION, [
      { type: "click", target: row("block", 1) },
      { type: "click", target: row("block", 3) },
    ]);
    expect(state.pinned?.slotIndex).toBe(3);
  });

  it("lets go on Escape and does nothing on Escape with nothing held", () => {
    const held = run(INITIAL_INTERACTION, [
      { type: "click", target: row("block", 1) },
      { type: "key", key: "Escape", canvasFocused: true },
    ]);
    expect(held.state.pinned).toBeNull();
    expect(shows(held.effects).at(-1)).toEqual({ type: "show", target: null, pinned: false });
    const idle = interact(INITIAL_INTERACTION, { type: "key", key: "Escape", canvasFocused: true }, env());
    expect(idle.effects).toEqual([]);
  });
});

describe("walking the block by keyboard", () => {
  it("pins the first row from nothing when the canvas has focus", () => {
    const { state, effects } = run(INITIAL_INTERACTION, [
      { type: "key", key: "ArrowDown", canvasFocused: true },
    ]);
    expect(state.pinned?.slotIndex).toBe(0);
    expect(effects).toContainEqual({ type: "prevent-default" });
  });

  it("pins the last row from nothing on End or ArrowUp", () => {
    for (const key of ["End", "ArrowUp"]) {
      const { state } = run(INITIAL_INTERACTION, [{ type: "key", key, canvasFocused: true }]);
      expect(state.pinned?.slotIndex).toBe(4);
    }
  });

  it("does nothing from nothing unless the canvas has focus", () => {
    // A reader typing in the page's own text must not pin rows by accident.
    const { state, effects } = run(INITIAL_INTERACTION, [
      { type: "key", key: "ArrowDown", canvasFocused: false },
    ]);
    expect(state.pinned).toBeNull();
    expect(effects).toEqual([]);
  });

  it("steps through the column and stops at its ends", () => {
    const { state, effects } = run(INITIAL_INTERACTION, [
      { type: "click", target: row("block", 3) },
      { type: "key", key: "ArrowDown", canvasFocused: false },
      { type: "key", key: "ArrowDown", canvasFocused: false },
    ]);
    // 3 → 4 → (no row 5) stays at 4. The end is an end.
    expect(state.pinned?.slotIndex).toBe(4);
    expect(shows(effects).map((s) => s.target?.slotIndex)).toEqual([3, 4]);
  });

  it("walks the previous block's column when that is what is pinned", () => {
    const { state } = run(INITIAL_INTERACTION, [
      { type: "click", target: row("previous", 1) },
      { type: "key", key: "Home", canvasFocused: false },
    ]);
    expect(state.pinned?.where).toBe("previous");
    expect(state.pinned?.slotIndex).toBe(0);
  });

  it("does not walk from a mempool mark, which has no column", () => {
    const { state, effects } = run(INITIAL_INTERACTION, [
      { type: "click", target: mark },
      { type: "key", key: "ArrowDown", canvasFocused: true },
    ]);
    expect(state.pinned).toEqual(mark);
    expect(shows(effects)).toHaveLength(1);
  });
});

describe("the transport keys", () => {
  it("exist only where a transport does", () => {
    const live = interact(INITIAL_INTERACTION, { type: "key", key: " ", canvasFocused: true }, env());
    expect(live.effects).toEqual([]);
    const driven = interact(
      INITIAL_INTERACTION,
      { type: "key", key: " ", canvasFocused: true },
      env({ hasTransport: true }),
    );
    expect(driven.effects).toContainEqual({ type: "transport", action: "toggle-pause" });
    expect(driven.effects).toContainEqual({ type: "prevent-default" });
  });

  it("maps n and r to the transport's other two actions", () => {
    const e = env({ hasTransport: true });
    expect(interact(INITIAL_INTERACTION, { type: "key", key: "n", canvasFocused: false }, e).effects)
      .toContainEqual({ type: "transport", action: "next-block" });
    expect(interact(INITIAL_INTERACTION, { type: "key", key: "R", canvasFocused: false }, e).effects)
      .toContainEqual({ type: "transport", action: "land-again" });
  });
});
