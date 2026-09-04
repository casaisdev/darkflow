/**
 * Helpers shared by the generated images (`opengraph-image`, `apple-icon`).
 *
 * Design tokens are duplicated here as literals on purpose: these images are
 * rendered by satori, which never sees `globals.css` and cannot resolve
 * `var(--ghost)`. Keep both in sync — `app/globals.css` is the source of truth.
 */

export const VOID = "#05070a";
export const FIELD = "#070a10";
export const RULE_HAIR = "#131a24";
export const RULE = "#1e2833";
export const SETTLED = "#505050";
export const GHOST_SETTLED = "#b0673a";
export const TEXT_DIM = "#698098";
/** The cold ramp, --t-0 … --t-core, dimmest first. */
export const TRACE = ["#2e3b4a", "#4c6479", "#7794ac", "#a8c8de", "#dceefb", "#f4fbff"];
export const T2 = "#7794ac";
/** --t-2 as rgb components, for gradients that need an alpha stop. */
export const T2_RGB = "119, 148, 172";
export const T3 = "#a8c8de";
export const T4 = "#dceefb";
export const TEXT_NUM = "#8298ac";
export const GHOST = "#ff8a3d";
export const GHOST_CORE = "#ffd9a8";
/** --ghost-halo (#d1541266) split into rgb + alpha, for CSS gradients. */
export const GHOST_HALO_RGB = "209, 84, 18";
export const GHOST_HALO_ALPHA = 0.4;

/** Same feTurbulence as `--grain` in globals.css, as a bare data URI. */
export const GRAIN_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='g'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='120' height='120' filter='url(%23g)'/%3E%3C/svg%3E\")";

/** Old enough that Google Fonts answers with woff instead of woff2. */
const LEGACY_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_6_8) AppleWebKit/537.13 (KHTML, like Gecko) Version/5.1.7 Safari/534.57.2";

/**
 * Fetches a Google Font as woff, subset to `text`.
 *
 * satori needs raw font bytes and cannot read what `next/font` self-hosts, so
 * the file is pulled at build time. Returns `null` when the network is not
 * there; callers fall back to the built-in font rather than failing the build.
 *
 * A silent fallback would ship an off-brand OG card without anyone noticing, so
 * every failure path warns. Watch the build log for "[og]".
 */
export async function loadGoogleFont(
  family: string,
  weight: number,
  text: string,
): Promise<ArrayBuffer | null> {
  const miss = (reason: string) => {
    console.warn(
      `[og] ${family} ${weight} unavailable (${reason}); the generated image will fall back to the default face.`,
    );
    return null;
  };

  // Built by hand: Google rejects a percent-encoded `:` in the family param.
  const query =
    `family=${family.replace(/ /g, "+")}:wght@${weight}` +
    `&text=${encodeURIComponent(text)}`;
  try {
    const cssResponse = await fetch(
      `https://fonts.googleapis.com/css2?${query}`,
      { headers: { "User-Agent": LEGACY_UA } },
    );
    if (!cssResponse.ok) return miss(`css ${cssResponse.status}`);
    const source = /src:\s*url\(([^)]+)\)/.exec(await cssResponse.text())?.[1];
    if (!source) return miss("no font url in css");
    const fontResponse = await fetch(source);
    if (!fontResponse.ok) return miss(`font ${fontResponse.status}`);
    return await fontResponse.arrayBuffer();
  } catch (error) {
    return miss(error instanceof Error ? error.message : "unknown error");
  }
}


/**
 * Outer halo of the three-layer glow, for a square box of side 2r with a 50%
 * border radius.
 *
 * Two corrections over a naive gradient:
 * · Satori resolves an unqualified `radial-gradient(circle, …)` against the
 *   box's farthest corner, so every stop is scaled by 1/√2. That puts zero
 *   alpha exactly on the circle's edge instead of clipping a visible rim.
 * · The falloff is cubic, mirroring HALO_FALLOFF in components/Logo.tsx, so the
 *   glow dies before it can creep back into the 7-unit gap.
 */
const CORNER = 0.7071;
export const HALO_GRADIENT = `radial-gradient(circle, ${[
  [0, 1],
  [0.25, 0.422],
  [0.5, 0.125],
  [0.75, 0.016],
  [1, 0],
]
  .map(
    ([stop, factor]) =>
      `rgba(${GHOST_HALO_RGB}, ${(GHOST_HALO_ALPHA * factor).toFixed(4)})` +
      ` ${(stop * CORNER * 100).toFixed(2)}%`,
  )
  .join(", ")})`;
