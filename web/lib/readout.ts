import type { WorldState } from "@/lib/canvas/world";
import type { CalibrationState, SeenSet } from "@/lib/seen";
import {
  MIN_AXIS_SAMPLES,
  MIN_TIP_WEI,
  type FeeTick,
} from "@/lib/canvas/layout";
import type { LinkState } from "@/types/stream";

/**
 * Everything the chrome reports, read straight from the sources of truth.
 *
 * A pure function of the world, the seen-set and the clock, extracted from
 * `Viz` so it can be exercised without a DOM. Its whole job is to say what is
 * known and to refuse to say what is not — which is a rule you can only trust
 * if you can test it.
 *
 * `pending` comes from the seen-set, never from the entity count: the render
 * samples 300 of the pool, and reporting what was drawn would make the counter
 * a statement about the renderer instead of about the mempool.
 */
export type VizReadout = {
  calibration: CalibrationState;
  ticks: readonly FeeTick[];
  /**
   * The fee axis while it is still filling, or `null` once it is calibrated.
   *
   * Same n/N idiom as the calibration bar and the ratio band, and for the same
   * reason: until the rolling window has enough samples a height is not a fee,
   * so the field draws nothing and this says how far along it is. An empty
   * chamber with no explanation reads as a broken feed.
   */
  feeAxis: { samples: number; required: number } | null;
  /**
   * Fee at the top and bottom of the chamber, in gwei, once the axis means
   * something. Lets the chrome answer "what is this height worth" without
   * keeping its own copy of the mapping.
   */
  feeRange: { lowGwei: number; highGwei: number } | null;
  /**
   * How the pending pool is distributed down the chamber, coarsely.
   *
   * One count per band from the top. The field draws a sample of the pool, so
   * this counts the same sample — it describes the picture, which is what a
   * cursor over the picture should report.
   */
  feeProfile: readonly number[];
  /**
   * Transactions between the mempool and the block at this instant.
   *
   * The crossing is the only region of the screen with no data drawn in it and
   * no name, and it is where the one event this product exists to show takes
   * place. Counting what is in it turns an empty gap into a reading.
   */
  inTransit: number;
  /** The real pool, not the drawn sample. */
  pending: number;
  blockNumber: number | null;
  /**
   * Whether the block-derived readings describe the current chain head.
   *
   * When false, everything computed from `world.lastBlock` — the ghost ratio,
   * the height, the transaction count, the base fee — is a true reading of a
   * block that is no longer current, and the chrome says so rather than
   * presenting it as now. See `BLOCK_STALE_AFTER_S`.
   */
  blockReadingsCurrent: boolean;
  /**
   * The block in the compressed strip, or `null` before there is one.
   *
   * Named so the strip reads as one specific block rather than as a category.
   * It is history, not the start of a series — the question of whether this
   * block is unusual belongs to `ghostRatioWindow`, which has a threshold.
   */
  previousBlockNumber: number | null;
  blockTxCount: number | null;
  baseFeeGwei: number | null;
  /** `null` while calibrating: not zero, because zero would be an assertion. */
  ghostCount: number | null;
  ghostRatio: number | null;
  /**
   * The same claim weighted by gas rather than by transaction count.
   *
   * Reported alongside the count because the block picture sizes each row by
   * gas, so the area a reader sees is this number, not the other one. A panel
   * showing only the count while the image showed the weight would be a meter
   * disagreeing with its own instrument.
   */
  ghostGasRatio: number | null;
  /**
   * The spread of this claim over the recent past, and `null` until there is
   * one to report.
   *
   * A bare percentage is a digit, not a reading. "24.0%" answers nothing on its
   * own — the question anyone actually has is whether 24 is a lot, and no
   * amount of typographic weight on the number answers it. An instrument gives
   * a value against a scale, so this is the scale: what the same measurement
   * has been over the last several blocks.
   *
   * Two blocks minimum. A range built from one reading is that reading twice.
   */
  ghostRatioWindow: { low: number; high: number; blocks: number } | null;
  /**
   * Classified blocks behind the window, whether or not there are enough of
   * them to draw. Reported separately so the panel can say how far along it is
   * rather than leaving the band's absence to be read as "no variation".
   */
  ratioSamples: number;
  /**
   * Canonical blocks the chain has replaced since the stream opened.
   *
   * Each one withdrew a reading the panel had already shown as current. Zero
   * almost always, and shown only when it is not — a reader who sees the
   * headline figure change without a new block number deserves to know why.
   */
  reorgs: number;
  /**
   * Pending transactions this page has dropped from memory because the
   * seen-set hit its size cap before they aged out.
   *
   * Each one can come back as a false "never seen" when it is included, so
   * a non-zero value is doubt on the headline figure and is shown as such.
   * Zero on any rate the TTL can hold; `seen.ts` says why the cap exists.
   */
  forgotten: number;
  /**
   * The ratios behind the range, oldest first — the same window, as a
   * sequence. The band says how wide the last twenty blocks ran; this says
   * in what order, which is the difference between "41% is a peak" and "41%
   * is where it has been".
   */
  recentRatios: readonly number[];
  /**
   * Gas used by the largest transaction in the block on screen.
   *
   * Row width is normalised over this, so it is the one number that makes the
   * horizontal axis readable: without it a wide row means "wider than the
   * others here" and nothing more. Reported so the panel can label the scale
   * rather than leave the reader to infer a unit.
   */
  blockMaxGas: number | null;
  /**
   * Seconds since the last block landed, or `null` before the first one.
   *
   * Elapsed, never a countdown. A progress bar toward twelve seconds would
   * predict the next block, and block times are a target rather than a
   * promise. What is honest is how long it has been — and it is the only place
   * the apparatus carries time at all, on a subject whose whole rhythm is
   * twelve seconds long.
   */
  sinceBlockSeconds: number | null;
  /**
   * Seconds since the last event of any kind, or `null` when the stream is
   * intentionally paused.
   *
   * A backgrounded tab drops the subscription on purpose — there is no loop to
   * feed — so silence there means nothing. Reporting it as a dead stream told
   * anyone glancing back at a tab that the app had failed when it had simply
   * been waiting for them.
   */
  staleSeconds: number | null;
  /**
   * Seconds since the last transaction batch, or `null` while paused or
   * before the first. The mempool feed's own silence, apart from the block
   * feed's: a block every twelve seconds is ordinary and a pool quiet for
   * twelve is not, so one figure for both would let the block feed's normal
   * cadence hide the transaction feed dying.
   */
  txsSilentSeconds: number | null;
  /**
   * The share of the pending pool offering nothing above the base fee — at or
   * under the axis floor — or `null` before there is a pool to speak of.
   *
   * Not a small fee: no fee. On mainnet this was two thirds of everything
   * announced (65.8% of the recording), and it is not a dead queue either —
   * 12.2% of them were included within five minutes against 78.4% of the
   * rest. It is the flow waiting for the base fee to fall, and it deserves a
   * number rather than a heap of dots on the lowest rule.
   */
  floorShare: number | null;
  /** What the source says of its connection, or `null` for one without. */
  link: LinkState | null;
  /** Canvas size in CSS pixels, so the chrome can place things against it. */
  viewWidth: number;
  viewHeight: number;
  /** The render budget in force, and whether the governor cut it. */
  maxEntities: number;
  budgetReduced: boolean;
};

/**
 * How many blocks the ratio window holds. Four minutes at twelve seconds a
 * block — long enough for the spread to mean something, short enough that it
 * still describes now.
 */
export const RATIO_WINDOW_BLOCKS = 20;

/**
 * How many it must hold before the band is drawn at all.
 *
 * A range is a min and a max, and min/max from a short sample is a badly
 * biased estimator of the spread it appears to report. Measured against the
 * default generator over 600 blocks, whose true spread is 30.0 points:
 *
 *     n     mean observed range     recovers
 *     2            9.83 pt            32.8%
 *     3           14.70 pt            49.0%
 *     5           19.32 pt            64.4%
 *     8           22.53 pt            75.1%
 *    12           24.64 pt            82.1%
 *    20           26.63 pt            88.8%
 *    30           27.83 pt            92.8%
 *
 * At two samples the band draws a third of the real variability, and a narrow
 * band does not read as "little evidence" — it reads as "this figure is
 * stable", which is a claim about Ethereum that nobody measured. Unlike the
 * calibration gate this one does not correct itself in view: the band widens
 * so slowly that nothing announces the earlier picture was wrong.
 *
 * Twelve is where the estimator stops materially understating: 82% against 33%,
 * at a cost of 2.4 minutes. It is a threshold on how much authority the
 * geometry may claim, not on truthfulness — the band is always labelled with
 * the count it was actually built from, so it never claims twenty when it
 * holds twelve. The residual shortfall is real and stays: even a full window
 * shows about 89% of the spread, which is why the label says "last 20 blocks"
 * and not "the range".
 */
export const MIN_RATIO_WINDOW_BLOCKS = 12;

/**
 * Silence from the *block* stream past which its readings stop being current.
 *
 * Distinct from `STALE_AFTER_S`, which watches the stream. They are different
 * questions and they diverge: transactions can arrive every hundred
 * milliseconds — a perfectly live feed — while no block has landed for
 * minutes. In that state the primary percentage, the height, the transaction
 * count and the base fee are all describing a block from minutes ago, and
 * before this they were presented exactly as if they were current. Reachable
 * two ways: returning to a backgrounded tab, where the subscription is dropped
 * on purpose and the last block can be arbitrarily old; and an ingest that
 * keeps delivering `txs` while its block feed has failed.
 *
 * Three block intervals. One missed slot puts a block at 24 seconds old and
 * must not trip anything — missed slots are ordinary. Two consecutive is
 * already unusual, and by then the figure on screen genuinely describes the
 * chain two blocks back. Twelve seconds would fire on every single miss, which
 * would teach a reader to ignore the marker.
 *
 * The reading is still shown. It was true when it arrived, and hiding it would
 * lose information — what it must not do is claim to be now.
 */
export const BLOCK_STALE_AFTER_S = 36;

export type ReadoutInputs = {
  world: WorldState;
  seen: SeenSet;
  ticks: readonly FeeTick[];
  /** ms since epoch when the last block landed, or `null` before the first. */
  lastBlockAt: number | null;
  /** Samples behind the fee axis. */
  axisSamples: number;
  /** Wei at the top and bottom of the chamber, or `null` while uncalibrated. */
  axisBounds: { low: number; high: number } | null;
  /** ms since epoch of the last event of any kind. */
  lastEventAt: number;
  /** ms since epoch of the last transaction batch, or `null` before one. */
  lastTxAt?: number | null;
  /** The source's link state, or `null` for a source that has no link. */
  link?: LinkState | null;
  /** False when the stream is intentionally paused, e.g. a hidden tab. */
  subscribed: boolean;
  budgetReduced: boolean;
  /**
   * Ghost ratios from recent blocks, oldest first, classified ones only.
   *
   * Held by the caller rather than derived here: a readout is taken several
   * times a second and a block lands every twelve, so accumulating inside this
   * function would count the same block dozens of times.
   */
  recentRatios: readonly number[];
  /** Replacements the block ledger has accepted. See `lib/blocks.ts`. */
  reorgs?: number;
  /** Canvas size in CSS pixels. */
  view: { width: number; height: number };
  /** ms since epoch. Passed in, never read, so the result is reproducible. */
  now: number;
};

/** Bands down the chamber, for the cursor's count. Coarse on purpose. */
export const FEE_PROFILE_BANDS = 40;

function profileOf(world: WorldState): number[] {
  const bands = new Array<number>(FEE_PROFILE_BANDS).fill(0);
  for (const entity of world.entities) {
    if (entity.phase !== "pending") continue;
    const band = Math.min(
      FEE_PROFILE_BANDS - 1,
      Math.max(0, Math.floor(entity.y * FEE_PROFILE_BANDS)),
    );
    bands[band] += 1;
  }
  return bands;
}

export function readout(inputs: ReadoutInputs): VizReadout {
  const { world, seen, now } = inputs;
  const block = world.lastBlock;
  const calibration = seen.calibration();

  /**
   * Whether the block on screen was classified at all.
   *
   * Calibration closing is not enough. The warm-up closes on the block that
   * reaches the count, and that block was classified *before* it counted — its
   * unrecognised transactions are `unknown`, not `ghost`. Reading the ghost
   * count off it once warm therefore finds none and reports 0.0%, which stands
   * on the panel for the whole twelve seconds until the next block lands.
   *
   * Measured in `tests/calibration.test.ts`: an honest "not yet" became a
   * confident "0.0% never seen by this node" — the single most damaging
   * sentence this instrument could print, since it is the claim the whole
   * apparatus exists to make, made backwards.
   *
   * `unknown` is the evidence and it costs nothing to read: it means exactly
   * "this hash was not classified", so a block containing one is a block whose
   * ratio does not exist.
   */
  const classified = !world.block.some((mark) => mark.origin === "unknown");

  // Rule 1, in the one place a number could break it: while there is no claim
  // to make, the ghost set is not computed at all. `null` propagates from here
  // into every derived figure, so no arithmetic can turn "not known" into a
  // zero.
  const ghostMarks =
    calibration.active || !classified
      ? null
      : world.block.filter((mark) => mark.origin === "ghost");
  const ghosts = ghostMarks?.length ?? null;
  const gasAll = world.block.reduce((sum, mark) => sum + mark.gas, 0);
  const gasGhost = ghostMarks?.reduce((sum, mark) => sum + mark.gas, 0) ?? 0;

  return {
    calibration,
    ticks: inputs.ticks,
    feeAxis:
      inputs.axisSamples >= MIN_AXIS_SAMPLES
        ? null
        : { samples: inputs.axisSamples, required: MIN_AXIS_SAMPLES },
    feeRange: inputs.axisBounds
      ? {
          lowGwei: inputs.axisBounds.low / 1e9,
          highGwei: inputs.axisBounds.high / 1e9,
        }
      : null,
    feeProfile: profileOf(world),
    inTransit: world.block.filter(
      (mark) => mark.phase === "flying" && mark.flightProgress > 0,
    ).length,
    pending: seen.pending(),
    blockReadingsCurrent:
      inputs.lastBlockAt === null ||
      (now - inputs.lastBlockAt) / 1000 <= BLOCK_STALE_AFTER_S,
    blockNumber: block?.number ?? null,
    previousBlockNumber: world.previousBlockNumber,
    blockTxCount: world.block.length || null,
    baseFeeGwei: block ? block.baseFeePerGas / 1e9 : null,
    // null, not zero. Zero is a claim, and during calibration there is no
    // claim to make.
    ghostCount: ghosts,
    ghostRatio:
      ghosts !== null && world.block.length > 0
        ? ghosts / world.block.length
        : null,
    ghostGasRatio: ghostMarks !== null && gasAll > 0 ? gasGhost / gasAll : null,
    blockMaxGas: world.block.length > 0 ? world.blockMaxGas : null,
    ratioSamples: inputs.recentRatios.length,
    reorgs: inputs.reorgs ?? 0,
    forgotten: seen.capacityEvictions(),
    recentRatios: inputs.recentRatios,
    ghostRatioWindow:
      inputs.recentRatios.length >= MIN_RATIO_WINDOW_BLOCKS
        ? {
            low: Math.min(...inputs.recentRatios),
            high: Math.max(...inputs.recentRatios),
            blocks: inputs.recentRatios.length,
          }
        : null,
    sinceBlockSeconds:
      inputs.lastBlockAt === null ? null : (now - inputs.lastBlockAt) / 1000,
    staleSeconds: inputs.subscribed ? (now - inputs.lastEventAt) / 1000 : null,
    floorShare:
      seen.pending() > 0
        ? seen.pendingAtOrBelow(MIN_TIP_WEI, world.baseFeePerGas) / seen.pending()
        : null,
    txsSilentSeconds:
      inputs.subscribed && inputs.lastTxAt != null
        ? (now - inputs.lastTxAt) / 1000
        : null,
    link: inputs.link ?? null,
    viewWidth: inputs.view.width,
    viewHeight: inputs.view.height,
    maxEntities: world.maxEntities,
    budgetReduced: inputs.budgetReduced,
  };
}
