"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { createEngine, type Engine, type EngineSample } from "@/lib/canvas/engine";
import {
  createWorld,
  enqueue,
  replayLanding,
  step,
  type WorldState,
} from "@/lib/canvas/world";
import { createSeenSet } from "@/lib/seen";
import { createBlockLedger, ingestBlock, type BlockLedger } from "@/lib/blocks";
import { readout, type VizReadout } from "@/lib/readout";
import { desaturatePalette, readTokens, type Tokens } from "@/lib/tokens";
import {
  WIDE,
  type DrawOptions,
  type FeeScale,
} from "@/lib/canvas/draw";

/**
 * Recorded seconds per real second while the instrument is still
 * calibrating a recording.
 *
 * The first five blocks of any source are dead time for a reader: nothing is
 * marked, the bar counts, a minute passes. A recording can be run faster
 * without lying — every age is compressed by the same factor and the label
 * says so — and a live stream cannot. Six puts calibration at ten seconds.
 */
export const CALIBRATION_RATE = 6;

/**
 * What the reader can do to a source that can be driven, plus the state the
 * chrome needs to label it. `null` for a source that cannot be driven.
 */
export type Transport = {
  paused: boolean;
  /** Recorded seconds per real second, as set right now. */
  rate: number;
  pause(): void;
  resume(): void;
  /** Deliver everything up to and including the next block, now. */
  nextBlock(): void;
  /** Land the block on screen again. Animation only; no datum changes. */
  replayLanding(): void;
  /**
   * Put `?block=<current>` on the address and copy it. Resolves to the URL,
   * or `null` before any block has landed.
   */
  copyLink(): Promise<string | null>;
};
import { createFeeLayout } from "@/lib/canvas/layout";
import { createQuantileScale } from "@/lib/quantile";
import { effectivePriorityFee } from "@/lib/fees";
import { activeSourceName, subscribe } from "@/lib/stream";
import { pick, pickSlot, type Inspected } from "@/lib/canvas/pick";
import {
  INITIAL_INTERACTION,
  interact,
  type InteractionEffect,
  type InteractionEvent,
  type InteractionState,
} from "@/lib/interact";
import { createGovernor, detectCapability } from "@/lib/capability";
import type {
  LinkState,
  SourceControls,
  SourceInfo,
  SourceProgress,
} from "@/types/stream";

/** Placement randomness for block marks. Seeded so a replay lands identically. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Development-only verification seam.
 *
 * `requestAnimationFrame` does not fire in a hidden tab, and an automation
 * session's tab is always hidden — so the loop itself cannot be observed there.
 * `step` and `render` are pure, though, so exposing the state lets them be
 * driven by hand with a synthetic delta and the result read back with
 * `getImageData`. Deterministic, and it needs no clock.
 */
declare global {
  interface Window {
    __darkflow?: {
      world: WorldState;
      engine: Engine;
      tokens: Tokens;
      feeScale: FeeScale;
      scale: ReturnType<typeof createQuantileScale>;
      layout: ReturnType<typeof createFeeLayout>;
      seen: ReturnType<typeof createSeenSet>;
      /**
       * The one path from a block frame to the screen, so a verifier that
       * drives blocks itself runs the real handler rather than a copy of it.
       */
      ingestBlock: typeof ingestBlock;
      blockRand: () => number;
      /** The pure simulation, so a verifier can advance time by hand. */
      step: typeof step;
      enqueue: typeof enqueue;
      /**
       * Pushes one sample to the chrome. The sampler only runs inside the rAF
       * loop, which never fires in a hidden tab, so without this the chrome
       * cannot be verified from an automation session at all.
       */
      forceSample: () => void;
      /** Sweeps the mark radius so its cost can be measured, not guessed. */
      setMarkScale: (scale: number) => void;
      /** The canonical-block ledger the readout's range is built from. */
      ledger: BlockLedger;
      /**
       * The real stream facade, so a verifier can exercise the actual source
       * end to end rather than a stand-in that might diverge from it.
       */
      subscribe: typeof subscribe;
    };
  }
}

/**
 * The canvas. One element, one animation loop, no React in the hot path.
 *
 * Everything that moves lives in refs. React is not told about transactions,
 * frames or positions — it renders this component once and then stays out of
 * the way. The instrument chrome gets its numbers from `onSample` at a few Hz,
 * which is the only place React is involved at all.
 *
 * The effect must survive being run twice: Strict Mode remounts once in
 * development, and if `cacheComponents` is ever enabled, effects are also
 * recreated on every hide→show. Both engine and subscription are idempotent
 * and fully torn down here.
 */

/** What the chrome is told, a few times a second. Never per frame. */

export type { VizReadout };
export type { Inspected };
export type VizSample = EngineSample & VizReadout;

export type VizProps = {
  onSample?: (sample: VizSample) => void;
  /**
   * What the pointer is over, or `null`.
   *
   * Fires only when the answer changes, so React re-renders when a reader moves
   * from one transaction to another and not on every pointer event. The hit
   * test runs against the world in its ref — the data never enters React.
   */
  onInspect?: (target: Inspected | null, pinned: boolean) => void;
  /**
   * Where the pointer is over the canvas, as fractions of its width and
   * height, or `null` once it has left. Every pointer event; the chrome that
   * wants it throttles itself.
   *
   * The canvas is the only surface that listens. It used to share the
   * chamber with a DOM zone that tracked the cursor for the fee readout, and
   * a zone that takes pointer events takes them from the canvas beneath it:
   * measured, a mark under the pointer answered nothing anywhere the zone
   * covered, which was the whole chamber. One listener, and the readout is
   * fed from it.
   */
  onPointer?: (at: { x: number; y: number } | null) => void;
  /** The source is fetching what it needs. `null` once it has it. */
  onProgress?: (progress: SourceProgress | null) => void;
  /** The source cannot deliver at all, and this is why. */
  onFailure?: (reason: string) => void;
  /** The transport, whenever its state changes. `null` for a live source. */
  onTransport?: (transport: Transport | null) => void;
  /** The source said what it is. Once, after it knows. */
  onSource?: (info: SourceInfo) => void;
  /**
   * The source is finite and has finished, or cannot honestly continue.
   *
   * The parent's answer is to remount this component under a new key, which
   * is the only way to restart a recording: every piece of state here — the
   * record of what was seen, the block ledger, the fee window, the field —
   * has to go back to nothing, and a stream that started over into the old
   * state would be read as a twenty-five-block reorg.
   */
  onEnd?: () => void;
  /**
   * Play the configured recording instead of the live feed. Read once, at
   * mount: the parent changes it by remounting, which is also the only way
   * to change sources — see `onEnd`.
   */
  fallback?: boolean;
  className?: string;
};

export function Viz({
  onSample,
  onInspect,
  onPointer,
  onProgress,
  onFailure,
  onTransport,
  onSource,
  onEnd,
  fallback = false,
  className,
}: VizProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /**
   * Lets the loop call the latest `onSample` without the effect listing it as a
   * dependency. Without this the effect restarts — tearing down the engine and
   * the stream — every time the parent re-renders with a new callback identity.
   */
  const emitInspect = useEffectEvent(
    (target: Inspected | null, isPinned: boolean) => {
      onInspect?.(target, isPinned);
    },
  );

  const emitSample = useEffectEvent((sample: VizSample) => {
    onSample?.(sample);
  });

  const emitPointer = useEffectEvent((at: { x: number; y: number } | null) => {
    onPointer?.(at);
  });

  const emitSource = useEffectEvent((info: SourceInfo) => {
    onSource?.(info);
  });

  const emitEnd = useEffectEvent(() => {
    onEnd?.();
  });

  const emitProgress = useEffectEvent((progress: SourceProgress | null) => {
    onProgress?.(progress);
  });

  const emitFailure = useEffectEvent((reason: string) => {
    onFailure?.(reason);
  });

  const emitTransport = useEffectEvent((transport: Transport | null) => {
    onTransport?.(transport);
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const tokens = readTokens();
    const capability = detectCapability();
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const governor = createGovernor(capability.maxEntities);

    const world = createWorld({
      maxEntities: capability.maxEntities,
      reducedMotion,
      decayTauMs: tokens.motion.decayTraceMs,
      landBlockMs: tokens.motion.landBlockMs,
      ghostAppearMs: tokens.motion.ghostAppearMs,
      landEase: tokens.motion.landEase,
    });

    /**
     * What the mempool announced. Separate from the render pool on purpose,
     * and the authority for both the ghost verdict and the flight — see
     * `lib/seen.ts`.
     */
    const seen = createSeenSet();
    const blockRand = mulberry32(0x0da4f10);

    const scale = createQuantileScale();
    const layout = createFeeLayout(scale);
    world.heightFor = (tip) => layout.heightFor(tip);
    const feeScale: FeeScale = (tip) => layout.rampFor(tip);

    /**
     * The window is resorted here, not in the render path: it is the only
     * O(n log n) anywhere near a frame. A few Hz is plenty — the fee
     * distribution does not move meaningfully between frames.
     */
    const REBUILD_INTERVAL_MS = 300;
    let lastRebuild = 0;
    function rebuildIfDue(nowMs: number) {
      if (nowMs - lastRebuild < REBUILD_INTERVAL_MS) return;
      lastRebuild = nowMs;
      scale.rebuild();
      layout.refresh();
      // The field takes no arrivals until a height means a fee. See
      // MIN_AXIS_SAMPLES.
      world.axisCalibrated = layout.calibrated();
    }

    /**
     * Everything the chrome reports, read straight from the sources of truth.
     *
     * `pending` comes from the seen-set, never from the entity count: the render
     * samples 300 of the pool and reporting what was drawn would make the
     * counter a statement about the renderer instead of about the mempool.
     */
    /**
     * Last time anything arrived. Health is inferred from silence rather than
     * from a status channel, so the subscribe(onTx, onBlock) contract stays
     * exactly as specified and every source gets the same treatment —
     * EventSource reconnects on its own, and a source that has quietly died
     * looks identical to one that never spoke.
     */
    /**
     * The clock every age on this screen is measured on.
     *
     * Stopped while the reader holds the picture, so a held mark does not
     * keep fading and a held block does not go stale; the replay stamps its
     * times on the same clock, so nothing arrives from the future when the
     * picture moves again. A live source never pauses it.
     */
    const clock = (() => {
      let lost = 0;
      let frozenAt: number | null = null;
      return {
        now: () => (frozenAt ?? Date.now()) - lost,
        pause() {
          if (frozenAt === null) frozenAt = Date.now();
        },
        resume() {
          if (frozenAt !== null) {
            lost += Date.now() - frozenAt;
            frozenAt = null;
          }
        },
        paused: () => frozenAt !== null,
      };
    })();

    let lastEventAt = clock.now();
    let lastBlockAt: number | null = null;
    /** The mempool feed on its own. Blocks keep their own clock below. */
    let lastTxAt: number | null = null;
    /** What the source says of its link; `null` for one that has none. */
    let link: LinkState | null = null;
    /**
     * Set when the stream is dropped for a hidden tab, so the snapshot the
     * reconnection brings is treated as the pool now rather than as more of
     * the pool then. See `SeenSet.seedFromSnapshot`.
     */
    let reconnecting = false;

    /**
     * What the chain has said so far, and the ratio of each classified block.
     * The authority on whether a frame is a new block, a repeat, or a reorg.
     */
    const ledger = createBlockLedger();

    function currentReadout(): VizReadout {
      return readout({
        world,
        seen,
        ticks: layout.ticks(),
        axisSamples: layout.samples(),
        axisBounds: layout.calibrated() ? layout.bounds() : null,
        view: engine.view(),
        recentRatios: ledger.ratios(),
        reorgs: ledger.reorgs(),
        lastBlockAt,
        lastEventAt,
        lastTxAt,
        link,
        // Distinguishes a paused stream from a dead one.
        subscribed: unsubscribe !== null,
        budgetReduced: governor.reduced(),
        now: clock.now(),
      });
    }


    let unsubscribe: (() => void) | null = null;
    /** What the source said it is, or `null` until it says. */
    let sourceInfo: SourceInfo | null = null;
    /** How to drive the source, if it can be driven. */
    let sourceControls: SourceControls | null = null;
    /** What the reader is pointing at or has pinned, for the renderer. */
    let highlight: DrawOptions["highlight"] = null;

    /**
     * A recording runs fast while nothing can be classified and at real pace
     * once something can. Re-applied after every block, because the block
     * that closes the warm-up is the one that changes the answer.
     */
    function applyRate() {
      if (!sourceControls) return;
      sourceControls.setRate(seen.isWarm() ? 1 : CALIBRATION_RATE);
      publishTransport();
    }

    function publishTransport() {
      if (!sourceControls) {
        emitTransport(null);
        return;
      }
      emitTransport({
        paused: clock.paused(),
        rate: sourceControls.rate(),
        pause,
        resume,
        nextBlock,
        replayLanding: () => replayLanding(world),
        copyLink,
      });
    }

    function pause() {
      if (!sourceControls || clock.paused()) return;
      sourceControls.pause();
      clock.pause();
      engine.setPaused(true);
      publishTransport();
    }

    function resume() {
      if (!sourceControls || !clock.paused()) return;
      engine.setPaused(false);
      clock.resume();
      sourceControls.resume();
      publishTransport();
    }

    function nextBlock() {
      if (!sourceControls) return;
      if (clock.paused()) resume();
      sourceControls.nextBlock();
    }

    async function copyLink(): Promise<string | null> {
      const number = world.lastBlock?.number;
      if (number == null) return null;
      const url = new URL(window.location.href);
      url.searchParams.set("block", String(number));
      window.history.replaceState(null, "", url);
      try {
        await navigator.clipboard.writeText(url.href);
      } catch {
        // No clipboard permission: the address bar carries it anyway.
      }
      return url.href;
    }

    /**
     * A deep link, read once. Cleared from the address as soon as the source
     * has it, so a restart of the recording does not open at the same block
     * every pass; `copyLink` puts it back on request.
     */
    const startAtBlock = (() => {
      // Only a recording can open at a block. Read for a live source, the
      // parameter would be carried into `subscribe` and ignored there, and a
      // reader who shared the link would find it meant nothing — better that
      // it is never read than that it is read and silently dropped.
      if (activeSourceName() !== "replay" && !fallback) return undefined;
      const raw = new URLSearchParams(window.location.search).get("block");
      return raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
    })();

    /**
     * Calibration desaturates the canvas by recolouring its own cached palette.
     * Both variants are computed once at mount, so switching costs a pointer
     * swap rather than a per-frame filter over a surface that repaints
     * constantly.
     */
    /** Swept from the verification seam; see `DrawOptions.markScale`. */
    let markScale = capability.markScale;

    const livePalette = tokens.palette;
    const calibratingPalette = desaturatePalette(tokens.palette, 0.4);

    const engine = createEngine({
      canvas,
      world,
      palette: () => (seen.isWarm() ? livePalette : calibratingPalette),
      feeScale,
      // Rule 1 during warm-up: --ghost is not merely hidden, it is never
      // reached. The classifier does not run either — see the block handler.
      drawOptions: () => ({
        showGhosts: seen.isWarm(),
        ticks: layout.ticks(),
        markScale,
        reducedMotion,
        highlight,
        // The same governor that cuts the entity cap cuts the tracks: a
        // device that could not keep frames up with fewer marks is not given
        // a block's worth of lines on top.
        tracks: governor.reduced() ? "lit" : "all",
      }),
      clock: clock.now,
      beforeStep: rebuildIfDue,
      onSample: (sample) => {
        // Capacity, not a breakpoint: the cap follows frames that actually
        // rendered on this device, under whatever else it is doing. Both the
        // window's average and its worst single frame — a stutter the
        // average can hide — feed the decision.
        world.maxEntities = governor.observe(
          sample.fps,
          sample.maxFrameMs,
          world.maxEntities,
        );
        emitSample({ ...sample, ...currentReadout() });
      },
      onVisibilityChange: (visible) => {
        // A hidden tab has no loop, so an open stream would only build a
        // backlog to discard. Drop it and reconnect on return.
        if (!visible) {
          unsubscribe?.();
          unsubscribe = null;
          link = null;
        } else if (!unsubscribe) {
          // A recording cannot be reconnected. Resumed where it was, every
          // age would be off by the time the tab was hidden; restarted into
          // this state, its first block would read as a reorg. It restarts
          // from nothing, which is what `onEnd` asks the parent for.
          if (sourceInfo?.kind === "recording") {
            emitEnd();
            return;
          }
          /**
           * Coming back to a live feed.
           *
           * Nothing arrived while the tab was hidden — the stream was dropped
           * on purpose — so there is no backlog to replay, and replaying one
           * would be the wrong thing anyway: a minute of arrivals in a frame is
           * the burst the intake meter exists to prevent. What is stale is the
           * record: transactions that were mined or dropped while nobody was
           * listening are still counted as pending. So the record is pruned to
           * the clock now, and the snapshot the reconnection brings reconciles
           * the rest. The silence clock restarts too — the quiet was ours.
           */
          world.inbox = [];
          seen.prune(clock.now());
          reconnecting = true;
          lastEventAt = clock.now();
          lastTxAt = null;
          unsubscribe = connect();
        }
      },
    });

    function connect() {
      return subscribe(
        (txs, meta) => {
          // Feed the window from every arrival, including the ones the render
          // pool will reject. The scale describes the mempool, not the 300
          // transactions that happen to be on screen.
          lastEventAt = clock.now();
          lastTxAt = lastEventAt;
          for (const tx of txs) {
            scale.push(effectivePriorityFee(tx.fees, world.baseFeePerGas));
          }
          if (meta.snapshot) {
            seen.seedFromSnapshot(txs, { reconcile: reconnecting });
            reconnecting = false;
          } else {
            seen.addMany(txs);
          }
          enqueue(world, txs);
        },
        (block) => {
          lastEventAt = clock.now();
          // Everything a block frame does to the record, the world and the
          // ledger happens in `ingestBlock`; see `lib/blocks.ts`. What stays
          // here is the only thing the handler knows that the function does
          // not: when the frame arrived.
          const verdict = ingestBlock({
            block,
            seen,
            world,
            ledger,
            rand: blockRand,
          });
          // A duplicate is not a block. It must not make the block feed look
          // current when the last real block may be minutes old.
          if (verdict.kind !== "duplicate") lastBlockAt = lastEventAt;
          applyRate();
        },
        {
          now: clock.now,
          startAtBlock,
          onLink: (state) => {
            link = state;
          },
          onDescribe: (info) => {
            sourceInfo = info;
            emitSource(info);
            emitProgress(null);
            if (startAtBlock !== undefined) {
              const url = new URL(window.location.href);
              url.searchParams.delete("block");
              window.history.replaceState(null, "", url);
            }
          },
          onControls: (controls) => {
            sourceControls = controls;
            applyRate();
          },
          onProgress: (progress) => emitProgress(progress),
          onFailure: (reason) => {
            emitProgress(null);
            emitFailure(reason);
          },
          onEnd: () => emitEnd(),
        },
        { fallback },
      );
    }

    /**
     * Pointing at a transaction.
     *
     * Listeners go on the canvas rather than on a React element because the
     * answer comes from the world in this closure, not from state. The result
     * is compared before it is emitted, so moving the pointer across empty
     * chamber does not re-render the chrome sixty times a second.
     *
     * A pinned target survives pointer movement: a reader who found the
     * transaction they wanted should be able to read it without holding the
     * mouse perfectly still. Clicking empty space, or pressing Escape, lets go.
     */
    /**
     * The rules live in `lib/interact.ts`, pure and tested. What stays here is
     * the translation: a DOM event into an interaction event with what it
     * needs resolved against the world, and the effects that come back into
     * the canvas, the chrome and the transport.
     */
    let interaction: InteractionState = INITIAL_INTERACTION;

    const pickOptions = () => ({
      showGhosts: seen.isWarm(),
      feeScale,
      now: clock.now(),
    });

    function targetAt(event: PointerEvent | MouseEvent): Inspected | null {
      const box = canvas!.getBoundingClientRect();
      return pick(
        world,
        engine.view(),
        { x: event.clientX - box.left, y: event.clientY - box.top },
        {
          ...pickOptions(),
          // What is ringed in the chamber right now is what the pointer is
          // holding: it keeps answering while it drifts, and a click pins
          // exactly what the reader sees ringed.
          held: highlight?.where === "mempool" ? highlight.hash : null,
        },
      );
    }

    /** One place decides what is ringed on the canvas and what the panel shows. */
    function show(target: Inspected | null, isPinned: boolean) {
      highlight = target ? { hash: target.hash, where: target.where } : null;
      emitInspect(target, isPinned);
    }

    function apply(effects: InteractionEffect[], domEvent?: Event) {
      for (const effect of effects) {
        switch (effect.type) {
          case "show":
            show(effect.target, effect.pinned);
            break;
          case "cursor":
            canvas!.style.cursor = effect.value;
            break;
          case "prevent-default":
            domEvent?.preventDefault();
            break;
          case "transport":
            if (effect.action === "toggle-pause") {
              if (clock.paused()) resume();
              else pause();
            } else if (effect.action === "next-block") {
              nextBlock();
            } else {
              replayLanding(world);
            }
            break;
        }
      }
    }

    function dispatch(event: InteractionEvent, domEvent?: Event) {
      const result = interact(interaction, event, {
        slot: (where, index) =>
          pickSlot(world, engine.view(), where, index, pickOptions()),
        rows: (where) =>
          where === "block" ? world.block.length : world.previousBlock.length,
        hasTransport: sourceControls !== null,
      });
      interaction = result.state;
      apply(result.effects, domEvent);
    }

    function handleMove(event: PointerEvent) {
      const box = canvas!.getBoundingClientRect();
      const at = {
        x: (event.clientX - box.left) / box.width,
        y: (event.clientY - box.top) / box.height,
      };
      emitPointer(at);
      const g = engine.view().g ?? WIDE;
      const inChamber =
        at.x >= g.CHAMBER_LEFT &&
        at.x <= g.FIELD_FADE_END &&
        at.y >= g.CHAMBER_TOP &&
        at.y <= g.CHAMBER_TOP + g.CHAMBER_EXTENT;
      // The hit test is the expensive part; a pinned target never needs it.
      const target = interaction.pinned ? null : targetAt(event);
      dispatch({ type: "move", target, inChamber });
    }

    function handleLeave() {
      emitPointer(null);
      dispatch({ type: "leave" });
    }

    function handleClick(event: MouseEvent) {
      dispatch({ type: "click", target: targetAt(event) });
    }

    /**
     * The keyboard. Esc releases; ↑↓ step the pinned row through its column;
     * space pauses a source that can pause; n jumps to the next block; r
     * lands the block again. Never while a button or link has focus — those
     * have their own space and enter.
     */
    function handleKey(event: KeyboardEvent) {
      // Never while a button or link has focus — those have their own space
      // and enter, and the transport's buttons are exactly that.
      const on = event.target instanceof HTMLElement ? event.target : null;
      if (on && (on.tagName === "BUTTON" || on.tagName === "A" || on.tagName === "INPUT")) {
        return;
      }
      dispatch(
        {
          type: "key",
          key: event.key,
          canvasFocused: document.activeElement === canvas,
        },
        event,
      );
    }
    canvas.addEventListener("pointermove", handleMove);
    canvas.addEventListener("pointerleave", handleLeave);
    canvas.addEventListener("click", handleClick);
    window.addEventListener("keydown", handleKey);

    engine.start();
    if (document.visibilityState === "visible") unsubscribe = connect();

    // One sample before any frame has run. Without it the chrome has nothing
    // to render until the first sampling interval elapses, so the calibration
    // bar — the one piece of UI whose whole job is to be there from the very
    // first moment — would appear late.
    emitSample({
      fps: 0,
      maxFrameMs: 0,
      entities: 0,
      notSampled: 0,
      evictedFromTop: 0,
      culledByAge: 0,
      ...currentReadout(),
    });

    if (process.env.NODE_ENV !== "production") {
      console.log("[viz] render budget: " + capability.reason);
    }

    if (process.env.NODE_ENV !== "production") {
      // Verification seam. `requestAnimationFrame` never fires in a hidden tab,
      // so the loop cannot be observed from an automation session — but `step`
      // and `render` are pure, so they can be driven by hand and the result
      // read back with getImageData.
      window.__darkflow = {
        world, engine, tokens, feeScale, step, enqueue, scale, layout, seen,
        ingestBlock, blockRand, subscribe,
        setMarkScale: (next: number) => {
          markScale = next;
        },
        ledger,
        forceSample: () =>
          emitSample({
            fps: 0,
            maxFrameMs: 0,
            entities: world.entities.length,
            notSampled: world.notSampled,
            evictedFromTop: world.evictedFromTop,
            culledByAge: world.culledByAge,
            ...currentReadout(),
          }),
      };
    }

    return () => {
      canvas.removeEventListener("pointermove", handleMove);
      canvas.removeEventListener("pointerleave", handleLeave);
      canvas.removeEventListener("click", handleClick);
      window.removeEventListener("keydown", handleKey);
      engine.stop();
      unsubscribe?.();
      unsubscribe = null;
      sourceControls = null;
      emitTransport(null);
      if (process.env.NODE_ENV !== "production") delete window.__darkflow;
    };
    // `fallback` is read once at mount by design: sources change only by
    // remounting (see onEnd), so re-running this effect on a prop change
    // would tear down a healthy stream to arrive at the same decision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      /**
       * Focusable, so the block can be read without a pointer: Tab reaches
       * it, ↓ pins the first row, ↑↓ walk the column, Esc lets go. The
       * inspector is a live region, so each row is read out as it is pinned.
       *
       * It used to be `aria-hidden`, on the grounds that every number it
       * draws is also real text in the chrome. True of the figures; not true
       * of the one thing only the canvas addresses, which is a single
       * transaction. A focusable element cannot be hidden from the tree, so
       * it is named instead, and the name says what the keys do.
       */
      tabIndex={0}
      role="img"
      aria-label="Mempool and block. Press down to pin the first row of the block, up and down to move through it, Escape to release."
    />
  );
}

export default Viz;
