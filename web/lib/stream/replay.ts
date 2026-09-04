import type {
  SourceControls,
  SourceHooks,
  StreamSource,
} from "@/types/stream";
import {
  decodeBlock,
  decodeTx,
  isRecording,
  type RecordedFrame,
  type Recording,
} from "@/lib/replay/format";

/**
 * A recording of mainnet, played back at its own pace — or driven.
 *
 * Wired when `NEXT_PUBLIC_STREAM_SOURCE=replay`. Between the generator and
 * the ingest: real transactions, real blocks, the real share of a block that
 * the recording's vantage point never heard about — and one dishonesty, which
 * is that none of it is now. The status dot says `recorded`, the panel says
 * when and which blocks, and the About plate says it in words.
 *
 * ## Time
 *
 * The recording keeps its own clock, `elapsed`, in recorded milliseconds. It
 * advances with the consumer's clock (`hooks.now`, which a paused consumer
 * stops) at `rate` recorded seconds per consumer second. A frame is due when
 * its offset is behind `elapsed`, and every time it carries is rebased so
 * that "how long ago" is preserved on the consumer's clock:
 *
 *     consumerTime(t) = now − (elapsed − t) / rate
 *
 * At rate 1 that is the recording shifted by a constant. At rate 6 — the
 * calibration fast-forward — a transaction announced forty recorded seconds
 * before its block is announced six and two thirds before it, which is what
 * fast-forward looks like and what the label says.
 *
 * ## Driving it
 *
 * A recording can be paused, stepped and jumped without lying, because it is
 * a record and not the chain. The controls are handed to the consumer once
 * the recording has loaded; a live source never offers them. Jumping ahead
 * delivers every frame in between, in order, so the record stays complete —
 * the consumer sees a burst of time passing, not a gap.
 *
 * ## Ending
 *
 * A recording ends. It is not looped here, because a loop is a reorg: block
 * numbers going back to the start would be judged as the chain replacing
 * twenty-five blocks. The source says it has ended through `hooks.onEnd`, and
 * the instrument restarts with fresh state.
 *
 * ## Failure
 *
 * A recording that cannot be fetched, or that fails validation, produces no
 * frames. The consumer is told why through `hooks.onFailure`, so the page can
 * say it rather than a console nobody has open.
 */

/** Pause after the last frame before the source reports its end. */
export const REPLAY_TAIL_MS = 1500;

export type ReplayOptions = {
  /** Test seam. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
};

export function createReplaySource(
  url: string,
  options: ReplayOptions = {},
): StreamSource {
  const fetchImpl = options.fetchImpl ?? fetch;

  return (onTx, onBlock, hooks) => {
    const now = hooks?.now ?? Date.now;

    if (!url) {
      const reason =
        "NEXT_PUBLIC_STREAM_SOURCE=replay but NEXT_PUBLIC_REPLAY_URL is empty";
      console.error(`[replay] ${reason}; no data will arrive.`);
      hooks?.onFailure?.(reason);
      return () => {};
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    load(fetchImpl, url, controller.signal, hooks)
      .then((data) => {
        if (stopped) return;
        if (!isRecording(data)) {
          const reason = "the file is not a recording this client can vouch for";
          console.error(`[replay] ${url}: ${reason}; refusing to play it.`);
          hooks?.onFailure?.(reason);
          return;
        }
        play(data);
      })
      .catch((error: unknown) => {
        if (stopped) return;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[replay] could not load ${url}: ${message}`);
        hooks?.onFailure?.(message);
      });

    function play(recording: Recording): void {
      const { meta, frames } = recording;
      hooks?.onDescribe?.({
        kind: "recording",
        chainId: meta.chainId,
        capturedAt: meta.capturedAt,
        durationMs: meta.durationMs,
        firstBlock: meta.firstBlock,
        lastBlock: meta.lastBlock,
        sources: meta.sources,
        txs: meta.counts.txs,
        blocks: meta.counts.blocks,
      });

      /** Recorded ms delivered so far. The recording's own clock. */
      let elapsed = 0;
      let lastTick = now();
      let rate = 1;
      let paused = false;
      let index = 0;

      /** A recorded offset, on the consumer's clock, as of this instant. */
      const rebase = (t: number, at: number) => at - (elapsed - t) / rate;

      function deliver(frame: RecordedFrame, at: number): void {
        if (frame.kind === "txs") {
          // Each row is rebased on its own offset, not the frame's, so the
          // spread of ages inside a batch survives.
          const epochFor = (s: number) => rebase(s, at) - s;
          onTx(
            frame.txs.map((row) => decodeTx(row, epochFor(row[1]))),
            { snapshot: false },
          );
        } else {
          onBlock(decodeBlock(frame, rebase(frame.timestamp, at) - frame.timestamp));
        }
      }

      function advance(): void {
        const at = now();
        elapsed += Math.max(0, at - lastTick) * rate;
        lastTick = at;
      }

      /** Everything due, in order; then the next timer. */
      function tick(): void {
        if (stopped || paused) return;
        advance();
        const at = now();
        while (index < frames.length && frames[index].t <= elapsed) {
          deliver(frames[index++], at);
        }
        schedule();
      }

      function schedule(): void {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        if (stopped || paused) return;
        if (index < frames.length) {
          const delay = (frames[index].t - elapsed) / rate;
          timer = setTimeout(tick, Math.max(0, delay));
        } else {
          timer = setTimeout(() => {
            if (!stopped) hooks?.onEnd?.();
          }, REPLAY_TAIL_MS);
        }
      }

      /** Jumps the recording's clock to `t` and delivers up to there. */
      function jumpTo(t: number): void {
        advance();
        elapsed = Math.max(elapsed, t);
        tick();
      }

      const controls: SourceControls = {
        pause() {
          if (paused) return;
          advance();
          paused = true;
          if (timer !== null) clearTimeout(timer);
          timer = null;
        },
        resume() {
          if (!paused) return;
          paused = false;
          lastTick = now();
          tick();
        },
        setRate(next) {
          if (!(next > 0) || next === rate) return;
          advance();
          rate = next;
          schedule();
        },
        nextBlock() {
          const target = frames.findIndex(
            (frame, i) => i >= index && frame.kind === "block",
          );
          if (target < 0) return;
          if (paused) controls.resume();
          jumpTo(frames[target].t);
        },
        paused: () => paused,
        rate: () => rate,
      };
      hooks?.onControls?.(controls);

      // A deep link: everything before that block, delivered at once, and
      // the block itself lands now.
      const startAt = hooks?.startAtBlock;
      if (startAt !== undefined) {
        const target = frames.findIndex(
          (frame) => frame.kind === "block" && frame.number === startAt,
        );
        if (target >= 0) {
          elapsed = frames[target].t;
          lastTick = now();
        }
      }
      tick();
    }

    return () => {
      stopped = true;
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
  };
}

/**
 * Fetches the recording, reporting progress as it comes.
 *
 * Read as a stream so the page can say "loading recording · 62%" instead of
 * a dot that pulses for however long a megabyte takes on a phone. `total`
 * is the Content-Length when the server sends one — which, over a compressed
 * transfer, it often does not; then only `loaded` is known and the page says
 * bytes rather than a percentage.
 */
async function load(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal,
  hooks: SourceHooks | undefined,
): Promise<unknown> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const length = response.headers?.get?.("content-length");
  const total = length ? Number(length) || null : null;
  const reader = response.body?.getReader?.();
  if (!reader || !hooks?.onProgress) {
    return response.json();
  }
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  hooks.onProgress({ loaded, total });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    hooks.onProgress({ loaded, total });
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
