import { describe, expect, it } from "vitest";
import { fetchCoverage, parseCoverage, stateUrlFor } from "@/lib/stream/coverage";

describe("the state endpoint next to the stream", () => {
  it("is /state beside /stream, for a path or a full URL", () => {
    expect(stateUrlFor("/api/stream")).toBe("/api/state");
    expect(stateUrlFor("https://ingest.example/stream")).toBe("https://ingest.example/state");
  });
  it("is nothing for a URL that is not the ingest's", () => {
    expect(stateUrlFor("")).toBeNull();
    expect(stateUrlFor("https://ingest.example/feed")).toBeNull();
    expect(stateUrlFor("/api/streamer")).toBeNull();
  });
});

describe("the coverage out of the state document", () => {
  const AT = 1_800_000_000_000;
  it("reads the recent share and its window", () => {
    expect(parseCoverage({ coverage: { recent: { blocks: 10, rows: 2751, seen: 1363, pct: 49.5 } } }, AT)).toEqual({ pct: 49.5, blocks: 10, at: AT });
  });
  it("says unknown, not zero, when there are no blocks yet", () => {
    expect(parseCoverage({ coverage: { recent: { blocks: 0, rows: 0, seen: 0, pct: null } } }, AT)).toEqual({ pct: null, blocks: 0, at: AT });
  });
  it("refuses a document without the figure or with a figure that cannot be a share", () => {
    expect(parseCoverage(null, AT)).toBeNull();
    expect(parseCoverage({}, AT)).toBeNull();
    expect(parseCoverage({ coverage: {} }, AT)).toBeNull();
    expect(parseCoverage({ coverage: { recent: { blocks: 3, pct: "49" } } }, AT)).toBeNull();
    expect(parseCoverage({ coverage: { recent: { blocks: 3, pct: 140 } } }, AT)).toBeNull();
    expect(parseCoverage({ coverage: { recent: { blocks: -1, pct: 10 } } }, AT)).toBeNull();
  });
});

describe("fetching it", () => {
  it("returns the parsed figure on 200 and null on anything else", async () => {
    const ok = async () => ({ ok: true, json: async () => ({ coverage: { recent: { blocks: 4, pct: 52 } } }) });
    expect(await fetchCoverage("/api/state", () => 7, ok)).toEqual({ pct: 52, blocks: 4, at: 7 });
    const down = async () => ({ ok: false, json: async () => ({}) });
    expect(await fetchCoverage("/api/state", () => 7, down)).toBeNull();
    const throws = async () => {
      throw new Error("offline");
    };
    expect(await fetchCoverage("/api/state", () => 7, throws)).toBeNull();
  });
  it("asks without a cache: a cached share would be a claim about then", async () => {
    let init: RequestInit | null = null;
    await fetchCoverage("/api/state", () => 0, async (_u, i) => {
      init = i;
      return { ok: true, json: async () => ({}) };
    });
    expect(init).toEqual({ cache: "no-store" });
  });
});
