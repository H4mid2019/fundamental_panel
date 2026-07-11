import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Config for the live diagnostics. Deliberately separate from vitest.config.ts,
// which includes `tests/unit/**` ONLY: these probes hit Yahoo for real, so they
// must never join the suite that gates a commit. Node environment (no jsdom), no
// setup file, no coverage, and a long timeout because the network is slow.
//
//   npx vitest run --config tests/diagnostics/vitest.probe.config.ts
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/diagnostics/**/*.probe.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
