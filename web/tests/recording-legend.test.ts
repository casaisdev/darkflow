import { describe, expect, it } from "vitest";
import { blockSuffix, recordingSummary } from "@/components/Instrument";
import type { SourceInfo } from "@/types/stream";

/**
 * The two lines under the status that say what a recording is.
 *
 * Small, and tested because the abbreviation is the kind of thing that reads
 * fine and is wrong: a suffix that splits a digit group, or one that drops a
 * leading zero, is a block number nobody can look up.
 */

const info: Extract<SourceInfo, { kind: "recording" }> = {
  kind: "recording",
  chainId: 1,
  capturedAt: "2026-08-26T23:03:41.000Z",
  durationMs: 300_000,
  firstBlock: 25_842_547,
  lastBlock: 25_842_570,
  sources: { pending: ["wss://a.example"], blocks: "wss://a.example" },
  txs: 7640,
  blocks: 24,
};

describe("block suffix", () => {
  it("keeps whole digit groups, so the tail reads back against the head", () => {
    expect(blockSuffix(25_842_547, 25_842_570)).toBe("570");
    expect(blockSuffix(25_842_547, 25_843_001)).toBe("843,001");
    expect(blockSuffix(25_842_547, 25_842_548)).toBe("548");
  });

  it("keeps a leading zero inside the tail", () => {
    // "042" is a real tail; formatting it as a number would read "42".
    expect(blockSuffix(25_842_999, 25_843_042)).toBe("843,042");
  });

  it("gives the whole number when nothing shorter can be read back", () => {
    expect(blockSuffix(25_842_547, 26_000_000)).toBe("26,000,000");
    expect(blockSuffix(999, 1000)).toBe("1,000");
  });

  it("is empty for a single block", () => {
    expect(blockSuffix(7, 7)).toBe("");
  });
});

describe("recording summary", () => {
  it("names the chain, the capture minute in UTC, and the block range", () => {
    expect(recordingSummary(info, 1)).toEqual([
      "mainnet · 2026-08-26 23:03Z",
      "blocks 25,842,547–570",
    ]);
  });

  it("says which pass this is once the recording has restarted", () => {
    expect(recordingSummary(info, 3)[1]).toBe("blocks 25,842,547–570 · pass 3");
    expect(recordingSummary(info, 1)[1]).not.toContain("pass");
  });

  it("does not pretend a chain it does not know is mainnet", () => {
    expect(recordingSummary({ ...info, chainId: 11155111 }, 1)[0]).toContain("chain 11155111");
  });

  it("shows an unparseable timestamp as it came rather than as 1970", () => {
    expect(recordingSummary({ ...info, capturedAt: "yesterday" }, 1)[0]).toBe(
      "mainnet · yesterday",
    );
  });
});
