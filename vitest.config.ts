import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: ["src/lib/**/*.ts"],
      exclude: [
        "src/lib/**/*.d.ts",
        "src/lib/fixtures/**",
        "src/lib/types.ts",

        // HedgeScope's network/IO glue. These are thin orchestration over
        // providers that already return `Result` — their branches are retry,
        // backoff and degradation paths that can only be reached by mocking the
        // network, and a mock-heavy test of them would assert that the mocks
        // work rather than that the code does. They are verified instead by
        // running a real scan against live Yahoo (see the README), which is the
        // only thing that actually proves them.
        //
        // Everything they orchestrate — the maths, the metrics engine, the
        // scanners, the alerts engine, the AI cache — IS unit-tested with no
        // network at all, which is where the correctness risk lives.
        "src/lib/hedge/scan.ts",
        "src/lib/hedge/scheduler.ts",
        "src/lib/hedge/alerts/slack.ts",
        "src/lib/hedge/providers/yahoo.ts",
        "src/lib/hedge/providers/rates.ts",
        "src/lib/hedge/providers/underlying.ts",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
        // thresholds.ts must be fully covered.
        "src/lib/indicators/thresholds.ts": {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        // The quant layer is where a silent error becomes a wrong trade, so it
        // is held to a higher bar than the app at large.
        "src/lib/hedge/math/**": {
          lines: 90,
          functions: 95,
          branches: 85,
          statements: 90,
        },
      },
    },
  },
});
