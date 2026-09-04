import {
  WIRE_VERSION,
  type BlockEvent,
  type Fees,
  type Hex,
  type PendingTx,
  type StreamEvent,
  type StreamSource,
} from "@/types/stream";

/**
 * The real source: an `EventSource` against the ingest worker.
 *
 * Wired but inactive until `NEXT_PUBLIC_STREAM_SOURCE=sse`.
 *
 * The browser connects to the ingest **directly**, not through a Next route
 * handler. `next/dist/docs/01-app/02-guides/backend-for-frontend.md` warns that
 * long-running handlers are killed by host timeouts on lambda-style platforms,
 * which is exactly what an open stream is. That makes CORS the ingest's
 * problem, and it is written into the contract in `types/stream.ts`.
 *
 * Reconnection is left to `EventSource`, which already retries with the
 * server-supplied `retry:` interval. Hand-rolling that would only reimplement
 * it worse.
 *
 * ## Validation is strict, and it is strict here
 *
 * Nothing downstream checks a frame again. The world sizes a block row from
 * `gasUsed[index]`, the seen-set keys on `hash`, the axis feeds on `fees` — and
 * each of those, handed a missing or mistyped value, produces a picture rather
 * than an error: a row of default width, a record under the key `undefined`, a
 * NaN in the fee window. So the parser is the one place a bad frame can be
 * refused, and it refuses whole: a block with one bad entry is dropped, not
 * trimmed, because a block drawn with 149 rows is a lie about a block with
 * 150. A transaction batch is filtered instead, because transactions are
 * independent and the good ones are still real.
 */
export function createSseSource(url: string): StreamSource {
  return (onTx, onBlock, hooks) => {
    if (!url) {
      const reason =
        "NEXT_PUBLIC_STREAM_SOURCE=sse but NEXT_PUBLIC_INGEST_URL is empty";
      console.error(`[stream] ${reason}; no data will arrive.`);
      // Said to the page, not only to the console. Without this the status
      // read "connecting" forever over a source that was never going to.
      hooks?.onFailure?.(reason);
      return () => {};
    }

    // Provenance, once. A live source is the only kind that is "now", and the
    // chrome must not have to infer that from the absence of a description.
    hooks?.onDescribe?.({ kind: "live" });

    const source = new EventSource(url);

    /**
     * The link, observed.
     *
     * `EventSource` retries by itself and nothing here interferes with that.
     * What it does not do is tell anyone: a dropped socket is a silent field
     * until the silence is long enough to be called stale, and for those
     * seconds the page says "live" over nothing. So the browser's own events
     * are forwarded, and the chrome can say "reconnecting" the instant it is.
     */
    source.onopen = () => hooks?.onLink?.("open");
    source.onerror = () => {
      hooks?.onLink?.(
        source.readyState === EventSource.CLOSED ? "closed" : "reconnecting",
      );
    };

    source.onmessage = (event: MessageEvent<string>) => {
      const parsed = parseEvent(event.data);
      if (!parsed) return;
      switch (parsed.kind) {
        case "txs":
          warnOnFutureTimestamps(parsed.txs);
          onTx(parsed.txs, { snapshot: false });
          break;
        case "snapshot":
          warnOnFutureTimestamps(parsed.txs);
          onTx(parsed.txs, { snapshot: true });
          break;
        case "block":
          onBlock(parsed.block);
          break;
      }
    };

    return () => {
      source.onmessage = null;
      source.onopen = null;
      source.onerror = null;
      source.close();
      hooks?.onLink?.("closed");
    };
  };
}

/**
 * Tolerance on `firstSeen` being ahead of this browser's clock.
 *
 * The ingest stamps timestamps from a node's clock and the browser compares
 * them against its own; a second of disagreement between two machines is
 * ordinary and means nothing.
 */
const CLOCK_SKEW_TOLERANCE_MS = 2000;

let warnedAboutSkew = false;
let warnedAboutVersion = false;

/**
 * Says so, once, when the ingest's clock is ahead of ours.
 *
 * `ageOf` computes `Math.max(0, now - firstSeen)`, so a timestamp from the
 * future clamps to age zero — and an age of zero is full brightness, forever,
 * indistinguishable from a transaction that arrived this instant. Nothing in
 * the picture would ever look wrong; the field would simply stop decaying, in
 * the same silent way a NaN alpha stopped decaying it before.
 *
 * Warned rather than dropped: a skewed clock still carries a real transaction,
 * and refusing the data would turn a cosmetic fault into a missing one. Warned
 * rather than clamped quietly, because the clamp is what hides it.
 */
function warnOnFutureTimestamps(txs: readonly PendingTx[]): void {
  if (warnedAboutSkew) return;
  const now = Date.now();
  const ahead = txs.find((tx) => tx.firstSeen > now + CLOCK_SKEW_TOLERANCE_MS);
  if (!ahead) return;
  warnedAboutSkew = true;
  console.warn(
    "[stream] the ingest's clock is ahead of this browser by " +
      `${Math.round((ahead.firstSeen - now) / 1000)}s. Ages clamp to zero, so ` +
      "affected marks will render at full brightness and never fade.",
  );
}

/**
 * Parses one frame, rejecting anything malformed rather than letting it reach
 * the render loop. A bad frame is dropped and logged; it must not be able to
 * stop the stream.
 */
function parseEvent(raw: string): StreamEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    console.warn("[stream] dropped a frame that was not JSON");
    return null;
  }
  if (typeof data !== "object" || data === null || !("kind" in data)) {
    return null;
  }
  const candidate = data as {
    v?: unknown;
    kind: unknown;
    txs?: unknown;
    block?: unknown;
  };

  // A frame from another version of the contract is not interpreted. Its
  // fields may have the same names and different meanings — a `firstSeen` in
  // seconds, say — and every one of those would parse cleanly into a wrong
  // picture. Said once, because it will be said on every frame otherwise.
  if (candidate.v !== WIRE_VERSION) {
    if (!warnedAboutVersion) {
      warnedAboutVersion = true;
      console.warn(
        `[stream] dropping frames: wire version ${String(candidate.v)}, ` +
          `this client speaks ${WIRE_VERSION}.`,
      );
    }
    return null;
  }

  if (
    (candidate.kind === "txs" || candidate.kind === "snapshot") &&
    Array.isArray(candidate.txs)
  ) {
    const txs = candidate.txs.filter(isPendingTx);
    const dropped = candidate.txs.length - txs.length;
    if (dropped > 0) {
      console.warn(
        `[stream] dropped ${dropped} malformed transaction(s) from a ${candidate.kind} frame`,
      );
      // Everything in the frame was bad: that is a broken ingest, not a quiet
      // pool, and an empty batch would say the opposite.
      if (txs.length === 0) return null;
    }
    return { v: WIRE_VERSION, kind: candidate.kind, txs };
  }
  if (candidate.kind === "block" && isBlock(candidate.block)) {
    return { v: WIRE_VERSION, kind: "block", block: candidate.block };
  }
  console.warn("[stream] dropped a frame with an unrecognised shape");
  return null;
}

const isFinite_ = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isHex = (value: unknown): value is Hex =>
  typeof value === "string" && value.startsWith("0x") && value.length > 2;

function isFees(value: unknown): value is Fees {
  if (typeof value !== "object" || value === null) return false;
  const fees = value as Partial<Record<string, unknown>>;
  if (fees.kind === "legacy") return isFinite_(fees.gasPrice);
  if (fees.kind === "eip1559") {
    return isFinite_(fees.maxFeePerGas) && isFinite_(fees.maxPriorityFeePerGas);
  }
  return false;
}

/**
 * One pending transaction, as the world and the seen-set need it.
 *
 * `from` and `to` are optional on the wire and nothing here draws them, so
 * they are not checked: a wrong sender cannot produce a wrong picture yet.
 */
function isPendingTx(value: unknown): value is PendingTx {
  if (typeof value !== "object" || value === null) return false;
  const tx = value as Partial<PendingTx>;
  return (
    isHex(tx.hash) &&
    isFinite_(tx.firstSeen) &&
    isFinite_(tx.gas) &&
    isFees(tx.fees)
  );
}

/**
 * A block, whole.
 *
 * `gasUsed` must be exactly one finite number per hash. `applyBlock` sizes row
 * `i` from `gasUsed[i]`, and a shorter array would size the tail of the block
 * at zero — private flow, which sits wherever the tip puts it, rendered as
 * nothing. The contract says the ingest reads it from the block receipts,
 * where it exists for every transaction; a frame that arrives without it is a
 * frame the ingest could not have built from a receipt.
 */
function isBlock(value: unknown): value is BlockEvent {
  if (typeof value !== "object" || value === null) return false;
  const block = value as Partial<BlockEvent>;
  return (
    isFinite_(block.number) &&
    isFinite_(block.timestamp) &&
    isFinite_(block.baseFeePerGas) &&
    Array.isArray(block.hashes) &&
    block.hashes.every(isHex) &&
    Array.isArray(block.gasUsed) &&
    block.gasUsed.length === block.hashes.length &&
    block.gasUsed.every(isFinite_) &&
    // Optional; when present it is whole, like gasUsed.
    (block.tips === undefined ||
      (Array.isArray(block.tips) &&
        block.tips.length === block.hashes.length &&
        block.tips.every(isFinite_)))
  );
}
