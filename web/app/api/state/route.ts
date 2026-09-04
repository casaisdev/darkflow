/** The ingest's counters and coverage for this instance. */
import { stateResponse } from "../../../../ingest/src/vercel.ts";
import { getIngestCore } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return stateResponse(getIngestCore());
}
