import { describe, expect, it } from "vitest";
import * as stream from "@/app/api/stream/route";
import * as state from "@/app/api/state/route";
import * as health from "@/app/api/health/route";
import { STREAM_MAX_DURATION_S } from "@/lib/ingest-core";

/**
 * The route handlers are thin; what matters is their segment config: the
 * Node runtime (the core needs sockets), no caching of a live stream, and a
 * maxDuration the stream limit is derived from, so the two cannot drift.
 */
describe("the live feed routes", () => {
  it("declare the Node runtime, no caching, and a stream duration the core closes under", () => {
    for (const route of [stream, state, health]) {
      expect(route.runtime).toBe("nodejs");
      expect(route.dynamic).toBe("force-dynamic");
      expect(typeof route.GET).toBe("function");
    }
    expect(stream.maxDuration).toBe(STREAM_MAX_DURATION_S);
    expect(STREAM_MAX_DURATION_S).toBeLessThanOrEqual(300); // the Hobby ceiling
  });
});
