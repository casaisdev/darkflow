"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  Viz,
  type Inspected,
  type Transport,
  type VizSample,
} from "@/components/Viz";
import { CalibrationBar, calibrationSummary } from "@/components/CalibrationBar";
import { StatusIndicator, type StreamStatus } from "@/components/StatusIndicator";
import { Wordmark } from "@/components/Logo";
import { geometryFor, NARROW_BELOW_PX, WIDE, type Geometry } from "@/lib/canvas/draw";
import { MIN_RATIO_WINDOW_BLOCKS, RATIO_WINDOW_BLOCKS } from "@/lib/readout";
import { activeSourceName, fallbackConfigured, ingestStateUrl } from "@/lib/stream";
import { fetchCoverage, type FeedCoverage } from "@/lib/stream/coverage";
import { FLOOR_BAND, thinTicks } from "@/lib/canvas/layout";
import type { LinkState } from "@/types/stream";
import type { SourceInfo, SourceProgress } from "@/types/stream";

/**
 * The apparatus: the chamber, and the panel that reads it.
 *
 * The only React state in the whole visualiser lives here, written a few times
 * a second from `Viz`'s sampler — never per frame. Transactions, positions and
 * frames are none of React's business.
 *
 * The chrome carries the calibration desaturation. It must not wrap the canvas:
 * a CSS filter over a surface that repaints sixty times a second is paid for on
 * every repaint, and the canvas already desaturates its own cached palette.
 *
 * Positions come from the canvas geometry constants rather than a second set of
 * numbers, so a label can never drift off the thing it names.
 */

/**
 * Silence past this and the stream is reported dead.
 *
 * Longer than a block interval, so a quiet twelve seconds between blocks is
 * never mistaken for a dead stream. Exported because "how long before the page
 * stops presenting old numbers as current" is a claim, and a claim belongs
 * somewhere a test can reach it.
 */
export const STALE_AFTER_S = 25;

/**
 * Seconds of no transaction batches before the mempool feed is called silent.
 *
 * Its own threshold, apart from the block feed's: a block every twelve
 * seconds is ordinary, and a mainnet pool quiet for ten is not — the ingest
 * batches at a few hertz and a quiet second is already unusual. Ten leaves
 * room for a slow batch and a reconnection, and fires well before the block
 * feed's cadence could hide the transaction feed having died.
 */
export const TXS_SILENT_AFTER_S = 10;

/**
 * Seconds of no signal on a live build before the recording stands in.
 *
 * Longer than `STALE_AFTER_S`, so the page says "no signal" first and for
 * long enough that a reader sees the feed is the problem, and shorter than
 * a reader's patience with a blank instrument. `EventSource` retries every
 * few seconds; a minute of failed retries is an outage, not a hiccup.
 */
export const FALLBACK_AFTER_S = 60;

/**
 * Whether to give up on the live feed and play the recording.
 *
 * Pure, so the rule can be tested without a stream. Only ever true once per
 * page: after the switch the source is the recording, and the recording does
 * not fall back to itself.
 */
export function shouldFallBack(inputs: {
  configured: boolean;
  fallback: boolean;
  failure: string | null;
  staleSeconds: number | null;
}): boolean {
  if (!inputs.configured || inputs.fallback) return false;
  if (inputs.failure) return true;
  return (inputs.staleSeconds ?? 0) > FALLBACK_AFTER_S;
}

/**
 * The status, from everything the chrome knows.
 *
 * Provenance outranks health: "simulated" and "recorded" beat "live" because
 * a green dot over data that is not the chain now is the one claim this page
 * must never make. Within health, what the source *says* beats what silence
 * suggests — a socket the browser is retrying is reconnecting, not merely
 * quiet — and a failure beats everything.
 */
export function streamStatusOf(inputs: {
  failure: string | null;
  hasSample: boolean;
  sourceName: "sse" | "replay" | "synthetic";
  stale: boolean;
  link: LinkState | null;
  calibrating: boolean;
}): StreamStatus {
  const { failure, hasSample, sourceName, stale, link, calibrating } = inputs;
  if (failure) return "down";
  if (!hasSample) return sourceName === "replay" ? "loading" : "connecting";
  if (link === "closed") return "down";
  if (stale) return "down";
  if (link === "reconnecting") return "reconnecting";
  if (calibrating) return "calibrating";
  if (sourceName === "synthetic") return "simulated";
  if (sourceName === "replay") return "recorded";
  return "live";
}

/**
 * The explorer page for a transaction, or `null` where there is no chain
 * to look it up on.
 *
 * Keyed by chain id, because a recording says which chain it is and a link to
 * mainnet's explorer for a Sepolia hash is a page that says "not found". A
 * live feed carries no chain id on the wire; it is taken to be mainnet, which
 * is what the ingest is built against — stated here rather than assumed
 * silently, so the day it is wrong there is a line to find.
 */
export function explorerTxUrl(chainId: number | null, hash: string): string | null {
  switch (chainId) {
    case 1:
      return `https://etherscan.io/tx/${hash}`;
    case 11155111:
      return `https://sepolia.etherscan.io/tx/${hash}`;
    case 17000:
      return `https://holesky.etherscan.io/tx/${hash}`;
    default:
      return null;
  }
}

/** The assumption above, as a constant, so it is greppable. */
export const LIVE_CHAIN_ID = 1;

/**
 * Below this viewport width the stylesheet moves the axis unit to the head of
 * the scale. One number, matching Tailwind's `lg` exactly, so the TSX and the
 * CSS agree about which layout is on screen.
 */
export { NARROW_BELOW_PX };

/**
 * Whether a tick's numeral would sit under the axis unit and must yield.
 *
 * On a narrow screen the unit moves to the head of the scale — the foot is
 * under the panel there — and the topmost tick can land within a line-height
 * of it. Two labels on one spot is no label, so the numeral yields and the
 * tick keeps its rule: the height is still marked, it is briefly nameless.
 * Measured at 390×844: "GWEI" and "1.5" overlapped by most of a line.
 */
export function tickYieldsToUnit(inputs: {
  viewWidth: number;
  viewHeight: number;
  tickHeight: number;
}): boolean {
  if (inputs.viewWidth >= NARROW_BELOW_PX) return false;
  /**
   * The unit hangs 6px below the chamber's top and is 12px tall, so it
   * occupies the first ~18px inside the chamber — not the space above it,
   * which is what the first version of this assumed. A numeral is centred on
   * its tick and half of it reaches 6px above the centre, plus a 2px gap:
   * 18 + 6 + 2. The first constant here was 14, reasoned from the wrong
   * anchor, and measured at 390×844 it still left "GWEI" two pixels into
   * "1.5".
   */
  const CLEARANCE_PX = 26;
  const chamberPx = inputs.viewHeight * geometryFor(inputs.viewWidth).BLOCK_EXTENT;
  return inputs.tickHeight * chamberPx < CLEARANCE_PX;
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;
/** Normalised chamber height → a CSS top offset, matching `chamberY`. */
const chamber = (normalised: number, g: Geometry = WIDE) =>
  pct(g.CHAMBER_TOP + normalised * g.CHAMBER_EXTENT);

/** A legend and its value. Secondary register: small, quiet, tabular. */
/** How often the feed is asked for its own coverage. Once a minute is plenty for a figure over ten blocks. */
const COVERAGE_EVERY_MS = 60_000;

/**
 * The feed's coverage, polled while a live ingest is the source. Null until
 * the first answer, and null again if the ingest stops answering: a figure
 * kept from before would be a claim about now.
 */
function useFeedCoverage(url: string | null, active: boolean): FeedCoverage | null {
  const [coverage, setCoverage] = useState<FeedCoverage | null>(null);
  useEffect(() => {
    if (!url || !active) return;
    let cancelled = false;
    const ask = async () => {
      if (document.hidden) return;
      const next = await fetchCoverage(url);
      if (!cancelled) setCoverage(next);
    };
    void ask();
    const timer = setInterval(ask, COVERAGE_EVERY_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [url, active]);
  // Derived, not stored: an inactive source shows nothing, whatever was read
  // before, without an effect having to write state to say so.
  return url && active ? coverage : null;
}

function Reading({
  legend,
  value,
  unit,
  unknown,
  stale,
  def,
}: {
  legend: string;
  value: string;
  unit?: string;
  /** One line saying what the legend means, shown on hover or focus. */
  def?: string;
  /** Renders an explicit blank. A number would be a claim. */
  unknown?: boolean;
  /**
   * True, but no longer current. Shown rather than hidden — it was a real
   * measurement — and marked, because presenting it plainly would make it a
   * claim about now.
   */
  stale?: boolean;
}) {
  return (
    /* A legend never wraps. Measured at 1424px: the grid's column is 143.6px
       and "BASE FEE" (56) + a 24px gap + "0.74 gwei" (64) is 144, so the one
       legend with a space in it broke over two lines. The gap gives the 8px
       back; nowrap makes the rule hold at any width, with overflow — a few
       pixels at 1280 — landing in the 40px column gap where nothing lives. */
    <div className="flex items-baseline justify-between gap-4">
      <span
        className="df-legend df-def whitespace-nowrap"
        data-def={def}
        tabIndex={def ? 0 : undefined}
      >
        {legend}
      </span>
      <span className="df-secondary" data-stale={stale ? "true" : undefined}>
        {unknown ? <span className="text-calib">—</span> : value}
        {unit && !unknown ? (
          <span className="text-text-dim ml-1.5 text-[11px]">{unit}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * The scale under the primary numeral.
 *
 * Fixed at 0–100, which are the claim's own bounds. A track that rescaled to
 * fit the data would move the needle without the reading having changed, which
 * is the one thing a scale may never do.
 */
function PrimaryScale({
  value,
  window: range,
  samples,
}: {
  value: number | null;
  window: { low: number; high: number; blocks: number } | null;
  /** Blocks behind the window, so the absence of a band can be described. */
  samples: number;
}) {
  const pos = (fraction: number) => `${(fraction * 100).toFixed(2)}%`;
  const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;
  // The scale carries a reading that appears nowhere in the text, so it is
  // described rather than hidden. The numeral above it is the value; this is
  // the range, and a reader who cannot see the band would otherwise not get it.
  const description =
    value == null
      ? "No reading yet"
      : range
        ? `${percent(value)} of a 0 to 100% scale. ` +
          `Over the last ${range.blocks} blocks: ` +
          `${percent(range.low)} to ${percent(range.high)}.`
        : `${percent(value)} of a 0 to 100% scale. No range yet: ` +
          `${samples} of ${MIN_RATIO_WINDOW_BLOCKS} blocks measured.`;
  return (
    <div className="df-scale" role="img" aria-label={description}>
      <span className="df-scale-track" />
      {[0, 0.5, 1].map((at) => (
        <span
          key={at}
          className="df-scale-tick"
          style={{ left: pos(at), marginLeft: at === 1 ? -1 : 0 }}
        />
      ))}
      {range ? (
        <span
          className="df-scale-band"
          style={{ left: pos(range.low), width: pos(range.high - range.low) }}
        />
      ) : null}
      {value != null ? (
        // Centred on its value, like a needle. Left-edged, a reading of 100%
        // would sit entirely past the end of its own scale.
        <span
          className="df-scale-needle"
          style={{ left: pos(value), transform: "translateX(-50%)" }}
        />
      ) : null}
    </div>
  );
}

/**
 * The last twenty blocks, as a sequence.
 *
 * The band under the numeral says how wide the window ran; this says in what
 * order, which is the difference between "41% is a spike" and "41% is where
 * it has been". One column per block, oldest left, the current block last
 * and in the reading's colour. Empty columns are blocks not yet measured —
 * drawn as a tick on the baseline, so the strip fills in as the window does
 * rather than rescaling.
 */
function RatioHistory({
  ratios,
  size,
}: {
  ratios: readonly number[];
  size: number;
}) {
  const shown = ratios.slice(-size);
  const missing = size - shown.length;
  const label =
    shown.length === 0
      ? "No blocks measured yet"
      : `Last ${shown.length} blocks, oldest first: ${shown.map((r) => `${(r * 100).toFixed(0)}%`).join(", ")}`;
  return (
    <div className="df-history df-phone-extra" role="img" aria-label={label}>
      {Array.from({ length: missing }, (_, i) => (
        <span key={`empty-${i}`} className="df-history-slot" />
      ))}
      {shown.map((ratio, i) => (
        <span
          key={`r-${missing + i}`}
          className="df-history-slot"
          data-latest={i === shown.length - 1 ? "true" : undefined}
        >
          <span
            className="df-history-bar"
            style={{ height: `${Math.max(1, Math.round(ratio * 100))}%` }}
          />
        </span>
      ))}
    </div>
  );
}

/**
 * The cursor over the chamber.
 *
 * An instrument you can point at is the difference between a picture of data
 * and something you can interrogate. The fee axis has five or six labelled
 * ticks; between them a reader could only guess, and the one question anyone
 * has looking at a cloud of marks is "what is this one paying".
 *
 * It reports the fee at the pointer's height and how many pending transactions
 * are in that band. Both are read off the same axis the marks are placed by,
 * so the cursor cannot disagree with the picture.
 *
 * Hover only, and deliberately not the only route to the information: the
 * labelled ticks give the scale without a pointer, so nothing here is
 * unreachable from a keyboard because nothing here is exclusive.
 */
/**
 * The pointer, published by the canvas and read by whoever asks.
 *
 * Not React state on the instrument: a pointer event is a hundred times a
 * second, and re-rendering the whole panel for each would be paying for the
 * readout with everything around it. The cursor subscribes and keeps its own
 * state; nothing else re-renders.
 */
type PointerAt = { x: number; y: number } | null;
type PointerFeed = {
  publish: (at: PointerAt) => void;
  subscribe: (listener: (at: PointerAt) => void) => () => void;
};

function createPointerFeed(): PointerFeed {
  const listeners = new Set<(at: PointerAt) => void>();
  return {
    publish: (at) => {
      for (const listener of listeners) listener(at);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * What the cursor reads at a chamber height.
 *
 * Inside the band there is no fee to read: a mark's y there is packing
 * space. Saying "0.001 gwei" would name a value the position does not carry.
 */
export function cursorReadingAt(
  height: number,
  range: { lowGwei: number; highGwei: number },
): { kind: "floor" } | { kind: "gwei"; gwei: number } {
  if (height >= 1 - FLOOR_BAND) return { kind: "floor" };
  const lo = Math.log(range.lowGwei);
  const hi = Math.log(range.highGwei);
  const t = height / (1 - FLOOR_BAND);
  return { kind: "gwei", gwei: Math.exp(lo + (1 - t) * (hi - lo)) };
}

function ChamberCursor({
  range,
  profile,
  feed,
  g,
}: {
  range: { lowGwei: number; highGwei: number } | null;
  profile: readonly number[];
  feed: PointerFeed;
  g: Geometry;
}) {
  const [at, setAt] = useState<number | null>(null);

  useEffect(
    () =>
      feed.subscribe((p) => {
        if (!p) {
          setAt(null);
          return;
        }
        // Inside the measured volume only: the same rectangle the zone used
        // to cover, read off the pointer the canvas reports.
        const height = (p.y - g.CHAMBER_TOP) / g.CHAMBER_EXTENT;
        const inside =
          p.x >= g.CHAMBER_LEFT &&
          p.x <= g.FIELD_FADE_END &&
          height >= 0 &&
          height <= 1;
        setAt(inside ? height : null);
      }),
    [feed, g],
  );

  if (!range) return null;

  const reading = at == null ? null : cursorReadingAt(at, range);
  const format = (gwei: number) =>
    gwei >= 100
      ? gwei.toFixed(0)
      : gwei >= 10
        ? gwei.toFixed(1)
        : gwei.toFixed(2);

  const band =
    at == null
      ? 0
      : profile[
          Math.min(profile.length - 1, Math.floor(at * profile.length))
        ] ?? 0;

  return (
    <div
      className="df-cursor-zone absolute"
      style={{
        left: pct(g.CHAMBER_LEFT),
        width: pct(g.FIELD_FADE_END - g.CHAMBER_LEFT),
        top: pct(g.CHAMBER_TOP),
        height: pct(g.CHAMBER_EXTENT),
      }}
    >
      {at == null ? null : (
        <div className="df-cursor" style={{ top: `${at * 100}%` }}>
          {/* The reading at the axis end of the rule, where a reading of a
              horizontal rule belongs: the eye follows the rule to the spine
              and finds the value there, beside the numerals it is between. It
              sat at the far end, three hundred pixels from the pointer. */}
          <span className="df-cursor-readout">
            {reading?.kind === "floor" ? (
              <span className="df-cursor-fee">at base fee</span>
            ) : (
              <>
                <span className="df-cursor-fee">
                  {format(reading?.kind === "gwei" ? reading.gwei : 0)}
                </span>
                <span className="df-cursor-unit">gwei</span>
              </>
            )}
            <span className="df-cursor-count">
              {band} {band === 1 ? "mark" : "marks"} in this band
            </span>
          </span>
          <span className="df-cursor-rule" />
        </div>
      )}
    </div>
  );
}

/**
 * What one transaction is.
 *
 * The chamber shows a population and the block shows a composition; neither
 * answers "what is that one". This does, and it is the only place on the page
 * where a single transaction is addressed at all.
 *
 * Every field here is either a measurement or an explicit blank. Private flow
 * has no announced fee — it was never in the mempool, which is the whole point
 * — so its fee reads "not announced" rather than a zero that would look like a
 * cheap transaction.
 */
function Inspector({
  target,
  pinned,
  explorerUrl,
  touch,
}: {
  target: Inspected | null;
  pinned: boolean;
  /** Where the hash can be looked up, or `null` for one no explorer knows. */
  explorerUrl: string | null;
  /** A phone: no hover, no keyboard; the hint says what a thumb can do. */
  touch: boolean;
}) {
  // Which hash was copied, so the label resets on its own when the target
  // changes — no effect, nothing to keep in step.
  const [copiedHash, setCopiedHash] = useState<string | null>(null);
  if (!target) return null;
  const inColumn = target.where !== "mempool";
  const copied = copiedHash === target.hash;

  const gwei = (value: number) =>
    value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(3);
  const where =
    target.where === "mempool"
      ? "Waiting in the mempool"
      : target.where === "block"
        ? `In this block · position ${(target.slotIndex ?? 0) + 1}`
        : `In the previous block · position ${(target.slotIndex ?? 0) + 1}`;

  return (
    <div className="df-inspector" role="status" aria-live="polite">
      <div className="df-inspector-head">
        <span className="df-legend">{where}</span>
        {target.origin === "ghost" ? (
          <span className="df-inspector-flag">never seen by this feed</span>
        ) : null}
      </div>

      <span className="df-inspector-hash">
        {target.hash.slice(0, 10)}…{target.hash.slice(-8)}
      </span>

      <dl className="df-inspector-rows">
        <div>
          <dt>Priority fee</dt>
          <dd>
            {target.tipGwei == null ? (
              <span className="df-inspector-unknown">not announced</span>
            ) : (
              <>
                {gwei(target.tipGwei)}
                <span className="df-inspector-unit">gwei</span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Offered</dt>
          <dd>
            {target.offeredGwei == null ? (
              <span className="df-inspector-unknown">—</span>
            ) : (
              <>
                {gwei(target.offeredGwei)}
                <span className="df-inspector-unit">
                  gwei {target.feeKind === "legacy" ? "· legacy" : "· cap"}
                </span>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{target.gasIsUsed ? "Gas used" : "Gas limit"}</dt>
          <dd>{target.gas.toLocaleString("en-US")}</dd>
        </div>
        {target.percentile != null ? (
          <div>
            <dt>Fee rank</dt>
            <dd>
              {(target.percentile * 100).toFixed(0)}%
              <span className="df-inspector-unit">
                of the pool pays less
              </span>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>{target.where === "mempool" ? "Waiting" : "First seen"}</dt>
          <dd>
            {target.ageSeconds == null ? (
              <span className="df-inspector-unknown">—</span>
            ) : (
              <>
                {target.ageSeconds < 60
                  ? target.ageSeconds.toFixed(1)
                  : (target.ageSeconds / 60).toFixed(1)}
                <span className="df-inspector-unit">
                  {target.ageSeconds < 60 ? "s ago" : "min ago"}
                </span>
              </>
            )}
          </dd>
        </div>
      </dl>

      {pinned ? (
        <div className="df-inspector-actions">
          {explorerUrl ? (
            <a
              className="df-inspector-action"
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Etherscan ↗
            </a>
          ) : null}
          <button
            type="button"
            className="df-inspector-action"
            onClick={() => {
              navigator.clipboard
                ?.writeText(target.hash)
                .then(() => setCopiedHash(target.hash))
                .catch(() => setCopiedHash(null));
            }}
          >
            {copied ? "Copied" : "Copy hash"}
          </button>
        </div>
      ) : null}

      <span className="df-legend df-inspector-hint">
        {touch
          ? pinned
            ? "Pinned · tap elsewhere to release"
            : "Tap to pin"
          : pinned
            ? inColumn
              ? "Pinned · ↑↓ next row · Esc releases"
              : "Pinned · Esc releases"
            : "Click to pin"}
      </span>
    </div>
  );
}

/** 212189 → "212K". Gas figures are read as magnitudes, never to the unit. */
function compactGas(gas: number): string {
  if (gas >= 1_000_000) return `${(gas / 1_000_000).toFixed(2)}M`;
  return `${Math.round(gas / 1000)}K`;
}

/**
 * How far every region's label stack sits above the chamber's top rule.
 *
 * One number for all four, and they are anchored by their bottoms rather than
 * their tops, because the stacks are three, four and two lines tall. Anchoring
 * by the top made four identically-set names land at four different heights —
 * measured at y 37, 52, 55 and 65 — and four peers at four heights do not read
 * as peers.
 */
const REGION_LABEL_LIFT = 6;

/** Two significant figures, no trailing zeros: 1.5, 0.002, 12. */
function gweiBound(gwei: number): string {
  return String(Number(gwei.toPrecision(2)));
}

/**
 * Where the fee numerals sit, as custom properties rather than a fixed edge.
 *
 * Wide, they end on the axis from the gutter outside the frame. Below lg that
 * gutter is a few pixels and a right-aligned numeral runs off the screen, so
 * the stylesheet moves them just inside the chamber instead — see the
 * small-screen block in globals.css. Both edges are computed here, from the
 * same constant, so neither can drift from the axis it labels. Set on the
 * overlay and inherited, so each label carries only its own `top`.
 */
const axisVarsFor = (g: Geometry) => ({
  "--axis-right": `calc(${pct(1 - g.CHAMBER_LEFT)} + 8px)`,
  "--axis-left": `calc(${pct(g.CHAMBER_LEFT)} + 6px)`,
  // Under the foot of the scale, not over its head. The head of the gutter
  // is where the chamber's own notes sit, and a unit placed there landed on
  // top of "fades as it waits". Either end of a scale is a conventional
  // place for its unit; only one of them is empty — except on a small
  // screen, where the panel grows over the foot and the notes are gone from
  // the head, so the stylesheet swaps ends.
  "--axis-unit-foot": `calc(${pct(g.BLOCK_TOP + g.BLOCK_EXTENT)} + 7px)`,
  "--axis-unit-head": `calc(${pct(g.BLOCK_TOP)} + 6px)`,
}) as CSSProperties;

/**
 * What a recording is, in two short lines under the status.
 *
 * Chain and capture time in UTC; then the blocks it holds and how many times
 * it has restarted — because the reader who sees block 25,842,547 land for
 * the second time deserves to be told it is the second time.
 *
 * Two lines and not one, and the last block abbreviated to the digits that
 * differ: measured at 900px tall, the full form ran to three lines and pushed
 * the plate's first item onto its top rule.
 */
export function recordingSummary(
  info: Extract<SourceInfo, { kind: "recording" }>,
  pass: number,
): [string, string] {
  const chain = info.chainId === 1 ? "mainnet" : `chain ${info.chainId}`;
  const when = new Date(info.capturedAt);
  const stamp = Number.isNaN(when.getTime())
    ? info.capturedAt
    : when.toISOString().slice(0, 16).replace("T", " ") + "Z";
  const first = info.firstBlock.toLocaleString("en-US");
  const last = blockSuffix(info.firstBlock, info.lastBlock);
  const range = last ? `${first}–${last}` : first;
  const loop = pass > 1 ? ` · pass ${pass}` : "";
  return [`${chain} · ${stamp}`, `blocks ${range}${loop}`];
}

/**
 * The tail of `last` that differs from `first`, whole digit groups only:
 * 25,842,547 → 25,842,570 reads "25,842,547–570", and → 25,843,001 reads
 * "25,842,547–843,001". Empty when they are the same block; the whole number
 * when nothing shorter can be read back against the first.
 */
export function blockSuffix(first: number, last: number): string {
  if (first === last) return "";
  const a = String(first);
  const b = String(last);
  if (a.length !== b.length) return last.toLocaleString("en-US");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  const groups = Math.ceil((b.length - i) / 3);
  const take = groups * 3;
  if (take >= b.length) return last.toLocaleString("en-US");
  const tail = b.slice(b.length - take);
  return tail.replace(/(\d{3})(?=\d)/g, "$1,");
}

export function Instrument() {
  const [sample, setSample] = useState<VizSample | null>(null);
  const [inspected, setInspected] = useState<Inspected | null>(null);
  const [pinned, setPinned] = useState(false);
  const [source, setSource] = useState<SourceInfo | null>(null);
  const [progress, setProgress] = useState<SourceProgress | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [transport, setTransport] = useState<Transport | null>(null);
  /** The restart card, shown for a moment when the recording starts over. */
  const [restarting, setRestarting] = useState(false);
  /**
   * The recording is standing in for a lost live feed. Set once by the rule
   * in `shouldFallBack`, cleared only by the reader asking for live again;
   * either way the source changes by remounting `Viz`.
   */
  const [fallback, setFallback] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const pointerFeed = useMemo(() => createPointerFeed(), []);
  /**
   * Which run of the source this is. Bumped when the source ends, which
   * remounts `Viz` under a new key and starts everything from nothing — see
   * `VizProps.onEnd`. Also the pass number the panel shows for a recording.
   */
  const [pass, setPass] = useState(1);

  /**
   * A remount drops focus on the floor.
   *
   * "Try live again" is a button that removes itself; a recording that ends
   * remounts the canvas the reader may have been walking with the keyboard.
   * Either way `document.activeElement` becomes the body and the next Tab
   * starts from the top of the page. The canvas is the instrument, so focus
   * goes back to it — only when nothing else has it, so a reader mid-way
   * through the About text is not yanked back up.
   */
  useEffect(() => {
    if (pass === 1) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    document.querySelector<HTMLCanvasElement>("canvas")?.focus();
  }, [pass]);

  // The instrument's proportions for this screen, read off the sampled
  // width so the chrome and the canvas can never disagree about them.
  const g = geometryFor(sample?.viewWidth ?? NARROW_BELOW_PX, sample?.viewHeight ?? Number.POSITIVE_INFINITY);
  const narrow = g !== WIDE;
  const calibration = sample?.calibration;
  const calibrating = calibration?.active ?? false;
  const stale = (sample?.staleSeconds ?? 0) > STALE_AFTER_S;
  const noBlockYet = sample?.blockNumber == null;
  /**
   * Build-time literal, so the branch not taken is dropped from the bundle.
   * See docs/01-app/02-guides/environment-variables.lg.
   */
  const sourceName = fallback ? "replay" : activeSourceName();
  // Only a live ingest can say how much of the chain it sees; a recording or
  // a generator has no such figure, and the build folds the URL to null.
  const coverage = useFeedCoverage(ingestStateUrl(), !fallback && sample !== null);
  const txsSilent = (sample?.txsSilentSeconds ?? 0) > TXS_SILENT_AFTER_S;
  const status = streamStatusOf({
    failure,
    hasSample: sample !== null,
    sourceName,
    stale,
    link: sample?.link ?? null,
    calibrating,
  });

  /**
   * The chain the hashes belong to, for the explorer link. A recording says;
   * a live feed is mainnet by construction (see LIVE_CHAIN_ID); the synthetic
   * source has no chain at all, and its hashes must not link anywhere.
   */
  const chainId =
    source?.kind === "recording"
      ? source.chainId
      : sourceName === "sse"
        ? LIVE_CHAIN_ID
        : null;

  /** Everything from the run that ended, cleared before the next one. */
  const resetRun = () => {
    setSample(null);
    setInspected(null);
    setPinned(false);
    setTransport(null);
    setSource(null);
    setProgress(null);
  };

  /**
   * The live feed has been gone long enough: play the recording.
   *
   * Decided where the evidence arrives — the sample that carries the silence,
   * the failure that carries the reason — rather than in an effect watching
   * derived state, which is a render loop asked to behave like an event
   * handler. Acted on by remounting: the recording cannot be started into
   * the live run's state, for the same reasons a recording restarts from
   * nothing.
   */
  const fallBackTo = (failureNow: string | null, staleSeconds: number | null) => {
    if (
      !shouldFallBack({
        configured: fallbackConfigured(),
        fallback,
        failure: failureNow,
        staleSeconds,
      })
    ) {
      return false;
    }
    setFallback(true);
    setFailure(null);
    resetRun();
    setPass((n) => n + 1);
    return true;
  };

  /**
   * Everything computed from the last block stops being a statement about now
   * once that block is old enough. See BLOCK_STALE_AFTER_S.
   */
  const blockStale = sample ? !sample.blockReadingsCurrent : false;
  const ratio = sample?.ghostRatio;
  /** Trailing underscore: `window` is the global, and shadowing it here would
      be a trap for anyone who later reaches for it. */
  const window_ = sample?.ghostRatioWindow ?? null;

  /** "62%" when the transfer says how much is coming, "412 KB" when not. */
  const progressDetail =
    status === "loading" && progress
      ? progress.total
        ? `${Math.min(99, Math.round((100 * progress.loaded) / progress.total))}%`
        : `${Math.round(progress.loaded / 1024)} KB`
      : undefined;

  return (
    <section className="relative h-dvh w-full overflow-hidden">
      {restarting ? (
        <div
          key={pass}
          className="df-restart"
          role="status"
          onAnimationEnd={() => setRestarting(false)}
        >
          recording restarts · pass {pass}
        </div>
      ) : null}
      <Viz
        key={pass}
        className="absolute inset-0 z-0 h-full w-full"
        onSample={(next) => {
          if (fallBackTo(null, next.staleSeconds)) return;
          setSample(next);
        }}
        onInspect={(target, isPinned) => {
          setInspected(target);
          setPinned(isPinned);
        }}
        onPointer={pointerFeed.publish}
        onProgress={setProgress}
        onFailure={(reason) => {
          if (fallBackTo(reason, null)) return;
          setFailure(reason);
        }}
        onTransport={setTransport}
        onSource={setSource}
        fallback={fallback}
        onEnd={() => {
          // Nothing from the run that ended may stand on the panel while the
          // next one loads: a block number from the last pass over a chamber
          // that is empty again would be the last pass's claim, made now.
          resetRun();
          setRestarting(true);
          setPass((n) => n + 1);
        }}
      />

      {calibration ? (
        <CalibrationBar calibration={calibration} />
      ) : null}

      <div
        className={`pointer-events-none absolute inset-0 z-10 ${
          calibrating ? "df-calibrating" : ""
        }`}
        style={axisVarsFor(g)}
      >
        {inspected ? (
          <div
            className={`absolute ${pinned ? "pointer-events-auto" : "pointer-events-none"}`}
            style={
              narrow
                ? {
                    // A phone has no hover and no room beside a mark: the
                    // inspector is a sheet across the width, resting on the
                    // panel, where the thumb that tapped is not covering it.
                    left: 12,
                    right: 12,
                    bottom: `calc(${pct(g.PANEL_BAND)} + 12px)`,
                  }
                : {
                    left: inspected.screen.x,
                    top: inspected.screen.y,
                    // Flips left of the anchor near the right edge, and up near the
                    // panel, so the panel never leaves the viewport and never covers
                    // the mark it is describing.
                    transform: `translate(${
                      inspected.screen.x > 0.62 * (sample?.viewWidth ?? 1200)
                        ? "calc(-100% - 14px)"
                        : "14px"
                    }, ${
                      inspected.screen.y > 0.6 * (sample?.viewHeight ?? 800)
                        ? "calc(-100% - 10px)"
                        : "10px"
                    })`,
                  }
            }
          >
            <Inspector
              target={inspected}
              pinned={pinned}
              explorerUrl={explorerTxUrl(chainId, inspected.hash)}
              touch={narrow}
            />
          </div>
        ) : null}

        <ChamberCursor
          range={sample?.feeRange ?? null}
          profile={sample?.feeProfile ?? []}
          feed={pointerFeed}
          g={g}
        />

        {/* The fee scale. The canvas draws the ticks; these are the values.

            Right-aligned into the gutter between the frame's edge and the axis,
            so the numerals end on the axis they belong to and a two-character
            value lines up with a four-character one. */}
        {/* The unit, at the head of the scale.
            Fourteen numerals ran down this gutter with nothing to say what they
            were in. "gwei" appeared once on the whole page, in BASE FEE, six
            hundred pixels away and about a different quantity. */}
        {sample?.ticks.length ? (
          <span className="df-axis-unit absolute">gwei</span>
        ) : null}

        {/* The bounds. A mark on the top rule pays at least this; one on the
            foot pays at most that. Without them the two edge rows — where the
            marks the window cannot place are clamped — read as marks sitting
            on the frame for no reason. Real mainnet puts a great many on the
            foot: tips at or near zero, which is a real population and not a
            fault. */}
        {sample?.feeRange && sample.ticks.length ? (
          <>
            <span
              className="df-axis-label df-axis-bound absolute -translate-y-1/2"
              style={{ top: chamber(0, g) }}
            >
              {`≥ ${gweiBound(sample.feeRange.highGwei)}`}
            </span>
            {/* The floor carries its share. Two thirds of a mainnet pool sits
                on this bound, and a bound that only names its value presents
                the largest reading in the chamber as a pile. */}
            <span
              className="df-axis-label df-axis-bound absolute -translate-y-1/2"
              style={{ top: chamber(1 - FLOOR_BAND, g) }}
            >
              {`≤ ${gweiBound(sample.feeRange.lowGwei)}`}
            </span>
            {/* The band's share, on the band. It was appended to the bound in
                the gutter, where a four-word phrase wrapped into four lines
                beside the numerals. The gutter is for values; the band is
                wide, and the count belongs where the population is. */}
            {sample.floorShare != null && sample.floorShare >= 0.05 ? (
              <span
                className="df-band-note df-def absolute"
                style={{
                  left: `calc(${pct(g.CHAMBER_LEFT)} + 10px)`,
                  top: `calc(${chamber(1 - FLOOR_BAND, g)} + 5px)`,
                }}
                data-def="Pending transactions offering nothing above the base fee: not bidding to be included, waiting for the base fee to fall. In a five-minute recording of mainnet on 2026-08-26 that was two thirds of what was announced, and one in eight of those still landed."
                tabIndex={0}
              >
                {`${Math.round(sample.floorShare * 100)}% of the pool · at base fee`}
              </span>
            ) : null}
          </>
        ) : null}

        {/* Numerals thinned to the chamber's height, so two never touch on a
            short screen; every tick's rule is still drawn by the canvas. */}
        {sample?.ticks &&
          thinTicks(sample.ticks, sample.viewHeight * g.CHAMBER_EXTENT)
          .filter(
            (tick) =>
              !tickYieldsToUnit({
                viewWidth: sample.viewWidth,
                viewHeight: sample.viewHeight,
                tickHeight: tick.height,
              }),
          )
          .map((tick) => (
          <span
            key={tick.gwei}
            className="df-axis-label absolute -translate-y-1/2"
            style={{ top: chamber(tick.height, g) }}
          >
            {String(tick.gwei)}
          </span>
        ))}

        {/* The map.
            Three parallel stacks and a gap are not self-explanatory: the screen
            was being read as circles, a blank, and bars that swap. Each region
            says what one thing in it is and what its size means — and the block
            says what the warm colour is, because that is the only claim the
            whole apparatus makes.

            Copy is cut to fit the region it names. The block column is 16% of
            the width; a note wider than that spills left across the crossing
            and collides with the strip, which is exactly what the first
            attempt did. */}
        <div
          className="absolute flex -translate-y-full items-end justify-between gap-6"
          style={{
            // The frame's edge, not the axis: this names the whole region,
            // and the region's boundary is where the brackets are. Two edges
            // on the left of the instrument — frame and axis — with the
            // numerals in the gutter between them, and nothing else.
            left: pct(g.FRAME_LEFT),
            right: `${(1 - g.BLOCK_RIGHT) * 100}vw`,
            top: `calc(${pct(g.BLOCK_TOP)} - ${REGION_LABEL_LIFT}px)`,
          }}
        >
          <div className="df-region min-w-0 flex-1">
            <span className="df-region-name">Public mempool</span>
            <span className="df-region-note">
              {sample?.feeAxis
                ? `fee axis calibrating · ${sample.feeAxis.samples} / ${sample.feeAxis.required}`
                : "one dot = one waiting transaction"}
            </span>
            {/* The quantity the axis actually plots.
                It said "fee offered", which is offeredFee in lib/fees.ts — a
                different number from the effectivePriorityFee the height is
                computed from, and one that mostly would not fit on this axis.
                Measured against six live marks, the height tracked the priority
                fee every time: 1.081 against a priority of 1.082 and an offer
                of 30.531, and so on down. The offers ran 12 to 31 gwei while
                the axis spanned 0.098 to 12.448. */}
            <span className="df-region-note">height = priority fee</span>
            {/* The one thing that changes while a reader watches a single dot,
                and it was explained nowhere on the page.

                Not "brighter = newer", which was the first attempt and is half
                false: rule 2 puts fee on luminance and age on alpha, and over a
                dark ground in additive blending both arrive at the eye as
                brightness. A bright dot is expensive, or new, or both. What is
                unambiguously true, and what a reader actually watches happen,
                is that a dot dims the longer it waits. */}
            <span className="df-region-note">fades as it waits</span>
          </div>

          <div
            className="df-region df-region--end"
            style={{ width: `${g.BLOCK_WIDTH * 100}vw` }}
          >
            <span className="df-region-name">
              {sample?.blockNumber
                ? `Block ${sample.blockNumber.toLocaleString("en-US")}`
                : "Block"}
            </span>
            <span className="df-region-note">one row = one transaction</span>
            <span className="df-region-note df-region-key">
              never seen by this feed
            </span>
          </div>
        </div>

        {/* The crossing.
            The only region with nothing drawn in it, and the only one that had
            no name — while being where the single event the apparatus exists to
            show takes place. Centred on the gap the flight actually crosses,
            not tucked against the strip, and carrying its own count so the
            empty space becomes a reading rather than a blank. */}
        <div
          className="df-crossing absolute -translate-x-1/2 -translate-y-full"
          style={{
            left: pct((g.split + g.STRIP_RIGHT - g.STRIP_WIDTH) / 2),
            top: `calc(${pct(g.BLOCK_TOP)} - ${REGION_LABEL_LIFT}px)`,
          }}
        >
          <span className="df-crossing-rule" aria-hidden />
          {/* The region's name, which it lost when it gained its reading.
              Three regions were named in the identity register and this one
              was left carrying only a statistic — "129 of 150 crossed" with
              nothing saying crossed what, or where. */}
          <span className="df-region-name">In transit</span>
          {/* Blocks are twelve seconds apart and a crossing lasts about two
              and a half, so for most of the time this named region was empty.
              What belongs in it when nothing is moving is the count of what
              moved last time — which is the product's whole claim, stated at
              the place where it happens. Rule 1 holds: no split is quoted
              until the classifier has run. */}
          <span className="df-region-note">
            {sample?.inTransit
              ? `${sample.inTransit} crossing now`
              : sample?.blockTxCount != null && sample.ghostCount != null
                ? `last block · ${sample.blockTxCount - sample.ghostCount} of ${sample.blockTxCount} crossed`
                : "mempool → block"}
          </span>
        </div>

        {/* The strip is 3.5% of the width. It gets a name and nothing else;
            what it is, is said by standing next to the block. And no name at
            all before there is a block behind this one — a label over an empty
            column is a claim that something is there. */}
        {sample?.previousBlockNumber ? (
          <div
            className="df-region df-region--strip absolute -translate-x-1/2 -translate-y-full items-center"
            style={{
              left: pct(g.STRIP_RIGHT - g.STRIP_WIDTH / 2),
              // Bottom-anchored, on the same line as the other three.
              top: `calc(${pct(g.BLOCK_TOP)} - ${REGION_LABEL_LIFT}px)`,
            }}
          >
            {/* Stacked rather than set on one line: the strip is 3.5% of the
                width and a block number is wider than that, so a single line
                would either overflow into both gaps or be truncated. Naming the
                number is what makes the handover legible — a reader sees
                21,000,002 in the column and 21,000,001 here, and the strip stops
                being a decoration and becomes the block before this one. */}
            {/* Named in the same register as the other three. It was the only
                region whose name sat in the annotation tier, which made the
                narrowest column look like a caption rather than a region. */}
            <span className="df-region-name">Prev</span>
            <span className="df-region-note">
              {sample.previousBlockNumber.toLocaleString("en-US")}
            </span>
          </div>
        ) : null}

        {/* The panel. Three groups on one surface, divided by rules rather than
            by gaps: a gap says these are apart, a rule says these are different
            readings on one apparatus. */}
        {/* Below lg the four groups cannot share one row. The panel wraps:
            the primary meter first, at full width, because it is the reading
            the apparatus exists to produce; the plate under it as one row. The
            band's height becomes a minimum there rather than a size, so the
            meter is never clipped to fit a short phone — it may cover a slice
            of the chamber's foot instead, which is the lesser lie. */}
        <div
          className="df-panel absolute right-0 bottom-0 left-0 flex flex-wrap items-stretch lg:flex-nowrap"
          style={
            {
              "--panel-band": pct(g.PANEL_BAND),
              height: "var(--panel-band)",
            } as CSSProperties
          }
        >
          {/* Maker's plate. */}
          {/* Held narrow on purpose. Measured before: the maker's plate ran
              362px and the primary meter 320px, so the logo had more of the
              panel than the one number the apparatus exists to produce. */}
          {/* The plate, read top to bottom as an instrument's nameplate is:
              what it is, what state it is in, what you can do to it, and how
              to read it. The transport is only there for a source that can
              be driven; a live stream shows none, because none would be
              honest. */}
          <div className="df-panel-group df-plate order-last flex w-full flex-row flex-wrap items-center gap-x-5 gap-y-1 px-4 py-2 lg:order-none lg:w-64 lg:shrink-0 lg:flex-col lg:flex-nowrap lg:items-start lg:justify-start lg:gap-1.5 lg:px-6 lg:py-2">
            <Wordmark size={13} state="live" as="h1" />
            <div className="flex flex-col items-start gap-1">
              <StatusIndicator
                status={status}
                detail={
                  progressDetail ??
                  (fallback && status === "recorded"
                    ? "live feed lost"
                    : transport && transport.rate > 1 && calibrating
                      ? `×${transport.rate}`
                      : undefined)
                }
              />
              {/* The way back. The fallback is automatic; the return is not,
                  because a page that flips between a recording and a feed
                  on its own would be two instruments taking turns. */}
              {fallback ? (
                <button
                  type="button"
                  className="df-transport-btn pointer-events-auto"
                  onClick={() => {
                    setFallback(false);
                    setFailure(null);
                    resetRun();
                    setPass((n) => n + 1);
                  }}
                >
                  Try live again
                </button>
              ) : null}
              {source?.kind === "recording"
                ? recordingSummary(source, pass).map((line) => (
                    <span
                      key={line}
                      className="df-legend hidden opacity-55 lg:inline"
                    >
                      {line}
                    </span>
                  ))
                : calibration && !calibration.active
                  ? (
                    <span className="df-legend hidden opacity-55 lg:inline">
                      {calibrationSummary(calibration)}
                    </span>
                  )
                  : null}
            </div>
            {transport ? (
              <div className="df-transport pointer-events-auto" role="group" aria-label="Playback">
                <button
                  type="button"
                  className="df-transport-btn"
                  onClick={() => (transport.paused ? transport.resume() : transport.pause())}
                  aria-pressed={transport.paused}
                  title={transport.paused ? "Play (space)" : "Pause (space)"}
                >
                  {transport.paused ? "play" : "pause"}
                </button>
                <button
                  type="button"
                  className="df-transport-btn"
                  title="Jump to the next block (n)"
                  onClick={() => transport.nextBlock()}
                >
                  next
                </button>
                <button
                  type="button"
                  className="df-transport-btn"
                  title="Land this block again (r)"
                  onClick={() => transport.replayLanding()}
                >
                  again
                </button>
                <button
                  type="button"
                  className="df-transport-btn"
                  disabled={noBlockYet}
                  title="Copy a link to this block"
                  onClick={() => {
                    transport.copyLink().then((href) => {
                      setLinkCopied(href !== null);
                      window.setTimeout(() => setLinkCopied(false), 1800);
                    });
                  }}
                >
                  {linkCopied ? "copied" : "link"}
                </button>
              </div>
            ) : null}
            <div className="flex flex-col items-start gap-1">
              {/* The cue for the fold, and the one sentence a first-time
                  reader needs, because the percentage has no referent
                  without it. Kept off the bottom-left corner, where floating
                  dev widgets live. */}
              <a href="#about" className="df-about-link pointer-events-auto">
                What this measures ↓
              </a>
              {/* No gesture hint here any more. The cursor turns to a
                  crosshair over the chamber, the ring answers the pointer,
                  the inspector says "click to pin", and the transport
                  buttons carry their keys in their titles — the gestures
                  teach themselves, and the plate has 157px. */}
            </div>
          </div>

          {/* The primary meter. One reading, recessed into the panel, because
              the whole apparatus exists to produce this number — and given
              against a scale, because a value without one is a digit. */}
          {/* A definite width, not a content width. The well was capped at
              24rem but its group sized itself to the well's natural content, so
              the cap never bound and the group stayed at 320px — narrower than
              the four readings beside it and, before the plate was pinned, than
              the logo. */}
          {/* 24rem from lg, 26rem from 2xl. Measured at 1280px with the meter
              at 26rem: the secondary register's two columns were 99.5px each
              and "LAST BLOCK 152 tx" ran 34px into the 40px gap, touching the
              next legend. Two rem back and a narrower gap put every row inside
              its column, with the overflow a few pixels at most. */}
          <div className="df-panel-group order-first flex w-full items-center px-4 py-2 lg:order-none lg:w-[24rem] lg:flex-none lg:px-6 lg:py-4 2xl:w-[26rem]">
            <div className="df-well flex w-full flex-col gap-1 px-4 py-2 lg:max-w-[24rem] lg:px-5 lg:py-3">
              <span
                className="df-legend df-def"
                data-def="Share of the last block's transactions this feed never saw pending before they landed. An upper bound on private flow."
                tabIndex={0}
              >
                Never seen by this feed
              </span>
              <div className="flex items-baseline justify-between gap-3">
                <span
                  className="df-primary"
                  data-unknown={ratio == null}
                  data-stale={blockStale ? "true" : undefined}
                >
                  {ratio != null ? `${(ratio * 100).toFixed(1)}%` : "——"}
                </span>
                {/* What the band under the numeral is, or why there is none.
                    Dropped below lg: it is the widest thing in the meter and it
                    pushed the panel's minimum past a phone. The band itself
                    still draws, and its numbers are still in the scale's
                    aria-label, so nothing is lost that was only here. */}
                {/* (original note follows)
                    A band drawn from a handful of blocks is narrow, and a
                    narrow band reads as a stable figure rather than as thin
                    evidence — so below the threshold it is not drawn, and this
                    says so in the same n/N terms the calibration bar uses. */}
                {ratio != null ? (
                  <span className="df-legend df-phone-extra inline shrink-0 text-right leading-[1.5]">
                    {window_ ? (
                      <>
                        {`${(window_.low * 100).toFixed(1)}–${(window_.high * 100).toFixed(1)}%`}
                        <br />
                        <span className="opacity-60">{`Last ${window_.blocks} blocks`}</span>
                      </>
                    ) : (
                      <>
                        Range
                        <br />
                        <span className="text-calib">
                          {`${sample?.ratioSamples ?? 0} / ${MIN_RATIO_WINDOW_BLOCKS} blocks`}
                        </span>
                      </>
                    )}
                  </span>
                ) : null}
              </div>
              <PrimaryScale
                value={ratio ?? null}
                window={window_}
                samples={sample?.ratioSamples ?? 0}
              />
              <RatioHistory
                ratios={sample?.recentRatios ?? []}
                size={RATIO_WINDOW_BLOCKS}
              />
              {failure ? (
                <span className="df-legend df-failure">
                  {`Recording could not be loaded — ${failure}. `}
                  <button
                    type="button"
                    className="df-inspector-action pointer-events-auto"
                    onClick={() => window.location.reload()}
                  >
                    Reload
                  </button>
                </span>
              ) : (
                <span className="df-legend df-phone-extra opacity-70">
                  {blockStale && sample?.sinceBlockSeconds != null
                    ? `Not current · last block ${Math.round(sample.sinceBlockSeconds)}s ago`
                    : ratio != null && sample?.blockTxCount
                      ? `${sample.ghostCount} of ${sample.blockTxCount} tx · ` +
                        `${((sample.ghostGasRatio ?? 0) * 100).toFixed(1)}% of the gas`
                      : "Watching the pool before making the claim"}
                </span>
              )}
            </div>
          </div>

          {/* Secondary register. Two columns, because one across this width put
              half a screen between a legend and the number it names. */}
          {/* Below lg the panel band cannot hold four groups without either
              overflowing or crushing the reading the whole apparatus exists to
              produce. The secondary register is the first thing to go, because
              every figure in it is context for that reading rather than the
              reading itself. A proper small-screen treatment is separate work
              and has not been done here. */}
          {/* The secondary register. On a phone it is the second row of the
              stacked panel: two columns, four readings — the pool, the feed's
              coverage, the last block and the base fee. Height and the
              seconds since the block are hidden there: the block's number is
              already the column's name, and the panel has three rows to give. */}
          <div className="df-panel-group df-phone-extra grid w-full grid-cols-2 gap-x-6 gap-y-1 px-4 py-3 lg:w-auto lg:flex-1 lg:content-center lg:grid-cols-1 lg:gap-y-1.5 lg:px-6 lg:py-4 xl:grid-cols-2 xl:gap-x-6">
            <Reading
              legend="Pending"
              def="Transactions announced to this feed and not yet in a block. The real pool, not the sample drawn."
              unknown={!sample}
              value={(sample?.pending ?? 0).toLocaleString("en-US")}
            />
            {/* The window goes in the definition, not in a unit: "5 blk" beside the
                value wrapped under it at 1424, and the count is data the reader
                needs only when asking what the figure is. The legend is one
                word for the same reason: "FEED COVERAGE" ran 22px past a 113px
                column at 1280. */}
            <Reading
              legend="Coverage"
              def={`Feed coverage. Of the last ${coverage?.blocks ?? "few"} blocks' transactions, the share this feed had announced as pending before they landed — the feed measuring itself. The headline cannot tell private flow from a transaction the feed simply missed; this figure bounds that doubt.`}
              unknown={coverage === null || coverage.pct === null}
              value={`${Math.round(coverage?.pct ?? 0)}%`}
            />
            <div className="hidden lg:contents">
            <Reading
              legend="Height"
              def="Number of the block on the right."
              unknown={noBlockYet}
              stale={blockStale}
              value={sample?.blockNumber?.toLocaleString("en-US") ?? ""}
            />
            </div>
            <Reading
              legend="Last block"
              def="Transactions in the block on the right, one row each."
              unknown={noBlockYet}
              stale={blockStale}
              value={String(sample?.blockTxCount ?? 0)}
              unit="tx"
            />
            <div className="hidden lg:contents">
            <Reading
              legend="Since block"
              def="Seconds since that block landed. Elapsed, never a countdown."
              unknown={sample?.sinceBlockSeconds == null}
              stale={blockStale}
              value={sample?.sinceBlockSeconds?.toFixed(1) ?? ""}
              unit="s"
            />
            </div>
            <Reading
              legend="Base fee"
              def="The block's base fee per gas. A pending mark's height is what it offers above this."
              unknown={sample?.baseFeeGwei == null}
              stale={blockStale}
              value={sample?.baseFeeGwei?.toFixed(2) ?? ""}
              unit="gwei"
            />
            {/* The mempool feed's own silence. Only once it is silent: a
                permanent "0 s" would be a legend for nothing, and while
                blocks still land it is the one figure that says which half
                of the picture has stopped. */}
            {txsSilent && sample?.txsSilentSeconds != null ? (
              <Reading
                legend="Mempool feed"
                def="Seconds since the last batch of pending transactions. Blocks may still be landing; the field is not being fed."
                stale
                value={Math.round(sample.txsSilentSeconds).toString()}
                unit="s silent"
              />
            ) : null}
            {sample?.budgetReduced ? (
              <Reading
                legend="Render budget"
                def="Marks the field draws at most, cut by measured frame rate on this device. The pool is larger."
                value={String(sample.maxEntities)}
                unit="marks"
              />
            ) : null}
            {/* Only once it is non-zero. A reorg withdraws a reading the panel
                already showed as current, and a reader who saw the headline
                figure change under the same block number deserves the reason.
                Zero would be a permanent legend for an event that almost never
                happens. */}
            {sample?.reorgs ? (
              <Reading
                legend="Reorgs"
                def="Blocks the chain replaced since this page opened. Each withdrew a reading that was shown as current."
                value={String(sample.reorgs)}
              />
            ) : null}
            {/* Same rule. The seen-set forgetting live transactions is the one
                failure that manufactures private flow out of nothing, and it
                is invisible on the canvas: a forgotten transaction lands warm,
                exactly like a real one. So the count goes where the figure is
                read, the moment it is non-zero. */}
            {sample?.forgotten ? (
              <Reading
                legend="Forgotten"
                def="Pending transactions this page dropped from memory because it ran out of room before they aged out. Each may come back as a false never seen, so the headline figure carries this doubt."
                value={String(sample.forgotten)}
              />
            ) : null}
          </div>

          {/* The gas reference.
              Sized and placed to the block column exactly, so the bar is not a
              picture of the scale but the scale itself, continued below the
              thing it measures. A reference wider than the column it refers to
              is a reference to nothing. */}
          <div
            className="df-panel-group hidden flex-col justify-center gap-2 py-4 pl-5 xl:flex"
            style={{
              width: `calc(${pct(1 - g.FIELD_FADE_END)} + 24px)`,
              paddingRight: `${(1 - g.BLOCK_RIGHT) * 100}vw`,
            }}
          >
            <div
              className="ml-auto flex items-baseline justify-between gap-4"
              style={{ width: `${g.BLOCK_WIDTH * 100}vw` }}
            >
              <span className="df-legend">Row width</span>
              <span className="df-legend opacity-70">√ gas used</span>
            </div>
            <div
              className="df-reference ml-auto"
              style={{ width: `${g.BLOCK_WIDTH * 100}vw` }}
              aria-hidden
            />
            <span className="df-secondary text-right text-[11px]">
              {sample?.blockMaxGas != null ? (
                <>
                  {compactGas(sample.blockMaxGas)}
                  <span className="text-text-dim ml-1.5">
                    largest in this block
                  </span>
                </>
              ) : (
                <span className="text-calib">—</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default Instrument;
