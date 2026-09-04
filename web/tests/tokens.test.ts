import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desaturate,
  desaturatePalette,
  parseHex,
  readTokens,
  rgba,
  type Rgb,
} from "@/lib/tokens";
import { palette } from "./helpers";

/**
 * The bridge between the stylesheet and the canvas.
 *
 * `app/globals.css` is the single source of truth for every colour and every
 * duration in this project, and canvas cannot read CSS. Everything on screen
 * therefore passes through these functions once at mount. A wrong parse here
 * does not throw and does not look broken — it produces a slightly different
 * colour than the one the design system specifies, forever, and every
 * measurement taken against the screen after that is measuring the wrong thing.
 */

describe("parseHex", () => {
  it("reads the three forms the design system uses", () => {
    expect(parseHex("#2b3a4a")).toEqual({ r: 43, g: 58, b: 74, a: 1 });
    // Shorthand expands by duplication, not by padding: #abc is #aabbcc.
    expect(parseHex("#abc")).toEqual({ r: 170, g: 187, b: 204, a: 1 });
    // Eight digits carry alpha, which --ghost-halo depends on.
    expect(parseHex("#d67a3d80")).toEqual({
      r: 214,
      g: 122,
      b: 61,
      a: 128 / 255,
    });
  });

  it("does not pad shorthand with zeros", () => {
    // The specific wrong implementation: "#abc" → r: 0xa0. It would darken
    // every shorthand token by about a third and look plausible.
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseHex("#fff").r).not.toBe(240);
  });

  it("tolerates what getComputedStyle actually returns", () => {
    // Computed custom properties commonly come back with leading whitespace,
    // and the leading # is optional in the token file.
    expect(parseHex("  #2b3a4a  ")).toEqual(parseHex("#2b3a4a"));
    expect(parseHex("2b3a4a")).toEqual(parseHex("#2b3a4a"));
  });

  it("falls back to opaque black and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Not silently: a colour that parses to something arbitrary would be a
    // design-system bug that nobody could trace back to a token.
    expect(parseHex("")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseHex("#12345")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseHex("rebeccapurple")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("round-trips every colour in the live stylesheet", () => {
    // Rule 3: the ground is --void, never #000. If any of these came back as
    // opaque black the fallback would have fired and nothing would have said so
    // outside a console nobody reads.
    for (const token of ["#05070a", "#090c12", "#3d5366", "#46617a", "#d67a3d"]) {
      const parsed = parseHex(token);
      const back =
        "#" +
        [parsed.r, parsed.g, parsed.b]
          .map((c) => c.toString(16).padStart(2, "0"))
          .join("");
      expect(back).toBe(token);
    }
  });
});

describe("rgba", () => {
  const colour: Rgb = { r: 43, g: 58, b: 74, a: 0.5 };

  it("uses the colour's own alpha unless given one", () => {
    expect(rgba(colour)).toBe("rgba(43, 58, 74, 0.5)");
    expect(rgba(colour, 1)).toBe("rgba(43, 58, 74, 1)");
    // Zero is an alpha, not a missing argument. A default that treated it as
    // absent would make every fully-transparent gradient stop opaque.
    expect(rgba(colour, 0)).toBe("rgba(43, 58, 74, 0)");
  });
});

describe("desaturate", () => {
  it("does nothing at zero and goes fully grey at one", () => {
    const c: Rgb = { r: 214, g: 122, b: 61, a: 1 };
    expect(desaturate(c, 0)).toEqual(c);
    const grey = desaturate(c, 1);
    expect(grey.r).toBe(grey.g);
    expect(grey.g).toBe(grey.b);
  });

  it("holds luminance while it removes chroma", () => {
    // The point of mixing toward luma rather than toward a fixed grey: the
    // calibrating canvas must lose colour without also losing or gaining
    // brightness, or the whole field would appear to dim on connect.
    const luma = (c: Rgb) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    for (const c of [palette.ghost, palette.settled, palette.trace[3]]) {
      const before = luma(c);
      for (const amount of [0.2, 0.4, 0.6, 1]) {
        // Within rounding to whole channels.
        expect(luma(desaturate(c, amount))).toBeCloseTo(before, 0);
      }
    }
  });

  it("preserves alpha", () => {
    expect(desaturate({ r: 214, g: 122, b: 61, a: 0.35 }, 0.5).a).toBe(0.35);
  });

  it("returns whole channels", () => {
    const c = desaturate({ r: 214, g: 122, b: 61, a: 1 }, 0.4);
    for (const channel of [c.r, c.g, c.b]) {
      expect(Number.isInteger(channel)).toBe(true);
    }
  });
});

describe("desaturatePalette", () => {
  it("leaves --ghost untouched, because calibration never draws it", () => {
    const dim = desaturatePalette(palette, 0.4);
    // Rule 1. During warm-up the accent is not drawn at all, so there is
    // nothing to desaturate — and a desaturated --ghost sitting in the cached
    // palette is a warm colour one bug away from reaching the screen.
    expect(dim.ghost).toEqual(palette.ghost);
    expect(dim.ghostCore).toEqual(palette.ghostCore);
    expect(dim.ghostSettled).toEqual(palette.ghostSettled);
  });

  it("desaturates the cold ramp and the settled tones", () => {
    const dim = desaturatePalette(palette, 0.6);
    expect(dim.settled).not.toEqual(palette.settled);
    expect(dim.settledHi).not.toEqual(palette.settledHi);
    expect(dim.trace).toHaveLength(palette.trace.length);
    for (let i = 0; i < palette.trace.length; i++) {
      expect(dim.trace[i]).toEqual(desaturate(palette.trace[i], 0.6));
    }
  });

  it("does not mutate the palette it was given", () => {
    // The engine holds both variants for the life of the session and swaps a
    // pointer. Mutating in place would make the swap one-way.
    const before = structuredClone(palette);
    desaturatePalette(palette, 1);
    expect(palette).toEqual(before);
  });
});

describe("readTokens", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Minimal stand-in for the one call `readTokens` makes into the DOM. */
  function stubComputedStyle(values: Record<string, string>) {
    vi.stubGlobal("getComputedStyle", () => ({
      getPropertyValue: (name: string) => values[name] ?? "",
    }));
  }

  it("reads colours and durations off the element it is given", () => {
    stubComputedStyle({
      "--void": "#05070a",
      "--settled": "#3d5366",
      "--ghost-halo": "#d67a3d80",
      "--decay-trace": "8s",
      "--land-block": "420ms",
      "--land-ease": "cubic-bezier(.16,.84,.28,1)",
    });
    const tokens = readTokens({} as HTMLElement);
    expect(tokens.palette.void).toEqual({ r: 5, g: 7, b: 10, a: 1 });
    expect(tokens.palette.settled).toEqual({ r: 61, g: 83, b: 102, a: 1 });
    expect(tokens.palette.ghostHalo.a).toBeCloseTo(128 / 255, 6);
    expect(tokens.motion.decayTraceMs).toBe(8000);
    expect(tokens.motion.landBlockMs).toBe(420);
    // The curve came through as a curve, not as the linear fallback.
    expect(tokens.motion.landEase(0.35)).not.toBeCloseTo(0.35, 2);
  });

  it("falls back on every duration it cannot read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubComputedStyle({});
    const tokens = readTokens({} as HTMLElement);
    // Documented defaults, so a stylesheet that failed to load still animates
    // at the speeds the design specifies rather than at zero.
    expect(tokens.motion.decayTraceMs).toBe(8000);
    expect(tokens.motion.landBlockMs).toBe(420);
    expect(tokens.motion.ghostAppearMs).toBe(180);
    expect(tokens.motion.pulseLiveMs).toBe(2400);
    warn.mockRestore();
  });

  it("returns a frozen object", () => {
    stubComputedStyle({ "--void": "#05070a" });
    const tokens = readTokens({} as HTMLElement);
    // Read once at mount and held for the session. Anything that could write
    // to it would be changing the design system at runtime.
    expect(Object.isFrozen(tokens)).toBe(true);
  });
});

describe("the four text tiers", () => {
  /**
   * Brightness says how live a thing is, not how important it is.
   *
   * Measured before this was a rule: 17 distinct type registers, six text
   * luminances, no stated meaning for any of them. The panel's live readouts
   * came out at 30.2% relative luminance while the region names above them sat
   * at 56.9%, so the number you were meant to read was dimmer than the word
   * naming where to read it. The wordmark, the least live thing on the page,
   * was the brightest text on it at 83.3% — and was painted with `--t-4`, a
   * stop on the fee ramp.
   *
   * Read from the stylesheet rather than from a copy, because a copy would let
   * the two drift and this test would then be checking itself.
   */
  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  function token(name: string): Rgb {
    // Line scan rather than a regex: the escaping in a template literal is one
    // more thing to get wrong, and this test exists to catch drift, not to
    // introduce it.
    const prefix = `--${name}:`;
    for (const line of css.split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(prefix)) continue;
      const value = trimmed.slice(prefix.length).trim();
      if (!value.startsWith("#")) continue;
      return parseHex(value.split(";")[0].trim());
    }
    throw new Error(`token not found: --${name}`);
  }

  /** WCAG relative luminance. The channel curve is not optional here. */
  function relative(colour: Rgb): number {
    const channel = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return (
      0.2126 * channel(colour.r) +
      0.7152 * channel(colour.g) +
      0.0722 * channel(colour.b)
    );
  }

  it("orders the tiers by how live the thing is", () => {
    const reading = relative(token("ghost-core"));
    const live = relative(token("text"));
    const engraved = relative(token("text-num"));
    const annotation = relative(token("text-dim"));
    expect(reading).toBeGreaterThan(live);
    expect(live).toBeGreaterThan(engraved);
    expect(engraved).toBeGreaterThan(annotation);
  });

  it("keeps every tier legible on the ground", () => {
    // Rule 3 fixes the ground at --void. AA for normal text is 4.5:1.
    const ground = relative(token("void"));
    for (const name of ["text", "text-num", "text-dim", "ghost-core"]) {
      const ratio = (relative(token(name)) + 0.05) / (ground + 0.05);
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("never paints chrome with a colour from the fee ramp", () => {
    // Rule 2: the cold ramp carries fee priority and nothing else. A wordmark
    // or a label in --t-N is the apparatus borrowing the vocabulary it uses to
    // make claims about the data.
    const chrome = ["Logo.tsx", "Instrument.tsx", "StatusIndicator.tsx"].map(
      (file) =>
        readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8"),
    );
    for (const source of chrome) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(stripped).not.toMatch(/className="[^"]*\btext-t-\d/);
    }
  });
});

describe("the settled material", () => {
  const css = readFileSync(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  function token(name: string): Rgb {
    const prefix = `--${name}:`;
    for (const line of css.split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (!trimmed.startsWith(prefix)) continue;
      const value = trimmed.slice(prefix.length).trim();
      if (!value.startsWith("#")) continue;
      return parseHex(value.split(";")[0].trim());
    }
    throw new Error(`token not found: --${name}`);
  }

  /** The metric this project calibrates in. Not perceptual, but consistent. */
  const raw = (c: Rgb) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

  it("is neutral, so the block is a different substance from the field", () => {
    /**
     * It was #3d5366 and #46617a — hue about 207 degrees, against a cold ramp
     * at about 235. The same family, so the block read as a faded mempool
     * rather than as another material, and "pending glows, confirmed weighs"
     * was said in the words and not in the substances.
     */
    for (const name of ["settled", "settled-hi"]) {
      const c = token(name);
      expect(c.r).toBe(c.g);
      expect(c.g).toBe(c.b);
    }
  });

  it("keeps the luminances the block was calibrated at", () => {
    // #3d5366 measured 79.69 and #46617a measured 93.06. Every calibrated
    // relationship in the block rests on these two numbers, so the neutrals
    // had to land on them rather than merely near them.
    expect(raw(token("settled"))).toBeCloseTo(79.69, 0);
    expect(raw(token("settled-hi"))).toBeCloseTo(93.06, 0);
  });

  it("never lets a cold tone reach the brightness of private flow at rest", () => {
    /**
     * The stated reason --settled-hi sits where it does: one step up lands at
     * 116.5 against --ghost-settled's 115.3. Nothing guarded it, and the
     * neutral swap is exactly the kind of change that could have broken it
     * silently.
     */
    expect(raw(token("settled-hi"))).toBeLessThan(raw(token("ghost-settled")));
  });

  it("keeps the chamber's ground above the void it dissolves into", () => {
    /**
     * The chamber-to-crossing boundary is the only one of the three that has a
     * separator, and the separator is this tint dissolving. Measured on an
     * emptied chamber, --field at #06080e left an amplitude of 0.22 against the
     * void, which is not a boundary. The margin is what is being guarded here,
     * not the exact value.
     */
    expect(raw(token("field")) - raw(token("void"))).toBeGreaterThan(2);
  });
});
