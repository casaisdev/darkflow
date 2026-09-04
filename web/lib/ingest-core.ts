/**
 * The ingest, inside the web.
 *
 * One core per function instance, created the first time a route needs it
 * and shared by every request that instance serves: on Vercel's Fluid
 * compute, concurrent invocations share a process, so this is one upstream
 * connection for every open page on the instance. It is held on `globalThis`
 * so a dev-server reload does not leave a second copy subscribed.
 *
 * Configuration is the ingest's own (`UPSTREAM_WS_URL` and friends), read
 * from the server environment at first use — never inlined, never public.
 * The stream limit defaults to just under the route's `maxDuration`, so a
 * page is told to reconnect before the platform cuts it.
 */
import { loadCoreConfig } from "../../ingest/src/config.ts";
import { createIngestCore, type IngestCore } from "../../ingest/src/core.ts";
import { createLogger } from "../../ingest/src/log.ts";

/** The route's `maxDuration`, and the source of the default stream limit. */
export const STREAM_MAX_DURATION_S = 300;
const STREAM_CLOSE_MARGIN_MS = 10_000;

const KEY = "__darkflowIngestCore";
type Holder = { [KEY]?: IngestCore };

export function getIngestCore(): IngestCore {
  const holder = globalThis as unknown as Holder;
  if (holder[KEY]) return holder[KEY];
  const env = {
    ...process.env,
    STREAM_MAX_MS: process.env.STREAM_MAX_MS ?? String(STREAM_MAX_DURATION_S * 1000 - STREAM_CLOSE_MARGIN_MS),
  };
  const core = createIngestCore(loadCoreConfig(env), {
    log: createLogger((line) => {
      // Vercel keeps stdout per invocation; console is the one sink it always shows.
      console.log(line.trimEnd());
    }),
  });
  holder[KEY] = core;
  return core;
}
