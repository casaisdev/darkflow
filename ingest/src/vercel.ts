/**
 * The web-standard adapter: the core behind `Request`
 * and `Response`, for a Next.js route handler on Vercel — or anything else
 * that speaks the Fetch API. No Node HTTP here; the stream is a
 * `ReadableStream` the platform drains.
 *
 * Same origin as the page, so there is no CORS to decide. The client address
 * is the platform's `x-forwarded-for`, which the platform sets and the page
 * cannot forge.
 *
 * `streamMaxMs` closes a stream cleanly a little before the platform's own
 * limit would cut it: the client sees an orderly end and reconnects with
 * `Last-Event-ID`, instead of a 504 and a guess.
 */
import type { IngestCore } from "./core.ts";
import type { Client } from "./hub.ts";

const encoder = new TextEncoder();

export function clientAddressOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function lastEventIdOf(request: Request): number | null {
  const raw = request.headers.get("last-event-id");
  if (raw === null) return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function streamResponse(
  core: IngestCore,
  request: Request,
  options: { now?: () => number; streamMaxMs?: number; retryMs?: number } = {},
): Response {
  const { now = Date.now, streamMaxMs = core.config.streamMaxMs, retryMs = 1000 } = options;
  const ip = clientAddressOf(request);
  const verdict = core.admission(ip);
  if (verdict !== "ok") {
    const full = verdict === "full";
    return new Response(full ? "too many clients" : "too many streams from this address", {
      status: full ? 503 : 429,
      headers: { "Retry-After": "30", "Content-Type": "text/plain" },
    });
  }

  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  const client: Client = {
    write(chunk) {
      if (closed || !controller) return false;
      try {
        controller.enqueue(encoder.encode(chunk));
      } catch {
        return false;
      }
      // A consumer that stops reading lets the queue fill; the hub reads
      // that as a stall and evicts after its grace period.
      return (controller.desiredSize ?? 1) > 0;
    },
    end() {
      close();
    },
    onDrain() {
      // A ReadableStream has no drain event; `desiredSize` recovering on the
      // next write is the signal, and `write` reports it.
    },
  };

  function close(): void {
    if (closed) return;
    closed = true;
    if (closeTimer) clearTimeout(closeTimer);
    core.removeClient(client);
    try {
      controller?.close();
    } catch {
      // Already closed by the platform.
    }
  }

  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
      const admitted = core.addClient(client, now(), { ip, lastEventId: lastEventIdOf(request) });
      if (admitted.status !== "ok") {
        // Lost a race between the check and the add; the retry hint covers it.
        close();
        return;
      }
      request.signal.addEventListener("abort", close, { once: true });
      if (streamMaxMs > 0) {
        closeTimer = setTimeout(() => {
          if (closed) return;
          try {
            c.enqueue(encoder.encode(": stream limit reached, reconnect\n\n"));
          } catch {
            // Closing anyway.
          }
          close();
        }, streamMaxMs);
      }
    },
    cancel() {
      close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export function stateResponse(core: IngestCore): Response {
  return Response.json(core.state(), { headers: { "Cache-Control": "no-store" } });
}

export function healthResponse(core: IngestCore): Response {
  const ok = core.healthy();
  return Response.json({ ok }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
