import { describe, expect, it } from "vitest";
import * as api from "@/app/api/[endpoint]/route";
import { STREAM_MAX_DURATION_S } from "@/lib/ingest-core";

/**
 * One route handler for the three live-feed paths, on purpose: on Vercel a
 * route file is a function with its own instance, and the core lives in
 * module state, so `/api/state` can only describe the stream if it runs in
 * the same function. What matters here is the segment config: the Node
 * runtime (the core needs sockets), no caching of a live stream, and a
 * maxDuration the stream limit is derived from, so the two cannot drift.
 */
describe("the live feed route", () => {
  it("declares the Node runtime, no caching, and a stream duration the core closes under", () => {
    expect(api.runtime).toBe("nodejs");
    expect(api.dynamic).toBe("force-dynamic");
    expect(typeof api.GET).toBe("function");
    expect(api.maxDuration).toBe(STREAM_MAX_DURATION_S);
    expect(STREAM_MAX_DURATION_S).toBeLessThanOrEqual(300); // the Hobby ceiling
  });

  it("answers 404 for a path it does not serve, and never with a cacheable body", async () => {
    const res = await api.GET(new Request("http://site.example/api/nope"), { params: Promise.resolve({ endpoint: "nope" }) });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
