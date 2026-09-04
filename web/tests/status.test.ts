import { describe, expect, it } from "vitest";
import {
  FALLBACK_AFTER_S,
  NARROW_BELOW_PX,
  tickYieldsToUnit,
  cursorReadingAt,
  TXS_SILENT_AFTER_S,
  STALE_AFTER_S,
  explorerTxUrl,
  shouldFallBack,
  streamStatusOf,
} from "@/components/Instrument";
import { calibrationLabel } from "@/components/CalibrationBar";
import { FLOOR_BAND } from "@/lib/canvas/layout";
import type { LinkState } from "@/types/stream";

/**
 * What the dot says, and when the recording stands in.
 *
 * Pure rules extracted from the chrome so they can be tested without a
 * stream. Each of these encodes a claim the page makes about itself, and a
 * wrong one is the quiet kind of failure this project keeps finding: a page
 * that says "live" over a dropped socket is plausible for exactly as long as
 * nobody checks.
 */

const base = {
  failure: null as string | null,
  hasSample: true,
  sourceName: "sse" as const,
  stale: false,
  link: "open" as LinkState | null,
  calibrating: false,
};

describe("the status", () => {
  it("says live only for a live feed that is actually flowing", () => {
    expect(streamStatusOf(base)).toBe("live");
  });

  it("says reconnecting the moment the source says so", () => {
    // Not after enough silence to be called stale — that is the whole point
    // of the link hook. For those seconds the page used to say "live".
    expect(streamStatusOf({ ...base, link: "reconnecting" })).toBe(
      "reconnecting",
    );
  });

  it("calls silence down, whatever the link claims", () => {
    // A socket can be open to an ingest that has stopped speaking. Silence
    // outranks the link's optimism; only the link's own bad news outranks
    // silence.
    expect(streamStatusOf({ ...base, stale: true })).toBe("down");
    expect(streamStatusOf({ ...base, stale: true, link: "open" })).toBe("down");
    expect(streamStatusOf({ ...base, link: "closed" })).toBe("down");
  });

  it("lets provenance outrank health", () => {
    // A green dot over data that is not the chain now is the one claim this
    // page must never make.
    expect(streamStatusOf({ ...base, sourceName: "synthetic", link: null })).toBe(
      "simulated",
    );
    expect(streamStatusOf({ ...base, sourceName: "replay", link: null })).toBe(
      "recorded",
    );
  });

  it("reports calibration before provenance", () => {
    expect(streamStatusOf({ ...base, calibrating: true })).toBe("calibrating");
    expect(
      streamStatusOf({ ...base, sourceName: "replay", calibrating: true }),
    ).toBe("calibrating");
  });

  it("distinguishes a recording loading from a feed connecting", () => {
    expect(streamStatusOf({ ...base, hasSample: false })).toBe("connecting");
    expect(
      streamStatusOf({ ...base, hasSample: false, sourceName: "replay" }),
    ).toBe("loading");
  });

  it("lets a failure beat everything", () => {
    expect(
      streamStatusOf({ ...base, failure: "gone", calibrating: true }),
    ).toBe("down");
  });
});

describe("falling back to the recording", () => {
  const inputs = {
    configured: true,
    fallback: false,
    failure: null as string | null,
    staleSeconds: null as number | null,
  };

  it("waits out ordinary silence", () => {
    expect(shouldFallBack({ ...inputs, staleSeconds: FALLBACK_AFTER_S })).toBe(
      false,
    );
    expect(
      shouldFallBack({ ...inputs, staleSeconds: FALLBACK_AFTER_S + 1 }),
    ).toBe(true);
  });

  it("does not wait when the source says it cannot deliver at all", () => {
    expect(shouldFallBack({ ...inputs, failure: "no url" })).toBe(true);
  });

  it("never fires on a build with no recording", () => {
    // The chrome must not promise a fallback the build does not have.
    expect(
      shouldFallBack({ ...inputs, configured: false, failure: "gone" }),
    ).toBe(false);
  });

  it("never fires twice", () => {
    // After the switch the source is the recording, and a recording does not
    // fall back to itself.
    expect(
      shouldFallBack({ ...inputs, fallback: true, staleSeconds: 10_000 }),
    ).toBe(false);
  });

  it("keeps its thresholds in the order the design states", () => {
    // "No signal" must be said first, and for long enough to be read, before
    // the page changes what it is showing. The mempool feed's own threshold
    // sits below both, so the per-feed marker is never pre-empted.
    expect(FALLBACK_AFTER_S).toBeGreaterThan(STALE_AFTER_S);
    expect(STALE_AFTER_S).toBeGreaterThan(TXS_SILENT_AFTER_S);
  });
});

describe("the explorer link", () => {
  const hash = "0x00ff";

  it("knows the chains it knows and refuses the rest", () => {
    expect(explorerTxUrl(1, hash)).toBe("https://etherscan.io/tx/0x00ff");
    expect(explorerTxUrl(11155111, hash)).toBe(
      "https://sepolia.etherscan.io/tx/0x00ff",
    );
    // A synthetic hash, or a chain with no explorer configured: no link at
    // all beats a link to a page that says "not found".
    expect(explorerTxUrl(null, hash)).toBeNull();
    expect(explorerTxUrl(424242, hash)).toBeNull();
  });
});

describe("the calibration copy", () => {
  const state = {
    active: true,
    blocksObserved: 2,
    warmupBlocks: 5,
    closedBy: null,
  };

  it("says it is waiting for the snapshot on a source that sends one", () => {
    expect(calibrationLabel(state, true)).toBe(
      "Waiting for the pool snapshot · block 2/5 without it",
    );
  });

  it("counts blocks plainly where no snapshot is coming", () => {
    expect(calibrationLabel(state, false)).toBe("Calibrating · Block 2/5");
  });

  it("never counts past the target", () => {
    expect(
      calibrationLabel({ ...state, blocksObserved: 9 }, false),
    ).toBe("Calibrating · Block 5/5");
  });
});

describe("the numeral under the axis unit", () => {
  /**
   * On a narrow screen the unit moves to the head of the scale, and the
   * topmost tick numeral can land under it. Measured at 390x844: "GWEI" and
   * "1.5" overlapped by most of a line. The numeral yields; the rule stays.
   */
  it("yields only near the head, and only on narrow screens", () => {
    const at = (viewWidth: number, tickHeight: number) =>
      tickYieldsToUnit({ viewWidth, viewHeight: 844, tickHeight });
    expect(at(390, 0.01)).toBe(true);
    expect(at(390, 0.1)).toBe(false);
    // On the wide layout the unit is at the foot and nothing yields.
    expect(at(NARROW_BELOW_PX, 0.01)).toBe(false);
  });
});

describe("the cursor over the floor band", () => {
  const range = { lowGwei: 0.001, highGwei: 10 };
  it("reads a fee on the axis and none inside the band", () => {
    expect(cursorReadingAt(0, range)).toEqual({ kind: "gwei", gwei: expect.closeTo(10, 6) });
    const top = cursorReadingAt(1 - FLOOR_BAND - 1e-9, range);
    expect(top.kind).toBe("gwei");
    if (top.kind === "gwei") expect(top.gwei).toBeCloseTo(0.001, 6);
    expect(cursorReadingAt(1 - FLOOR_BAND, range)).toEqual({ kind: "floor" });
    expect(cursorReadingAt(1, range)).toEqual({ kind: "floor" });
  });
});
