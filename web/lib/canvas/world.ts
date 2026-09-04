import type { BlockEvent, Fees, Hex, PendingTx } from "@/types/stream";
import { effectivePriorityFee } from "@/lib/fees";
import { FLOOR_BAND, atFloor } from "@/lib/canvas/layout";

/**
 * The simulation. Pure, deterministic, and completely unaware of canvas,
 * `requestAnimationFrame` and the wall clock.
 *
 * Every function here takes the current time as an argument rather than reading
 * it. That is what makes the whole thing testable: `step(state, 8000, t)`
 * advances eight seconds instantly and must produce exactly what eight seconds
 * of real frames would have. It is also what makes the animation independent of
 * framerate, which the brief required anyway — the two turn out to be the same
 * property.
 *
 * `lib/canvas/engine.ts` is the only thing that supplies a real clock.
 */

/** Hard cap on drawn entities. Not the seen-set — see `lib/seen.ts`. */
export const DEFAULT_MAX_ENTITIES = 300;

export type EntityPhase = "pending" | "flying" | "settled";

/**
 * Which half of the pool an entity holds a slot in.
 *
 * The pool is split because a single policy cannot serve both jobs at once.
 * Evicting purely by fee — which is what the brief originally called for — was
 * measured against a log-normal mempool and returned only percentiles 0.54 to
 * 0.999: the cheapest half of the pool never appears, and with fee on the
 * vertical axis that leaves 53% of the screen permanently empty while implying
 * the mempool has no cheap transactions.
 *
 * · `sample` — a uniform random draw from arrivals, so the *shape* of the fee
 *   distribution survives. The crowd at the median is crowded because there
 *   really are more transactions there, not because anything arranged it.
 * · `top` — a reserved quota for the highest fees, because a uniform sample
 *   would drop the rare expensive outliers, and those are the ones worth
 *   seeing.
 *
 * The quota over-represents the expensive end by construction, so it is kept
 * as small as it can be while still guaranteeing the outliers. See
 * `DEFAULT_TOP_QUOTA` for the measurement that set the number.
 *
 * The bias stops here. Selection is where it is introduced and where it is
 * documented; nothing downstream compensates for it. A transaction in the top
 * quota is more likely to be included in a block than a sampled one — that is
 * a fact about the market, and the visualiser's job is to show it, not to
 * correct for it in the render.
 */
export type EntitySlot = "sample" | "top";

/**
 * What is known about where this transaction came from.
 *
 * `ghost` is the product. Everything else exists so that this one distinction
 * is legible without a label.
 *
 * `unknown` is the epistemically honest third case, and it is not a nicety.
 * During warm-up the app has not been listening long enough to tell private
 * flow from a transaction that was already in the pool before it connected.
 * Calling those `ghost` would be the largest lie this application is capable
 * of telling, so they get their own state and are drawn as ordinary settled
 * rows: present in the block, no claim made about them.
 */
export type Origin = "seen" | "ghost" | "unknown";

export type Entity = {
  hash: Hex;
  /**
   * The fee shape as it came off the wire, so the effective tip can be
   * recomputed against whatever the base fee is now. Kept rather than
   * flattened: the base fee moves every block, and a tip resolved at spawn
   * would be stale within twelve seconds.
   */
  fees: Fees;
  /** ms since epoch, from the stream. Drives age, and therefore alpha. */
  firstSeen: number;
  phase: EntityPhase;
  slot: EntitySlot;
  origin: Origin;
  /** Position in the block, once it has one. -1 while pending. */
  slotIndex: number;
  /** Gas limit while pending; gas consumed once in a block. 0 if unknown. */
  gas: number;
  /** `elapsedMs` when the current phase began. Drives flight and appearance. */
  phaseStartMs: number;
  /** Field position, normalised 0..1 within the mempool zone. */
  x: number;
  y: number;
  /** Where the flight started, captured when the block landed. */
  fromX: number;
  fromY: number;
  /** Eased 0..1 across the flight. 1 once settled, 0 while pending. */
  flightProgress: number;
  /**
   * Whether this mark entered the picture already crossing.
   *
   * Three things can be in a block, not two. A transaction we had sampled into
   * the field really was at a spot on screen and flies from it. One that was
   * never in the mempool appears at its slot with no trajectory, which is the
   * claim this whole apparatus exists to make. Between them sits a third: a
   * transaction we *knew about* — its hash and its fee are in `seen` — that the
   * field never drew, because the field draws three hundred marks of a mempool
   * with tens of thousands in it.
   *
   * Measured over three consecutive blocks on the running app: 34, 59 and 47
   * arrivals had really been on screen, 48, 21 and 53 were private flow, and
   * 68, 70 and 50 were this third kind — more of them than the honest case.
   * Each was being spawned at a position derived from its fee and flown from
   * there, so every block materialised roughly sixty marks out of nothing
   * inside the measured volume and immediately sent them right. Blocks include
   * the highest fees, so the invented positions clustered in the top four
   * deciles of the chamber, which is what was reported: transactions spawning
   * from nothing at the top and then leaving.
   *
   * It has to fly — not flying is private flow's signal, and blurring the two
   * would cost the product its only claim. But it cannot occupy a position in
   * the chamber, because it never had one. So it enters at the chamber's right
   * edge, where the field dissolves into the crossing, and fades up as it goes:
   * public, on its way, never claimed to have been anywhere in particular.
   */
  enteredInFlight: boolean;
  /** Anchor the drift oscillates around. */
  homeX: number;
  homeY: number;
  /** Per-entity phase offsets, so the field does not breathe in unison. */
  driftSeedA: number;
  driftSeedB: number;
  /**
   * Age at which this entity is culled, randomised per entity.
   *
   * A single shared threshold makes the pool oscillate in lockstep: it fills in
   * one burst, sits unchanged for the whole threshold, culls as one cohort and
   * refills as one cohort. Measured, that produced 300 entities whose ages
   * spanned 15.2s to 15.7s — a field that pulses as a block rather than
   * flowing, with every mark at the same alpha. Spreading the threshold
   * spreads the departures, which spreads the admissions, which is what makes
   * the age distribution — and therefore the alpha distribution — continuous.
   */
  cullAtMs: number;
};

export type WorldState = {
  /** The pending field. Capped, sampled, drifting. */
  entities: Entity[];
  /**
   * The block that just landed: flying, then settled. Kept apart from the
   * field because the two are bounded by different things — the field by a
   * sampling budget, the block by how many transactions a block holds.
   */
  block: Entity[];
  /** The block before it, drawn compressed. Only one is kept. */
  previousBlock: Entity[];
  previousBlockNumber: number | null;
  /** Largest gas used in the current block, for normalising row width. */
  blockMaxGas: number;
  previousBlockMaxGas: number;
  /** Flight and appearance durations, read from the motion tokens. */
  landBlockMs: number;
  ghostAppearMs: number;
  /** Eased progress 0..1 for the flight. Injected from `--land-ease`. */
  landEase: (progress: number) => number;
  /** Arrivals not yet turned into entities. `onTx` writes here and nothing else. */
  inbox: PendingTx[];
  /** Accumulated simulation time in ms. The only clock the drift knows about. */
  elapsedMs: number;
  /** Most recent block, once one has landed. */
  lastBlock: BlockEvent | null;
  baseFeePerGas: number;
  maxEntities: number;
  /** τ for the alpha decay. Also decides when a trace is dead enough to cull. */
  decayTauMs: number;
  /**
   * No drift, no flight, no flash. The block still lands and everything still
   * arrives at its slot — reduced motion means removing motion, not removing
   * the event.
   */
  reducedMotion: boolean;
  /** Slots reserved for the highest fees. The rest is the uniform sample. */
  topQuota: number;
  /** Arrivals the uniform sample had no room for. Not a fee judgement. */
  notSampled: number;
  /**
   * Fractional intake carried between frames.
   *
   * At sixty frames a second the per-frame allowance is under one mark, so
   * flooring it every frame would admit nobody and the chamber would never
   * fill. The remainder is carried.
   */
  intakeCredit: number;
  /**
   * The same, for the reserved top quota, which meters separately.
   *
   * Two meters rather than one shared budget, each sized to its own half of the
   * pool. A single budget spent top-first refilled all fifteen quota slots in
   * 208ms after every block, and the quota lands in the sparsest part of the
   * chamber, so that run was the most visible thing on screen. See
   * `drainInbox`.
   */
  topCredit: number;
  /**
   * When the live block last handed over to the strip, on the elapsed clock.
   *
   * The handover used to be instantaneous: the column a reader had been
   * watching for twelve seconds was replaced by a narrow strip somewhere else,
   * and nothing on screen said the strip was the same block. It is the same
   * block, so it travels.
   */
  handoverStartMs: number;
  /** Entities pushed out of the reserved top quota by a better-paying arrival. */
  evictedFromTop: number;
  /** Count of entities culled because their trace had fully decayed. */
  culledByAge: number;
  /**
   * Vertical home from a tip, 0 at the top. Injected by the engine because it
   * depends on the rolling fee window, which the simulation has no business
   * owning. Defaults to mid-field so the world is usable before a window
   * exists.
   */
  heightFor: (tip: number) => number;
  /**
   * Whether `heightFor` currently answers with a fee or with a placeholder.
   *
   * While false the field takes no arrivals at all. Spawning at a height the
   * axis cannot justify and then gliding to the real one is the crossing this
   * flag exists to prevent: for the ~900ms of the migration every mark on
   * screen would be displaying a fee it does not have, and at startup that is
   * the whole population at once.
   */
  axisCalibrated: boolean;
};

export type WorldConfig = {
  maxEntities?: number;
  reducedMotion?: boolean;
  topQuota?: number;
  decayTauMs?: number;
  landBlockMs?: number;
  ghostAppearMs?: number;
  landEase?: (progress: number) => number;
};

/**
 * Reserved slots for the expensive tail, out of `DEFAULT_MAX_ENTITIES`.
 *
 * Set by measurement, not by taste. Swept over a 90-second synthetic run with
 * real turnover (~590 age culls, median on-screen age 16s), scoring each quota
 * by how far the displayed fee quartiles drift from a uniform sample:
 *
 *   quota   p50    bias     band    IQR
 *      40  0.542  0.0544   94.2%   32.5%
 *      20  0.515  0.0263   94.1%   28.7%
 *      15  0.495  0.0136   93.8%   28.7%
 *      10  0.483  0.0090   93.9%   27.0%
 *       0  0.483  0.0119   93.7%   26.0%
 *
 * 40 cost four times the bias of 15 and bought nothing: the occupied band is
 * flat across the whole sweep, so the distribution's shape never depended on
 * the quota. 15 sits at the sampling noise floor (quota 0 scores 0.0119, so
 * 0.0136 is indistinguishable from unbiased) while still guaranteeing that the
 * fifteen most expensive transactions on screen are never dropped.
 */
export const DEFAULT_TOP_QUOTA = 15;

/**
 * How long a trace lives, as a multiple of τ.
 *
 * The number came from the old decay: ln(100)·τ is where a multiplicative
 * `e^(-age/τ)` takes alpha under 1%, so a trace was culled at about the moment
 * it stopped contributing. That reasoning no longer holds — the emissive pass
 * now decays each mark from its own luminance down to the perceptible floor
 * over exactly this span, so a trace is visible for its whole life and reaches
 * the floor at the instant it is removed.
 *
 * The value is kept because the *duration* it produces is right, and because it
 * is now what the decay is scaled against: change this and traces fade faster
 * or slower, which is the only thing it still means.
 */
/**
 * How fast the drawn sample may take on new marks.
 *
 * A block removes every field mark it included, and the next frame refilled
 * every freed slot at once. Measured: a block took 28 marks out of the field,
 * the pool dropped from 300 to 258, and one 16ms frame put 42 back — all of
 * them age zero, which is maximum brightness. Fifteen of those went to the top
 * quota, which is the highest offered fees, so the burst landed where the block
 * had just emptied. Every twelve seconds the top of the chamber flashed.
 *
 * Nothing about that was in the data. Transactions arrive continuously; the
 * pool is a rendering budget, and refilling it in one frame is a property of
 * the drain policy, not of the mempool. The reported pending count is taken
 * from the seen-set and is untouched by this.
 *
 * Sixty a second spreads a 42-mark refill over about seven tenths of a second —
 * roughly one mark per frame, which is the definition of not-a-pop — while
 * still filling an empty chamber in five seconds. Steady-state intake is the
 * cull rate, 300 marks over a mean life of 25.8s, about 12 a second, so this
 * never binds during ordinary running.
 */
const INTAKE_PER_SECOND = 60;

/**
 * Accrues an allowance and caps what can be carried.
 *
 * The cap is the point. Without it, a meter with nothing to admit banks credit
 * for the whole twelve seconds between blocks and spends all of it the moment
 * slots free — measured at 41 marks in a single 16ms frame, which is what the
 * meter existed to prevent. Two steps' worth is enough that a fraction carries
 * between 60Hz frames, which is what keeps the rate honest at small deltas,
 * and not enough to bank an idle period.
 */
function meter(credit: number, perSecond: number, deltaMs: number): number {
  const allowance = (perSecond * deltaMs) / 1000;
  return Math.min(credit + allowance, Math.max(2, allowance * 2));
}

const CULL_AFTER_TAU = Math.log(100);

/**
 * Spread of the per-entity cull age, as a fraction of `CULL_AFTER_TAU`.
 *
 * The floor is high enough that anything culled early is already faint —
 * at 0.4·ln(100)·τ the exponential has taken alpha to about 0.23, and through
 * the single-mark ceiling that is under 9% — so a removal is never a pop.
 */
const CULL_SPREAD_MIN = 0.4;

/** Same generator as the synthetic source: small, fast, seedable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createWorld(config: WorldConfig = {}): WorldState {
  return {
    entities: [],
    block: [],
    previousBlock: [],
    previousBlockNumber: null,
    blockMaxGas: 0,
    previousBlockMaxGas: 0,
    landBlockMs: config.landBlockMs ?? 420,
    ghostAppearMs: config.ghostAppearMs ?? 180,
    landEase: config.landEase ?? ((p) => p),
    inbox: [],
    elapsedMs: 0,
    lastBlock: null,
    baseFeePerGas: 0,
    maxEntities: config.maxEntities ?? DEFAULT_MAX_ENTITIES,
    decayTauMs: config.decayTauMs ?? 8000,
    reducedMotion: config.reducedMotion ?? false,
    topQuota: config.topQuota ?? DEFAULT_TOP_QUOTA,
    notSampled: 0,
    intakeCredit: 0,
    topCredit: 0,
    handoverStartMs: Number.NEGATIVE_INFINITY,
    evictedFromTop: 0,
    culledByAge: 0,
    heightFor: () => 0.5,
    // Defaults true so a caller that never injects an axis — every unit test
    // that supplies its own `heightFor` — behaves as it always did.
    axisCalibrated: true,
  };
}

/** Effective tip for an entity at the current base fee. */
export function tipOf(state: WorldState, entity: Entity): number {
  return effectivePriorityFee(entity.fees, state.baseFeePerGas);
}

/**
 * Where arrivals go. Deliberately does no work beyond appending: the stream
 * callback fires in bursts of dozens and must never touch layout or paint.
 * `step` drains this.
 */
export function enqueue(state: WorldState, txs: readonly PendingTx[]): void {
  for (const tx of txs) state.inbox.push(tx);
  // The inbox is drained every step once the axis is calibrated, so it only
  // accumulates during the sub-second cold start. Bounded anyway, oldest
  // first, so a stream that somehow never calibrates cannot grow it forever.
  const cap = state.maxEntities * 8;
  if (state.inbox.length > cap) {
    state.inbox.splice(0, state.inbox.length - cap);
  }
}

/**
 * One transaction in an arriving block, already classified by the caller.
 *
 * The world does not own the seen-set and must not: classification is a data
 * question, placement is a rendering one. The caller resolves each hash and
 * hands over the answer.
 */
export type BlockArrival = {
  hash: Hex;
  /** Position in the block. 0 is the top. */
  index: number;
  origin: Origin;
  /** Present for `seen` arrivals — what the mempool knew about it. */
  record?: { firstSeen: number; fees: Fees; gas: number };
  /**
   * Gas this transaction consumed, read from the block.
   *
   * Comes from `BlockEvent.gasUsed`, not from the pending record, because a
   * ghost has no pending record and defaulting its width would encode "not
   * known" as "small".
   */
  gasUsed: number;
  /**
   * What the block says this transaction paid, as a fee shape whose
   * effective tip is the receipt's. Present when the ingest sent
   * `BlockEvent.tips`. It is what places a ghost at a height that means
   * something; without it a ghost sits at the floor, which encodes "bid
   * unknown" as "bid nothing".
   */
  paid?: Fees;
};

/**
 * A block lands.
 *
 * Seen transactions fly from where they were in the field to their slot in the
 * block over `--land-block`. Ghosts do not fly, because they were never
 * anywhere: they appear at their slot over `--ghost-appear` with a flash. The
 * difference in motion is the entire message, and there are no labels to fall
 * back on if it is wrong.
 *
 * A seen transaction usually has no mark in the field — the pool samples 300 of
 * tens of thousands — so one is created from its seen-set record at its correct
 * height and age. Its x is invented, but x has never meant anything here.
 */
export type ApplyBlockOptions = {
  /**
   * The block on screen was withdrawn by the chain and this one stands at its
   * height. It is discarded rather than demoted to the strip: the strip is
   * canonical history, and an orphaned block is not history, it is a block
   * that did not happen. `previousBlock` keeps the block before it, and the
   * strip's number stays what it was. See `lib/blocks.ts`.
   */
  replacing?: boolean;
};

export function applyBlock(
  state: WorldState,
  block: BlockEvent,
  arrivals: readonly BlockArrival[],
  rand: () => number,
  options: ApplyBlockOptions = {},
): void {
  state.baseFeePerGas = block.baseFeePerGas;

  if (!options.replacing) {
    // The block before last is gone. Only one compressed strip is kept: past
    // blocks are history, and history piling up on screen is just litter.
    if (state.block.length > 0) {
      state.previousBlock = state.block;
      state.previousBlockMaxGas = state.blockMaxGas;
      // It leaves from where it was. See BLOCK_HANDOVER_MS in draw.ts.
      state.handoverStartMs = state.elapsedMs;
    }
    state.previousBlockNumber = state.lastBlock?.number ?? null;
  }
  state.blockMaxGas = arrivals.reduce((max, a) => Math.max(max, a.gasUsed), 0);
  state.lastBlock = block;

  const pendingByHash = new Map<Hex, number>();
  for (let i = 0; i < state.entities.length; i++) {
    pendingByHash.set(state.entities[i].hash, i);
  }

  const marks: Entity[] = [];
  const takenFromField = new Set<number>();
  // Reduced motion means no journey and no sequence: the block is simply
  // there, which is the honest presentation of it when motion is unwanted.
  const stagger = (index: number) =>
    state.reducedMotion ? 0 : departureDelay(index, arrivals.length);

  for (const arrival of arrivals) {
    // `unknown` shares the ghost's path only in that it has nowhere to fly
    // from — we have no record of it. It is drawn as an ordinary settled row.
    if (arrival.origin === "ghost" || arrival.origin === "unknown") {
      marks.push(
        spawnBlockMark(state, arrival, rand, {
          // No trajectory. It starts where it ends — but not before its turn,
          // so private flow appears in the same sequence public flow lands in.
          // Watching a block assemble and seeing which rows flew and which
          // simply appeared is the entire claim, animated.
          startAtSlot: true,
          delayMs: stagger(arrival.index),
        }),
      );
      continue;
    }

    const fieldIndex = pendingByHash.get(arrival.hash);
    if (fieldIndex !== undefined) {
      // The honest case: it really was at that spot on screen.
      const entity = state.entities[fieldIndex];
      takenFromField.add(fieldIndex);
      entity.phase = "flying";
      entity.origin = "seen";
      entity.slotIndex = arrival.index;
      entity.gas = arrival.gasUsed;
      // Waits its turn where it is. Until then the renderer draws it exactly
      // as the field did, so nothing pops at the moment the block lands.
      entity.phaseStartMs = state.elapsedMs + stagger(arrival.index);
      entity.fromX = entity.x;
      entity.fromY = entity.y;
      marks.push(entity);
      continue;
    }

    marks.push(
      spawnBlockMark(state, arrival, rand, {
        startAtSlot: false,
        delayMs: stagger(arrival.index),
      }),
    );
  }

  // Remove the ones that left the field, back to front so indices hold.
  const leaving = [...takenFromField].sort((a, b) => b - a);
  for (const index of leaving) {
    state.entities[index] = state.entities[state.entities.length - 1];
    state.entities.pop();
  }

  state.block = marks;
}

function spawnBlockMark(
  state: WorldState,
  arrival: BlockArrival,
  rand: () => number,
  options: { startAtSlot: boolean; delayMs: number },
): Entity {
  const fees: Fees = arrival.record?.fees ?? arrival.paid ?? { kind: "legacy", gasPrice: 0 };
  /**
   * When this hash was first observed — which for private flow is the block.
   *
   * It used to be `Number.NaN`, on the reasoning that a transaction never
   * announced has no earlier sighting. True, and a trap: nothing read the field
   * for block marks, so a NaN sat in the data waiting for a reader, and a NaN
   * that reaches `ctx.globalAlpha` is *ignored* by the canvas rather than
   * failing. That exact path silently disabled alpha decay for months of
   * verification captures.
   *
   * The block timestamp is not a placeholder standing in for a missing value.
   * It is the answer: the ingest first saw this hash when the block revealed
   * it, and an age measured from there is the real age of our knowledge of it.
   */
  const firstSeen = arrival.record?.firstSeen ?? state.lastBlock?.timestamp ?? 0;
  const tip = effectivePriorityFee(fees, state.baseFeePerGas);
  const driftSeedA = rand() * Math.PI * 2;
  const homeY = homeYFor(state, tip, driftSeedA);
  /**
   * Private flow is placed like any settled row; it never travels, so its x is
   * unread. Anything else reaching here is public flow the field never drew,
   * and it starts at the chamber's right edge — 1 in chamber coordinates — not
   * at a position inside the volume it was never sampled into.
   */
  const enteredInFlight = !options.startAtSlot;
  const homeX = enteredInFlight ? 1 : inset(rand());

  return {
    hash: arrival.hash,
    fees,
    firstSeen,
    phase: options.startAtSlot ? "settled" : "flying",
    origin: arrival.origin,
    slot: "sample",
    slotIndex: arrival.index,
    gas: arrival.gasUsed,
    phaseStartMs: state.elapsedMs + options.delayMs,
    flightProgress: options.startAtSlot ? 1 : 0,
    enteredInFlight,
    x: homeX,
    y: homeY,
    fromX: homeX,
    fromY: homeY,
    homeX,
    homeY,
    driftSeedA,
    driftSeedB: rand() * Math.PI * 2,
    cullAtMs: Infinity,
  };
}

/**
 * Index of the cheapest entity holding a `top` slot, or -1 if there are none.
 *
 * Ranked by the priority fee, computed live, and that is the whole point.
 *
 * It used to rank by `offeredFee` — cached on the entity at spawn — while the
 * chamber positions every mark by `effectivePriorityFee`. Two different
 * quantities, both called "the fee", and the reservation therefore protected a
 * different set from the one the picture puts at the top. Measured on a live
 * pool of 300: the fifteen reserved marks were spread from the first decile of
 * the chamber to the eighth, only eight of them were among the fifteen highest
 * priority fees, and the highest priority fee in the whole pool — sitting at
 * the very top of the chamber, at y 0.04 — was not reserved at all.
 *
 * Computed rather than cached because the priority fee is a function of the
 * base fee, which changes with every block. A cached copy is a number that was
 * true once.
 */
function weakestTopIndex(state: WorldState): number {
  let index = -1;
  let lowest = Infinity;
  for (let i = 0; i < state.entities.length; i++) {
    const entity = state.entities[i];
    if (entity.slot !== "top") continue;
    const tip = tipOf(state, entity);
    if (tip < lowest) {
      lowest = tip;
      index = i;
    }
  }
  return index;
}

/**
 * Turns queued arrivals into entities.
 *
 * Two policies, one for each half of the pool. See `EntitySlot`.
 *
 * The turnover rate is not a constant anyone chose: age culling frees slots at
 * whatever pace the decay dictates, and the sample fills exactly those. Faster
 * traffic therefore means a smaller *fraction* sampled, not a faster flicker,
 * and an entity still lives long enough for its own decay to be legible.
 */
function drainInbox(
  state: WorldState,
  rand: () => number,
  deltaMs: number,
): void {
  // Rule: nothing is drawn at a position the axis cannot justify. Arrivals
  // wait in the inbox rather than being placed and corrected.
  if (!state.axisCalibrated) return;
  if (state.inbox.length === 0) return;

  const arrivals = state.inbox;
  state.inbox = [];
  // By the same quantity the chamber's vertical axis plots, so the half of the
  // pool that is reserved is the half the picture shows at the top.
  const tipOfTx = (tx: PendingTx) =>
    effectivePriorityFee(tx.fees, state.baseFeePerGas);
  arrivals.sort((a, b) => tipOfTx(b) - tipOfTx(a));

  const sampleQuota = state.maxEntities - state.topQuota;
  let topCount = 0;
  for (const entity of state.entities) if (entity.slot === "top") topCount += 1;
  let sampleCount = state.entities.length - topCount;

  /**
   * Each half refills at a rate proportional to its own size.
   *
   * Metered, so a block emptying the field does not refill it in one frame.
   * Measured on the running app before any meter existed: a block took 28 marks
   * out of the field, the pool fell from 300 to 258, and one 16ms frame put 42
   * back, all at age zero.
   *
   * Two meters rather than one, because a single budget spent top-first put the
   * whole burst in one place. The top quota holds the highest fees, which is
   * exactly the set a block includes, so a block empties it systematically and
   * priority order then refilled all fifteen slots before the sample got
   * anything — 208ms, measured. And the quota lands in the sparsest part of the
   * chamber: the axis is log-value, so measured population by decile from the
   * top of the chamber runs 30, 18, 81, 72, 64, 30, 5, and the top fifth holds
   * 48 marks against 214 in the three deciles below it. Fifteen marks turning
   * over together in a region that holds 48 is the most visible event on the
   * screen, and it is synchronised to the block.
   *
   * So the quota is refilled at its share of the pool — 15 of 300, a twentieth
   * of the intake — and the sample takes the rest. Fifteen slots then refill
   * over about five seconds instead of a quarter of one.
   *
   * What this gives up, said plainly: the quota stops being an absolute
   * guarantee that the highest known fees are on screen, and becomes a
   * rate-limited one. An arrival that outbids everything while the top meter is
   * empty falls through to the uniform sample like any other, and if the pool
   * is full it can be dropped. It is representable within a few seconds, not
   * within a frame.
   */
  const topShare = state.topQuota / Math.max(1, state.maxEntities);
  state.topCredit = meter(
    state.topCredit,
    INTAKE_PER_SECOND * topShare,
    deltaMs,
  );
  state.intakeCredit = meter(
    state.intakeCredit,
    INTAKE_PER_SECOND * (1 - topShare),
    deltaMs,
  );
  let topBudget = Math.floor(state.topCredit);
  state.topCredit -= topBudget;

  // --- top quota: highest fees, sorted descending so this can stop early ----
  let consumed = 0;
  for (let i = 0; i < arrivals.length; i++) {
    if (topBudget <= 0) break;
    const fee = tipOfTx(arrivals[i]);
    if (topCount < state.topQuota) {
      state.entities.push(spawn(state, arrivals[i], rand, "top"));
      topCount += 1;
      topBudget -= 1;
      consumed = i + 1;
      continue;
    }
    const weakest = weakestTopIndex(state);
    if (weakest === -1 || fee <= tipOf(state, state.entities[weakest])) break;
    state.entities[weakest] = spawn(state, arrivals[i], rand, "top");
    state.evictedFromTop += 1;
    topBudget -= 1;
    consumed = i + 1;
  }
  // Unspent top credit is returned rather than burnt, so a frame that found
  // nothing worth promoting does not lose the allowance it had earned.
  state.topCredit += topBudget;

  // --- sample: a uniform draw from what is left, into slots age has freed ---
  // Anything the top loop could not afford arrives here and competes uniformly,
  // rather than waiting in the queue: holding it back would starve the sample
  // every frame, since the top meter is empty most frames by design.
  const remaining = arrivals.slice(consumed);
  const free = Math.max(0, sampleQuota - sampleCount);
  const take = Math.min(free, remaining.length, Math.floor(state.intakeCredit));
  state.intakeCredit -= take;

  // Partial Fisher–Yates: the first `take` entries become a uniform random
  // subset without shuffling the whole batch. Uniform is the entire point —
  // any fee-aware selection here would put the distribution's shape back into
  // the hands of the renderer.
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(rand() * (remaining.length - i));
    const picked = remaining[j];
    remaining[j] = remaining[i];
    remaining[i] = picked;
    state.entities.push(spawn(state, picked, rand));
    sampleCount += 1;
  }

  state.notSampled += remaining.length - take;
}

/**
 * Keeps spawns off the very edge. Drift amplitude is ~0.018, so an entity born
 * at 0 would spend half its life clipped by the canvas boundary.
 */
const SPAWN_INSET = 0.04;

/** Maps a 0..1 layout position into the inset band. */
function inset(position: number): number {
  return SPAWN_INSET + position * (1 - SPAWN_INSET * 2);
}

/** Kept off the band's own edges, as SPAWN_INSET keeps marks off the chamber's. */
const BAND_INSET = 0.12;

/**
 * Where a tip lives vertically.
 *
 * On the axis, its fee height. At the floor, somewhere inside the band under
 * the axis, chosen by the mark's own seed so it is deterministic and does not
 * move when the axis recalibrates. See `FLOOR_BAND`: the band's y is packing
 * space, like x, and says nothing about the transaction beyond "at the floor".
 */
export function homeYFor(state: WorldState, tip: number, seed: number): number {
  if (!atFloor(tip)) return inset(state.heightFor(tip));
  const frac = (seed / (Math.PI * 2)) % 1;
  const within = BAND_INSET + frac * (1 - 2 * BAND_INSET);
  return 1 - FLOOR_BAND + within * FLOOR_BAND;
}

function spawn(
  state: WorldState,
  tx: PendingTx,
  rand: () => number,
  slot: EntitySlot = "sample",
): Entity {
  // x carries nothing: it is packing space. y is the fee, so the vertical axis
  // is readable without a label and the crowding at the median is the
  // distribution rather than a decorative effect.
  const homeX = inset(rand());
  const driftSeedA = rand() * Math.PI * 2;
  const homeY = homeYFor(
    state,
    effectivePriorityFee(tx.fees, state.baseFeePerGas),
    driftSeedA,
  );
  return {
    hash: tx.hash,
    fees: tx.fees,
    firstSeen: tx.firstSeen,
    phase: "pending",
    slot,
    origin: "seen",
    slotIndex: -1,
    gas: tx.gas,
    phaseStartMs: state.elapsedMs,
    flightProgress: 0,
    // It is in the field. When it leaves for a block it leaves from here.
    enteredInFlight: false,
    x: homeX,
    y: homeY,
    fromX: homeX,
    fromY: homeY,
    homeX,
    homeY,
    driftSeedA,
    driftSeedB: rand() * Math.PI * 2,
    cullAtMs:
      state.decayTauMs *
      CULL_AFTER_TAU *
      (CULL_SPREAD_MIN + rand() * (1 - CULL_SPREAD_MIN)),
  };
}

/** Slow, fast. Two incommensurate periods so the motion never visibly loops. */
const DRIFT_SLOW_HZ = 0.037;
const DRIFT_FAST_HZ = 0.113;
const DRIFT_AMPLITUDE_X = 0.018;

/**
 * Organic drift rather than a random walk — horizontally, and only there.
 *
 * A random walk reads as noise and lets entities wander off their anchor. Two
 * sine components at unrelated frequencies, offset per entity, read as
 * suspension in a medium, which is what a mempool is.
 *
 * It used to move on both axes, and on one of them it had no right to. `x`
 * carries nothing — it is packing space, and a mark is free to move in it. `y`
 * *is* the fee, so vertical drift is not atmosphere, it is error in the value.
 * Measured on the running app over eight seconds, against an axis spanning 2.13
 * decades: marks wandered a median of 0.0085 of the chamber height and at most
 * 0.0145, which is 5.6px and 9.5px, which is **4.2% median and 7.4% maximum
 * error on the tip**. A reader lining a mark up against the 0.5 gwei rule was
 * being shown a number that was never that transaction's.
 *
 * So the field still breathes, and it breathes along the axis that means
 * nothing. Motion is allowed exactly where there is no datum under it.
 */
function drift(entity: Entity, elapsedSeconds: number): void {
  const slow = elapsedSeconds * DRIFT_SLOW_HZ * Math.PI * 2;
  const fast = elapsedSeconds * DRIFT_FAST_HZ * Math.PI * 2;
  entity.x =
    entity.homeX +
    Math.sin(slow + entity.driftSeedA) * DRIFT_AMPLITUDE_X +
    Math.sin(fast + entity.driftSeedB) * DRIFT_AMPLITUDE_X * 0.35;
}

/**
 * Advances the simulation by `deltaMs`.
 *
 * Deterministic in `(state, deltaMs, now)`: given the same inputs it produces
 * the same output, so `step(state, 8000, t)` is exactly eight seconds of
 * frames. Nothing here reads `Date.now()` or `performance.now()`.
 *
 * @param now ms since epoch, used only to age entities against `firstSeen`.
 */
export function step(state: WorldState, deltaMs: number, now: number): void {
  const rand = mulberry32(
    // Derived from the accumulated time so a replay of the same step sequence
    // spawns in the same places.
    (state.elapsedMs * 1000 + state.entities.length) >>> 0,
  );

  state.elapsedMs += deltaMs;

  // Cull before draining, so freed slots are available to this frame's
  // arrivals rather than to the next one.
  cullDecayed(state, now);
  drainInbox(state, rand, deltaMs);

  const elapsedSeconds = state.elapsedMs / 1000;
  // Exponential approach, so the migration is framerate-independent like
  // everything else here.
  const settle = 1 - Math.exp(-deltaMs / MIGRATE_TAU_MS);

  for (const entity of state.entities) {
    if (entity.phase !== "pending") continue;
    // The fee window moves and the base fee changes every block, so an
    // entity's rightful height changes under it. Gliding rather than snapping
    // means a base fee step reads as the whole field breathing, which is what
    // it is, instead of as everything teleporting.
    const target = homeYFor(state, tipOf(state, entity), entity.driftSeedA);
    if (state.reducedMotion) {
      // Snapped, not glided. The migration is data-driven, but under reduced
      // motion the honest presentation of a base-fee change is the new
      // arrangement, not the journey to it.
      entity.homeY = target;
      entity.x = entity.homeX;
      entity.y = entity.homeY;
    } else {
      entity.homeY += (target - entity.homeY) * settle;
      drift(entity, elapsedSeconds);
    }
  }

  advanceBlock(state);
}

/**
 * Moves the landed block along.
 *
 * A seen transaction crosses from wherever it was in the field to its slot,
 * eased. A ghost has no `from` — it is already at its slot and only its
 * appearance is animated, which is what `drawBlockPass` reads `phaseStartMs`
 * for. The two never share a code path, because the whole point is that they
 * do not look alike.
 */
function advanceBlock(state: WorldState): void {
  for (const mark of state.block) {
    if (mark.phase !== "flying") continue;
    if (state.reducedMotion) {
      // It still lands. It just does not travel to get there.
      mark.phase = "settled";
      mark.flightProgress = 1;
      continue;
    }
    const progress = (state.elapsedMs - mark.phaseStartMs) / state.landBlockMs;
    if (progress >= 1) {
      mark.phase = "settled";
      mark.flightProgress = 1;
      continue;
    }
    // Eased here rather than in the renderer, so the same curve drives both
    // the path and the emissive→matte cross-fade and they cannot drift apart.
    mark.flightProgress = state.landEase(Math.max(0, progress));
  }
}

/**
 * Lands the block on screen again.
 *
 * The one event the apparatus exists to show lasts two and a half seconds
 * out of every twelve, and a reader arrives mid-cycle. This replays it: every
 * public row flies again from where it flew from, every private row appears
 * again in its turn, the tracks are laid again. Nothing about the data
 * changes — same block, same rows, same verdicts — so the panel does not
 * move. It is the animation, and only the animation.
 *
 * Under reduced motion there is no animation to replay, and nothing happens.
 */
export function replayLanding(state: WorldState): void {
  if (state.reducedMotion) return;
  const count = state.block.length;
  for (const mark of state.block) {
    mark.phaseStartMs = state.elapsedMs + departureDelay(mark.slotIndex, count);
    if (mark.origin === "seen") {
      mark.phase = "flying";
      mark.flightProgress = 0;
    }
  }
}

/**
 * How long a block takes to arrive, spread across its own order.
 *
 * Every transaction still takes `--land-block` to cross; they just do not all
 * leave at once. Slot 0 goes first, the last slot goes this much later.
 *
 * Before this, all hundred and fifty started on the same millisecond, so the
 * one event the whole product exists to show — public flow arriving from the
 * left, private flow appearing in place with no journey — was a single 420ms
 * flash once every twelve seconds. On screen 3.5% of the time. A viewer who
 * blinked saw bars swap.
 *
 * Staggering costs nothing and encodes nothing new: block position is already
 * the row's Y, so releasing in that order is the same fact told twice rather
 * than a new channel competing for attention. What it buys is that the
 * transition becomes legible at all — the crossing is occupied for 2.4s of
 * every 12 instead of 0.42, and the block is watched being built instead of
 * being found already built.
 *
 * It is also what the thing is called. A block is assembled in an order; a
 * flow is what that looks like.
 */
const BLOCK_ASSEMBLY_MS = 2000;

/** When one slot leaves the field, relative to the block landing. */
function departureDelay(index: number, count: number): number {
  if (count <= 1) return 0;
  return (BLOCK_ASSEMBLY_MS * index) / (count - 1);
}

/** How quickly an entity migrates to a new rightful height. */
const MIGRATE_TAU_MS = 900;

/**
 * Removes traces that have decayed past visibility.
 *
 * Without this the pool fills with three hundred invisible entities and the
 * field quietly stops accepting arrivals — it keeps drawing, so nothing looks
 * broken, it just stops being live. Swap-with-last rather than `splice` so a
 * full sweep stays linear.
 */
function cullDecayed(state: WorldState, now: number): void {
  const entities = state.entities;
  for (let i = entities.length - 1; i >= 0; i--) {
    const entity = entities[i];
    if (entity.phase !== "pending") continue;
    if (now - entity.firstSeen <= entity.cullAtMs) continue;
    entities[i] = entities[entities.length - 1];
    entities.pop();
    state.culledByAge += 1;
  }
}

/** Age in ms of an entity at a given wall-clock time. */
export function ageOf(entity: Entity, now: number): number {
  return Math.max(0, now - entity.firstSeen);
}
