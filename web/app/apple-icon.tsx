import { ImageResponse } from "next/og";
import {
  GHOST,
  GHOST_CORE,
  HALO_GRADIENT,
  T2,
  T3,
  VOID,
} from "@/lib/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Apple touch icon: the compact mark (x 12→24 of the trace plus the dot) on a
 * --void tile. Drawn with boxes rather than SVG because satori only renders a
 * subset of CSS and no SVG filters.
 *
 * Grid maths: the 20×20 crop of the logo grid, inset by PAD, at UNIT px each.
 */
const PAD = 20;
const UNIT = (size.width - PAD * 2) / 20;
/** Grid x → px. The crop starts at x=12. */
const px = (x: number) => (x - 12) * UNIT + PAD;
/** Grid y → px. The crop starts at y=-4. */
const py = (y: number) => (y + 4) * UNIT + PAD;
/** A circle of grid radius r centred on a grid point. */
const disc = (cx: number, cy: number, r: number) => ({
  position: "absolute" as const,
  left: px(cx) - r * UNIT,
  top: py(cy) - r * UNIT,
  width: r * UNIT * 2,
  height: r * UNIT * 2,
  borderRadius: r * UNIT * 2,
});

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          backgroundColor: VOID,
        }}
      >
        {/* trace: cut clean at x=17 */}
        <div
          style={{
            position: "absolute",
            left: px(12),
            top: py(6) - UNIT,
            width: (17 - 12) * UNIT,
            height: 2 * UNIT,
            backgroundImage: `linear-gradient(to right, ${T2}, ${T3})`,
          }}
        />
        {/* the dot: halo, body, core */}
        <div
          style={{
            ...disc(26.5, 6, 5.5),
            backgroundImage: HALO_GRADIENT,
          }}
        />
        <div style={{ ...disc(26.5, 6, 2.6), backgroundColor: GHOST }} />
        <div style={{ ...disc(26.5, 6, 1), backgroundColor: GHOST_CORE }} />
      </div>
    ),
    { ...size },
  );
}
