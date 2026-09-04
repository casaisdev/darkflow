/**
 * The live feed, served by the site itself: `/api/stream`, `/api/state` and
 * `/api/health`, from one route handler on purpose.
 *
 * On Vercel every route file is its own function with its own instance, and
 * the ingest core lives in module state. Three files meant three instances:
 * measured on the first deployment, `/api/stream` was delivering frames while
 * `/api/state` on its own instance reported `running: false, starts: 0`, and
 * the panel's COVERAGE reading, which polls `/api/state`, stayed blank. One
 * dynamic segment puts the three paths in one function, so `/api/state`
 * describes the core that is actually serving the stream.
 *
 * `EventSource("/api/stream")` from the page: same origin, no CORS, and the
 * upstream subscription is opened when the first page arrives. `maxDuration`
 * is the platform's ceiling for one streamed response; the core closes the
 * stream just before it so the page reconnects on its own terms, carrying
 * `Last-Event-ID`.
 */
import { healthResponse, stateResponse, streamResponse } from "../../../../ingest/src/vercel.ts";
import { getIngestCore } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A literal, not an import: Next reads segment config statically and refuses
// anything else at build time. tests/api-stream.test.ts holds it equal to
// STREAM_MAX_DURATION_S, which is where the stream limit is derived from.
export const maxDuration = 300;

export async function GET(request: Request, context: RouteContext<"/api/[endpoint]">): Promise<Response> {
  const { endpoint } = await context.params;
  switch (endpoint) {
    case "stream":
      return streamResponse(getIngestCore(), request);
    case "state":
      return stateResponse(getIngestCore());
    case "health":
      return healthResponse(getIngestCore());
    default:
      return new Response("not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}
