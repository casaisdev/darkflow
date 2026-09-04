import type { MetadataRoute } from "next";
import { DESCRIPTION, SITE_NAME, TITLE } from "@/lib/site";

/**
 * Written as `manifest.ts` rather than a literal `manifest.json` so the shape
 * is type-checked against `MetadataRoute.Manifest`. Next serves it at
 * /manifest.webmanifest and links it from <head> on its own.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: TITLE,
    short_name: SITE_NAME,
    description: DESCRIPTION,
    start_url: "/",
    display: "standalone",
    background_color: "#05070a",
    theme_color: "#05070a",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/favicon.ico", sizes: "48x48 32x32 16x16", type: "image/x-icon" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png" },
    ],
  };
}
