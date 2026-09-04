import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Test configuration.
 *
 * `node` is the environment everywhere, with no exceptions and no jsdom. That
 * is a deliberate consequence of how this codebase is built rather than a
 * limitation: the simulation is a pure `step(state, dt, now)`, the geometry is
 * arithmetic over a viewport rectangle, and the classifier is a Map. None of it
 * asks the DOM anything. The one part that does — `lib/tokens.ts`, which reads
 * computed styles — is tested through a stub, and the drawing calls are tested
 * against a recording context, so a DOM implementation would add a dependency
 * without adding evidence.
 *
 * The alias is written out rather than read from tsconfig, because resolving
 * tsconfig paths in Vite needs a plugin, and a plugin is a dependency. There is
 * exactly one path mapping and it is asserted in `tests/config.test.ts`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests here assert exact numbers from a seeded PRNG. A retry would hide a
    // real determinism failure, which is the thing most worth catching.
    retry: 0,
    // The ratio tests drive sixty simulated blocks of a 300 tx/s generator on
    // fake timers, twice. Running it at a reduced rate would be faster and
    // would also stop testing the generator anyone actually looks at.
    testTimeout: 30_000,
  },
});
