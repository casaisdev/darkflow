import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

// The repository root, one level up. The ingest's core lives in ../ingest and
// the route handlers under app/api import it directly; Turbopack resolves
// nothing outside its root unless told where the root is, and output file
// tracing has to include those files for the deployed functions.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const nextConfig: NextConfig = {
  turbopack: { root: repoRoot },
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
