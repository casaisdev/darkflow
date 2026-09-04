import type { Inspected } from "@/lib/canvas/pick";

/**
 * Pointing and pinning, as a pure function.
 *
 * This logic lived in closures inside `Viz`, next to the listeners that fed
 * it, which made it the one piece of the instrument that could only be
 * verified by driving a browser: a reducer that decides what pointing at a
 * row does, what a click holds, and what the keys walk through, with no way
 * to run it under a test and no mutants to kill. Everything else on this page
 * is pure in its inputs; this is now too.
 *
 * `Viz` owns the listeners and the world. It translates each DOM event into
 * one of the events below, hands over what the event needs resolved against
 * the world (the transaction under the pointer, a row by slot), and carries
 * out the effects that come back. Nothing here reads the DOM or the world.
 */

export type InteractionState = {
  /** The key of what the pointer is over, for change detection. */
  hovered: string | null;
  /** What a click held. Survives pointer movement until released. */
  pinned: Inspected | null;
};

export const INITIAL_INTERACTION: InteractionState = {
  hovered: null,
  pinned: null,
};

export type InteractionEvent =
  | { type: "move"; target: Inspected | null; inChamber: boolean }
  | { type: "leave" }
  | { type: "click"; target: Inspected | null }
  | { type: "key"; key: string; canvasFocused: boolean };

/** What the reducer needs from the world, resolved by the caller. */
export type InteractionEnv = {
  /** A row by column and slot, or `null` off either end. */
  slot: (where: "block" | "previous", index: number) => Inspected | null;
  rows: (where: "block" | "previous") => number;
  /** Whether the source can be driven — pause, step, land again. */
  hasTransport: boolean;
};

export type InteractionEffect =
  | { type: "show"; target: Inspected | null; pinned: boolean }
  | { type: "cursor"; value: "crosshair" | "default" }
  | { type: "transport"; action: "toggle-pause" | "next-block" | "land-again" }
  /** The event was consumed and the browser's default must not run. */
  | { type: "prevent-default" };

export type InteractionResult = {
  state: InteractionState;
  effects: InteractionEffect[];
};

const keyOf = (target: Inspected | null): string | null =>
  target ? `${target.where}:${target.hash}` : null;

export function interact(
  state: InteractionState,
  event: InteractionEvent,
  env: InteractionEnv,
): InteractionResult {
  switch (event.type) {
    case "move": {
      /**
       * The cursor is the only affordance the canvas can offer, so it changes
       * the moment something answers. Over the chamber it is a crosshair
       * regardless, because the chamber itself answers — the fee readout
       * follows it. A pinned target holds: moving the pointer must not tear
       * the reader away from the row they chose to keep.
       */
      const cursor: InteractionEffect = {
        type: "cursor",
        value: event.target || event.inChamber ? "crosshair" : "default",
      };
      if (state.pinned) {
        return {
          state,
          effects: [{ type: "cursor", value: event.inChamber ? "crosshair" : "default" }],
        };
      }
      const key = keyOf(event.target);
      if (key === state.hovered) return { state, effects: [cursor] };
      return {
        state: { ...state, hovered: key },
        effects: [cursor, { type: "show", target: event.target, pinned: false }],
      };
    }

    case "leave": {
      const cursor: InteractionEffect = { type: "cursor", value: "default" };
      if (state.pinned) return { state, effects: [cursor] };
      return {
        state: { ...state, hovered: null },
        effects: [cursor, { type: "show", target: null, pinned: false }],
      };
    }

    case "click": {
      /**
       * Click pins; clicking the pinned thing again, or empty space, releases.
       * A toggle, because the reader who clicked once to hold a row expects
       * the same gesture to let it go.
       */
      const key = keyOf(event.target);
      if (state.pinned && key === keyOf(state.pinned)) {
        return {
          state: { hovered: key, pinned: null },
          effects: [{ type: "show", target: event.target, pinned: false }],
        };
      }
      return {
        state: { hovered: key, pinned: event.target },
        effects: [{ type: "show", target: event.target, pinned: event.target !== null }],
      };
    }

    case "key":
      return onKey(state, event, env);
  }
}

function onKey(
  state: InteractionState,
  event: Extract<InteractionEvent, { type: "key" }>,
  env: InteractionEnv,
): InteractionResult {
  const { key } = event;

  if (key === "Escape") {
    if (!state.pinned) return { state, effects: [] };
    return {
      state: { hovered: null, pinned: null },
      effects: [{ type: "show", target: null, pinned: false }],
    };
  }

  // The transport's keys mirror its buttons and exist only where it does: a
  // live feed cannot be paused, stepped or landed again, and the keys must
  // not pretend otherwise.
  if (key === " " && env.hasTransport) {
    return {
      state,
      effects: [{ type: "prevent-default" }, { type: "transport", action: "toggle-pause" }],
    };
  }
  if ((key === "n" || key === "N") && env.hasTransport) {
    return { state, effects: [{ type: "transport", action: "next-block" }] };
  }
  if ((key === "r" || key === "R") && env.hasTransport) {
    return { state, effects: [{ type: "transport", action: "land-again" }] };
  }

  const vertical =
    key === "ArrowUp" || key === "ArrowDown" || key === "Home" || key === "End";

  /**
   * Rows by keyboard.
   *
   * With nothing pinned and the canvas focused, ↓ or Enter pins the first
   * row of the block (↑ or End the last), so the block can be read without a
   * pointer at all. With a row pinned, ↑↓ step through its column and
   * Home/End go to its ends; off either end nothing happens, which is what
   * an end is.
   */
  if (!state.pinned) {
    if (!(vertical || key === "Enter") || !event.canvasFocused) {
      return { state, effects: [] };
    }
    const count = env.rows("block");
    if (count === 0) return { state, effects: [] };
    const first = env.slot(
      "block",
      key === "End" || key === "ArrowUp" ? count - 1 : 0,
    );
    if (!first) return { state, effects: [{ type: "prevent-default" }] };
    return {
      state: { hovered: keyOf(first), pinned: first },
      effects: [{ type: "prevent-default" }, { type: "show", target: first, pinned: true }],
    };
  }

  if (!vertical || state.pinned.where === "mempool" || state.pinned.slotIndex == null) {
    return { state, effects: [] };
  }
  const where = state.pinned.where;
  const count = env.rows(where);
  const index =
    key === "Home"
      ? 0
      : key === "End"
        ? count - 1
        : state.pinned.slotIndex + (key === "ArrowDown" ? 1 : -1);
  const next = env.slot(where, index);
  if (!next) return { state, effects: [{ type: "prevent-default" }] };
  return {
    state: { hovered: keyOf(next), pinned: next },
    effects: [{ type: "prevent-default" }, { type: "show", target: next, pinned: true }],
  };
}
