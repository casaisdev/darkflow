/**
 * The live feed, served by the site itself.
 * `EventSource("/api/stream")` from the page: same origin, no CORS, and the
 * upstream subscription is opened when the first page arrives.
 *
 * `maxDuration` is the platform's ceiling for one streamed response; the
 * core closes the stream just before it so the page reconnects on its own
 * terms, carrying `Last-Event-ID`.
 */
import { streamResponse } from "../../../../ingest/src/vercel.ts";
import { getIngestCore } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A literal, not an import: Next reads segment config statically and refuses
// anything else at build time. tests/api-stream.test.ts holds it equal to
// STREAM_MAX_DURATION_S, which is where the stream limit is derived from.
export const maxDuration = 300;

export function GET(request: Request): Response {
  return streamResponse(getIngestCore(), request);
}
