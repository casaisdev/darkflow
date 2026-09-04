import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/**
 * Served at /sitemap.xml. Two entries, which a crawler would find on its own —
 * it is here so that `robots.txt` can point at something real and so further
 * routes have somewhere to land when they arrive.
 *
 * No `lastModified`: it would report a fresh date on every build whether or not
 * anything changed, which is worse than saying nothing.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE_URL}/notes`, changeFrequency: "monthly", priority: 0.5 },
  ];
}
