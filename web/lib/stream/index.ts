import type { OnBlock, OnTx, SourceHooks, Unsubscribe } from "@/types/stream";
import { createReplaySource } from "./replay";
import { createSseSource } from "./sse";
import { createSyntheticSource } from "./synthetic";
import { stateUrlFor } from "@/lib/stream/coverage";

/**
 * The only way anything in this app gets data.
 *
 * Nothing downstream may import `./synthetic` or `./sse` directly, and nothing
 * downstream may know which is active. The ingest is going to move hosts and
 * change internals; this boundary is what keeps that from rippling.
 *
 * @returns an unsubscribe function. Call it from the effect cleanup — Strict
 * Mode remounts once in development, so a source that is not torn down will
 * quietly run twice.
 */
/**
 * Whether a recording is configured to stand in for a lost live feed.
 *
 * A build-time literal, like the source switch: the recording URL is baked
 * in, so whether a fallback exists is known before the page loads and the
 * chrome can decide once. `false` on any build that is not live.
 */
export function fallbackConfigured(): boolean {
  return (
    process.env.NEXT_PUBLIC_STREAM_SOURCE === "sse" &&
    Boolean(process.env.NEXT_PUBLIC_REPLAY_URL)
  );
}

export type SubscribeOptions = {
  /**
   * Play the configured recording instead of the live feed.
   *
   * For a live build whose feed has been lost for long enough that the page
   * is showing nothing. The caller decides when; this only honours it, and
   * only when a recording is configured — a live build with no recording
   * ignores the request and connects live, so the chrome cannot promise a
   * fallback the build does not have.
   */
  fallback?: boolean;
};

export function subscribe(
  onTx: OnTx,
  onBlock: OnBlock,
  hooks?: SourceHooks,
  options: SubscribeOptions = {},
): Unsubscribe {
  if (options.fallback && fallbackConfigured()) {
    return createReplaySource(process.env.NEXT_PUBLIC_REPLAY_URL ?? "")(
      onTx,
      onBlock,
      hooks,
    );
  }
  // Written as a literal member access on purpose, twice over:
  // · Next only inlines `process.env.NEXT_PUBLIC_*` when accessed exactly like
  //   this. `process.env[name]` and destructuring both yield undefined in the
  //   browser (see docs/01-app/02-guides/environment-variables.md).
  // · Because it is a literal, the bundler can fold the comparison and drop the
  //   branch not taken, so the synthetic generator does not ship to production.
  if (process.env.NEXT_PUBLIC_STREAM_SOURCE === "sse") {
    return createSseSource(process.env.NEXT_PUBLIC_INGEST_URL ?? "")(
      onTx,
      onBlock,
      hooks,
    );
  }
  if (process.env.NEXT_PUBLIC_STREAM_SOURCE === "replay") {
    return createReplaySource(process.env.NEXT_PUBLIC_REPLAY_URL ?? "")(
      onTx,
      onBlock,
      hooks,
    );
  }
  return createSyntheticSource({
    // Literal member access, as everywhere: anything else is undefined in the
    // browser. See docs/01-app/02-guides/environment-variables.md.
    ghostGasBias:
      process.env.NEXT_PUBLIC_GHOST_GAS_BIAS === "mev" ? "mev" : "none",
    // Zero, and so off, unless the variable holds a positive integer.
    reorgEveryBlocks: Math.max(
      0,
      Math.floor(Number(process.env.NEXT_PUBLIC_SYNTHETIC_REORG_EVERY) || 0),
    ),
  })(onTx, onBlock, hooks);
}

/** Which source is live. For the status readout and for debugging. */
export function activeSourceName(): "sse" | "replay" | "synthetic" {
  switch (process.env.NEXT_PUBLIC_STREAM_SOURCE) {
    case "sse":
      return "sse";
    case "replay":
      return "replay";
    default:
      return "synthetic";
  }
}

/**
 * Where the ingest reports on itself, when the build is wired to one.
 * Literal member access, as above, so it folds to `null` on any other build
 * and the coverage reading never asks a recording or a generator for a
 * figure they cannot have.
 */
export function ingestStateUrl(): string | null {
  if (process.env.NEXT_PUBLIC_STREAM_SOURCE !== "sse") return null;
  return stateUrlFor(process.env.NEXT_PUBLIC_INGEST_URL ?? "");
}
