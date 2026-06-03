import { fileURLToPath } from "node:url";

import bundleAnalyzer from "@next/bundle-analyzer";
import type { NextConfig } from "next";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Self-contained server output for small, portable Docker images.
  output: "standalone",
  // Pin the workspace root to this project (a stray lockfile may exist above).
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // yahoo-finance2 is a Node-only library; keep it out of the bundler graph.
  serverExternalPackages: ["yahoo-finance2"],
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
