/**
 * Wire contract between the page (`web/lib/stream`) and the ingest
 * (`ingest/src`), whichever transport carries it.
 *
 * This file is the interface, not an implementation detail. The ingest has
 * already changed hosts once — a standalone server, then the site's own
 * route handlers — and nothing downstream of `lib/stream` may know which
 * source is active or where it lives.
 *
 * ## Requirements on the ingest
 *
 * - **Batched.** Never one message per transaction. At a few hundred tx/s a
 *   message per tx is thousands of parses and event dispatches per second.
 * - **Origin.** The browser opens the stream itself, as an `EventSource`.
 *   Served from the site's own origin (`/api/stream`) nothing more is needed;
 *   served from anywhere else, the endpoint must allow this origin (CORS).
 *   A route handler can carry it because the platform's functions can stream
 *   for minutes and share one instance across pages; the client is built to
 *   reconnect when such a stream is closed.
 * - **Milliseconds.** Every timestamp here is ms since epoch, including
 *   `BlockEvent.timestamp`. Chain timestamps are seconds; the ingest converts.
 * - **Two feeds, two failures.** `txs` and `block` can fail independently, and
 *   the client is built on the assumption that they will. See below.
 * - **Versioned.** Every frame carries `v: WIRE_VERSION`. A frame from any
 *   other version is dropped, not interpreted: same field names with different
 *   meanings parse cleanly into a wrong picture.
 * - **Whole blocks.** `gasUsed` has exactly one finite entry per hash, and
 *   every field has its declared type. A block frame that fails that is
 *   dropped whole — the client will not size half a block. A malformed entry in
 *   a `txs` frame drops that entry and keeps the rest; a frame in which every
 *   entry is malformed is dropped, since an empty batch would say "quiet pool"
 *   about a broken ingest.
 *
 * ## Delivering transactions while the block feed is down
 *
 * A reachable server state, not a hypothetical: the mempool subscription and
 * the block subscription are different calls to the node, and one can keep
 * working while the other stops. From the wire it looks healthy — frames
 * arrive, they parse, nothing errors.
 *
 * It is also the worst shape a failure can take here, because the figure this
 * product exists to publish is computed from the last block. A feed delivering
 * transactions and no blocks leaves that percentage frozen on a block from
 * minutes ago while every other signal says the stream is fine.
 *
 * The client trusts neither feed to report its own health. It infers both from
 * elapsed silence:
 *
 * - silence on **any** frame past `STALE_AFTER_S` (25s) is a dead stream;
 * - silence on **block** frames past `BLOCK_STALE_AFTER_S` (36s, three block
 *   intervals) means the block-derived readings are no longer current. They are
 *   marked as such and still shown — they were true when they arrived.
 *
 * What the ingest must therefore not do:
 *
 * - **Do not suppress or coalesce `block` frames.** They are the client's only
 *   evidence that the block feed is alive. A quiet period is indistinguishable
 *   from a failure, and correctly so.
 * - **Do not synthesise a `block` frame to keep the client quiet.** A frame
 *   that does not correspond to a block the chain produced turns an honest
 *   "not current" into a false "current", which is the one outcome this whole
 *   contract is arranged to prevent.
 * - If the block feed fails and the transaction feed does not, keep sending
 *   transactions. The mempool half of the picture stays true, and the client
 *   already marks the other half.
 *
 * ## Reorgs
 *
 * Send every change of canonical head as a `block` frame, including one at a
 * height already sent. The client judges each frame against what it holds —
 * see `lib/blocks.ts`: a number above the head is a new block; the head's
 * number with the same hashes is a duplicate and is ignored; a number at or
 * below the head with different hashes is a replacement, and the client
 * withdraws everything from that height up. Orphaned transactions return to
 * pending, the ratio window forgets the withdrawn blocks, and the block on
 * screen is discarded rather than kept as history.
 *
 * So the ingest need not detect reorgs. It forwards heads faithfully, in the
 * order the node reports them, and the client does the rest. What it must not
 * do is re-send a block it already sent as a way of signalling liveness: a
 * duplicate is ignored and counts as evidence of nothing, which is the same
 * rule as for a synthesised block, for the same reason.
 */

/**
 * The version of this contract, carried on every frame as `v`.
 *
 * Bump it when a field changes meaning or shape. Adding an optional field
 * does not need a bump; changing units, renaming, or making something
 * required does. The client speaks exactly one version and drops the rest,
 * so an ingest one version ahead produces a page that says "no signal" rather
 * than a page that is quietly wrong.
 */
export const WIRE_VERSION = 1;
export type WireVersion = typeof WIRE_VERSION;

/** 0x-prefixed lowercase hex. Narrow enough to catch a swapped argument. */
export type Hex = `0x${string}`;

/**
 * Fee shape, discriminated because the two are not interchangeable and the
 * effective tip is computed differently for each. See `lib/fees.ts`.
 */
export type Fees =
  | {
      kind: "eip1559";
      /** wei. The ceiling on base fee + tip. */
      maxFeePerGas: number;
      /** wei. What the sender offers as a tip, before the ceiling applies. */
      maxPriorityFeePerGas: number;
    }
  | {
      kind: "legacy";
      /** wei. Covers base fee and tip together. */
      gasPrice: number;
    };

/** A transaction the ingest has observed in the public mempool. */
export type PendingTx = {
  hash: Hex;
  /**
   * ms since epoch, stamped by the ingest the first time it saw this hash.
   *
   * **Never ahead of real time.** The browser computes a mark's age as
   * `now - firstSeen` and clamps the result at zero, so a timestamp from the
   * future produces an age of zero — which is full brightness, permanently,
   * and identical on screen to a transaction that arrived this instant. The
   * field would simply stop fading and nothing would say why.
   *
   * If the ingest runs on a host whose clock can drift ahead of a viewer's,
   * clamp there rather than sending it: `Math.min(observedAt, Date.now())`.
   * The client warns once past two seconds of skew — see `lib/stream/sse.ts` —
   * but a warning in a console nobody has open is not a fix.
   */
  firstSeen: number;
  /*
   * There is no `value` field, and that is deliberate.
   *
   * It used to be here, carried as a decimal string because 1 ETH is 1e18 wei
   * and a JS number rounds past 9e15. It was correct and it was tested — and
   * nothing ever drew it. Every visual channel is already spoken for: height is
   * the effective priority fee, alpha is age, width is gas used, and tone is
   * the one thing this product claims. There is no free channel left worth
   * spending on the amount being moved, which says nothing about whether a
   * transaction passed through the public mempool.
   *
   * So it is out before the ingest exists, rather than after someone has built
   * and maintained it for no reader. If it ever comes back it must come back as
   * a string for the reason above, and it must arrive with the channel it is
   * going to occupy already decided.
   */
  /**
   * Gas limit, as the sender set it. Announced with the transaction.
   *
   * Not the same quantity as what it ends up consuming in a block — see
   * `BlockEvent.gasUsed`. A limit is an intention; used gas is a measurement,
   * and only one of them exists for a transaction the mempool never saw.
   */
  gas: number;
  fees: Fees;
  from?: Hex;
  /** `null` for a contract creation. */
  to?: Hex | null;
};

/** A block, once the ingest has seen it land. */
export type BlockEvent = {
  number: number;
  /** ms since epoch. */
  timestamp: number;
  /** wei. Needed to turn a fee cap into an effective tip. */
  baseFeePerGas: number;
  /** Included hashes in block order. Index 0 is the top of the block. */
  hashes: Hex[];
  /**
   * Gas consumed by each included transaction, in the same order as `hashes`.
   *
   * This is the only gas figure that exists for every transaction in a block.
   * `PendingTx.gas` is announced with the transaction, so private flow — which
   * is never announced — has none. Sizing a block row by the pending figure
   * would therefore render every ghost at a default width, encoding "we do not
   * know" as "small", which is the class of lie this codebase spends most of
   * its effort avoiding.
   *
   * The ingest reads it from the block receipt, where it exists for all 150.
   */
  gasUsed: number[];
  /**
   * wei. What each included transaction paid above the base fee — its
   * effective priority fee, in the same order as `hashes`. Read from the
   * receipt's `effectiveGasPrice`, so it exists for private flow too: the
   * only place a ghost's bid is ever written down.
   * Optional, and all-or-nothing when present (one finite entry per hash),
   * for the same reason as `gasUsed`: a consumer must never place half a
   * block from data and the other half from a default. An ingest that lacks
   * receipts with `effectiveGasPrice` omits the field; the consumer then
   * places a ghost the way it did before this field existed.
   */
  tips?: number[];
};

/**
 * Events as they arrive on the wire.
 *
 * `snapshot` carries the pool as it stands when the stream opens. It exists
 * because block-count calibration alone cannot close the cold start: a
 * transaction can sit in the pool for minutes, so one that arrived before we
 * connected lands later and looks private when it is not. Seeding from a
 * snapshot removes most of that error.
 *
 * It is **optional**. The ingest may never send one; the consumer falls back to
 * counting blocks.
 *
 * ## Send the whole pool, with true timestamps, and expect most of it not to
 * ## be drawn
 *
 * `firstSeen` in a snapshot must be when the transaction actually entered the
 * pool, however long ago that was. It must not be stamped to the moment of
 * connection. Age is data here: it drives the alpha of every mark in the field,
 * and back-dating it to "now" would make a four-minute-old transaction render
 * as a fresh arrival, which is a lie the renderer has no way to detect.
 *
 * The consequence, measured against the synthetic source: with pool ages spread
 * over the last ninety seconds, **62.7% of a snapshot arrives already below the
 * alpha floor and is never drawn at all.** That is correct and it is not a
 * problem to solve. An earlier version of this comment said the transactions in
 * a snapshot "are also worth drawing", which the renderer contradicted in two
 * cases out of three; the promise is withdrawn rather than the behaviour
 * changed, because the alternative — shipping ages that fit the draw window —
 * means inventing them.
 *
 * So: the snapshot's job is to seed the seen-set, which it does completely,
 * because seeding does not care how old an entry is. Drawing is incidental and
 * only the recent tail of it will render. Send everything; do not trim to what
 * you think will be visible, and do not adjust timestamps to make more of it
 * visible.
 */
export type StreamEvent =
  | { v: WireVersion; kind: "txs"; txs: PendingTx[] }
  | { v: WireVersion; kind: "snapshot"; txs: PendingTx[] }
  | { v: WireVersion; kind: "block"; block: BlockEvent };

/** Extra context for a batch of transactions. */
export type TxBatchMeta = {
  /**
   * True only for the opening pool snapshot. Consumers seed their seen-set from
   * it and may end calibration early; everything else treats it as a normal
   * batch.
   */
  snapshot: boolean;
};

export type OnTx = (txs: readonly PendingTx[], meta: TxBatchMeta) => void;
export type OnBlock = (block: BlockEvent) => void;
export type Unsubscribe = () => void;

/**
 * What a source is, for the chrome to say so.
 *
 * Provenance is not health, and the stream does not report it in-band: a
 * recording's frames are indistinguishable from a live node's, which is the
 * point of a recording and also why the page must be told out of band. A
 * source describes itself once, when it knows.
 */
export type SourceInfo =
  | { kind: "live" }
  | { kind: "synthetic" }
  | {
      kind: "recording";
      chainId: number;
      /** ISO 8601, UTC. */
      capturedAt: string;
      durationMs: number;
      firstBlock: number;
      lastBlock: number;
      /** The endpoints it was heard from. "This node" has to be able to say which. */
      sources: { pending: string[]; blocks: string };
      txs: number;
      blocks: number;
    };

/**
 * Out-of-band signals a source may send. Both optional, both ignored by a
 * caller that does not care.
 *
 * `onEnd` exists for finite sources. A recording ends, and it must not loop:
 * block numbers returning to the start would be judged as the chain replacing
 * every block held, and the panel would report a reorg that never happened.
 * The source says it is done; the instrument restarts with fresh state.
 */
/**
 * What a source that can be driven lets the consumer do.
 *
 * Only a recording offers these. A live stream cannot be paused — the chain
 * does not wait — and cannot be told to skip ahead. The consumer that gets
 * them shows a transport; one that does not, shows none.
 */
export type SourceControls = {
  pause(): void;
  resume(): void;
  /** Recorded seconds per consumer second. 1 is real pace. */
  setRate(rate: number): void;
  /** Deliver everything up to and including the next block, now. */
  nextBlock(): void;
  paused(): boolean;
  rate(): number;
};

export type SourceProgress = {
  loaded: number;
  /** Bytes expected, or `null` when the transfer does not say. */
  total: number | null;
};

/**
 * The state of the connection a source holds, for the chrome to say so.
 *
 * Health is otherwise inferred from silence, and silence is ambiguous: a
 * quiet pool and a dropped socket look the same for the first few seconds.
 * A source that knows its link has gone says so here, the moment it knows.
 * `EventSource` reconnects on its own; `reconnecting` is that retry loop,
 * observed rather than reimplemented.
 */
export type LinkState = "open" | "reconnecting" | "closed";

export type SourceHooks = {
  onDescribe?: (info: SourceInfo) => void;
  /** The link changed state. A recording has none and never calls this. */
  onLink?: (state: LinkState) => void;
  onEnd?: () => void;
  /** Offered once, after the source knows what it is. Never by a live one. */
  onControls?: (controls: SourceControls) => void;
  /** While a source is fetching what it needs before it can start. */
  onProgress?: (progress: SourceProgress) => void;
  /** The source cannot deliver at all, and this is why. */
  onFailure?: (reason: string) => void;
  /**
   * The consumer's clock, ms since epoch. Defaults to `Date.now`.
   *
   * A consumer that pauses stops this clock, and a source that stamps times
   * stamps them on it — so nothing ages while the picture is held still, and
   * nothing arrives from the future when it moves again.
   */
  now?: () => number;
  /** A recording opens at this block, everything before it delivered at once. */
  startAtBlock?: number;
};

/**
 * Every source is this and nothing more. `lib/stream` picks one; no other
 * module may import a concrete source.
 */
export type StreamSource = (
  onTx: OnTx,
  onBlock: OnBlock,
  hooks?: SourceHooks,
) => Unsubscribe;
