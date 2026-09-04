/** 200 only with both feeds fresh on this instance. */
import { healthResponse } from "../../../../ingest/src/vercel.ts";
import { getIngestCore } from "@/lib/ingest-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return healthResponse(getIngestCore());
}
