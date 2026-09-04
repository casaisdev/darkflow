import { parseDurationMs, parseEasing, type EasingFn } from "@/lib/easing";

/**
 * Reads the design system out of CSS, once, at mount.
 *
 * `app/globals.css` is the single source of truth for every colour and
 * duration. The canvas cannot resolve `var(--ghost)`, so the values are pulled
 * from computed style and cached. Reading them per frame would be a layout
 * query per frame; reading them once means a token change needs a reload,
 * which is the right trade for a value that only changes when a human edits a
 * stylesheet.
 */

export type Rgb = { r: number; g: number; b: number; a: number };

/** Every colour the canvas draws with, pre-parsed to channels. */
export type Palette = {
  void: Rgb;
  field: Rgb;
  sunken: Rgb;
  /** The cold luminance ramp, index 0 dimmest. Rule 2: fee maps onto this. */
  trace: readonly [Rgb, Rgb, Rgb, Rgb, Rgb, Rgb];
  settled: Rgb;
  /** Brighter cold tone: the block cap, the scale band, the gas reference. */
  settledHi: Rgb;
  ghost: Rgb;
  ghostCore: Rgb;
  ghostHalo: Rgb;
  /** Private flow at rest in the block. Matte. See globals.css. */
  ghostSettled: Rgb;
  ruleHair: Rgb;
  rule: Rgb;
  ruleLit: Rgb;
  text: Rgb;
  textNum: Rgb;
  textDim: Rgb;
  live: Rgb;
  calib: Rgb;
  dead: Rgb;
};

export type Motion = {
  /** τ for the exponential alpha decay of a pending trace. */
  decayTraceMs: number;
  /** How long a seen transaction takes to fly to its slot in the block. */
  landBlockMs: number;
  /** How long a ghost takes to appear. No trajectory, just presence. */
  ghostAppearMs: number;
  pulseLiveMs: number;
  landEase: EasingFn;
};

export type Tokens = { palette: Palette; motion: Motion };

const OPAQUE_BLACK: Rgb = { r: 0, g: 0, b: 0, a: 1 };

/**
 * Parses `#rgb`, `#rrggbb` and `#rrggbbaa`. The design system uses the last
 * form for `--ghost-halo`, whose alpha is part of the token.
 */
export function parseHex(value: string): Rgb {
  const hex = value.trim().replace(/^#/, "");
  const expand = (part: string) => Number.parseInt(part, 16);

  if (hex.length === 3) {
    return {
      r: expand(hex[0] + hex[0]),
      g: expand(hex[1] + hex[1]),
      b: expand(hex[2] + hex[2]),
      a: 1,
    };
  }
  if (hex.length === 6 || hex.length === 8) {
    return {
      r: expand(hex.slice(0, 2)),
      g: expand(hex.slice(2, 4)),
      b: expand(hex.slice(4, 6)),
      a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
    };
  }
  console.warn(`[tokens] could not parse colour "${value}"`);
  return OPAQUE_BLACK;
}

/** `rgba()` string for a colour at an explicit alpha. */
export function rgba(colour: Rgb, alpha: number = colour.a): string {
  return `rgba(${colour.r}, ${colour.g}, ${colour.b}, ${alpha})`;
}

/**
 * Mixes towards grey. Used by the calibration state, which desaturates the
 * canvas by recolouring its cached palette rather than by putting a CSS filter
 * over a surface that repaints every frame.
 */
export function desaturate(colour: Rgb, amount: number): Rgb {
  const luma = 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
  const mix = (channel: number) => Math.round(channel + (luma - channel) * amount);
  return { r: mix(colour.r), g: mix(colour.g), b: mix(colour.b), a: colour.a };
}

export function desaturatePalette(palette: Palette, amount: number): Palette {
  const shift = (colour: Rgb) => desaturate(colour, amount);
  return {
    ...palette,
    trace: palette.trace.map(shift) as unknown as Palette["trace"],
    settled: shift(palette.settled),
    settledHi: shift(palette.settledHi),
    // --ghost is deliberately not shifted here: during calibration it is not
    // drawn at all, so there is nothing to desaturate. Rule 1.
  };
}

export function readTokens(
  root: HTMLElement = document.documentElement,
): Tokens {
  const style = getComputedStyle(root);
  const colour = (name: string) => parseHex(style.getPropertyValue(name));
  const duration = (name: string, fallback: number) =>
    parseDurationMs(style.getPropertyValue(name), fallback);

  const palette: Palette = {
    void: colour("--void"),
    field: colour("--field"),
    sunken: colour("--sunken"),
    trace: [
      colour("--t-0"),
      colour("--t-1"),
      colour("--t-2"),
      colour("--t-3"),
      colour("--t-4"),
      colour("--t-core"),
    ],
    settled: colour("--settled"),
    settledHi: colour("--settled-hi"),
    ghost: colour("--ghost"),
    ghostCore: colour("--ghost-core"),
    ghostHalo: colour("--ghost-halo"),
    ghostSettled: colour("--ghost-settled"),
    ruleHair: colour("--rule-hair"),
    rule: colour("--rule"),
    ruleLit: colour("--rule-lit"),
    text: colour("--text"),
    textNum: colour("--text-num"),
    textDim: colour("--text-dim"),
    live: colour("--live"),
    calib: colour("--calib"),
    dead: colour("--dead"),
  };

  const motion: Motion = {
    decayTraceMs: duration("--decay-trace", 8000),
    landBlockMs: duration("--land-block", 420),
    ghostAppearMs: duration("--ghost-appear", 180),
    pulseLiveMs: duration("--pulse-live", 2400),
    landEase: parseEasing(style.getPropertyValue("--land-ease")),
  };

  return Object.freeze({ palette, motion });
}
