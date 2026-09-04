import { describe, expect, it } from "vitest";
import { effectivePriorityFee, offeredFee } from "@/lib/fees";
import { eip1559, legacy } from "./helpers";

/**
 * Fee arithmetic, which decides where every mark sits on the vertical axis.
 *
 * Rule 2 of the design system: fee maps to luminance, age maps to alpha, and
 * the two never cross. That makes this the function the entire cold ramp is
 * built on — a transaction ranked wrong is drawn at the wrong height and the
 * wrong brightness, and nothing on screen would reveal it.
 */

const GWEI = 1e9;

describe("effectivePriorityFee", () => {
  describe("EIP-1559", () => {
    it("pays the offered tip when the cap has room for it", () => {
      expect(effectivePriorityFee(eip1559(2, 30), 12 * GWEI)).toBe(2 * GWEI);
    });

    it("caps the tip at what is left of maxFeePerGas after the base fee", () => {
      // Advertises 50 gwei of tip under a 14 gwei ceiling: it pays 2, not 50.
      // Ranking on maxPriorityFeePerGas alone would put this transaction at
      // the bright top of the field while it is barely competitive.
      expect(effectivePriorityFee(eip1559(50, 14), 12 * GWEI)).toBe(2 * GWEI);
    });

    it("is exactly zero when the cap only covers the base fee", () => {
      expect(effectivePriorityFee(eip1559(5, 12), 12 * GWEI)).toBe(0);
    });

    it("clamps below the base fee rather than going negative", () => {
      // Not includable at all. A negative value has no place on a luminance
      // ramp, and would sort below zero-tip transactions rather than with them.
      expect(effectivePriorityFee(eip1559(5, 8), 12 * GWEI)).toBe(0);
    });
  });

  describe("legacy", () => {
    it("takes the tip as whatever gasPrice clears the base fee by", () => {
      expect(effectivePriorityFee(legacy(15), 12 * GWEI)).toBe(3 * GWEI);
    });

    it("clamps a below-base gasPrice to zero", () => {
      expect(effectivePriorityFee(legacy(9), 12 * GWEI)).toBe(0);
    });
  });

  it("ranks the two shapes against each other on the same quantity", () => {
    const base = 12 * GWEI;
    // A legacy transaction at 15 gwei and a 1559 one offering 3 gwei of tip
    // under a generous cap are paying the same thing and must rank equal.
    expect(effectivePriorityFee(legacy(15), base)).toBe(
      effectivePriorityFee(eip1559(3, 40), base),
    );
  });

  it("moves with the base fee, which is why it is recomputed every block", () => {
    const fees = eip1559(5, 15);
    expect(effectivePriorityFee(fees, 8 * GWEI)).toBe(5 * GWEI);
    expect(effectivePriorityFee(fees, 12 * GWEI)).toBe(3 * GWEI);
    expect(effectivePriorityFee(fees, 15 * GWEI)).toBe(0);
  });
});

describe("offeredFee", () => {
  it("reads the cap for 1559 and the price for legacy", () => {
    expect(offeredFee(eip1559(2, 30))).toBe(30 * GWEI);
    expect(offeredFee(legacy(15))).toBe(15 * GWEI);
  });

  it("is not a substitute for the effective fee", () => {
    // Used only for pool eviction, which ranks arrivals before any base fee is
    // known. These two orderings disagree, and that disagreement is the reason
    // the field is laid out on one and evicted on the other.
    const tight = eip1559(50, 14); // huge tip, tight cap
    const loose = eip1559(1, 40); // small tip, generous cap
    expect(offeredFee(loose)).toBeGreaterThan(offeredFee(tight));
    expect(effectivePriorityFee(loose, 12 * GWEI)).toBeLessThan(
      effectivePriorityFee(tight, 12 * GWEI),
    );
  });
});
