#!/usr/bin/env node
/**
 * Trigger a HedgeScope scan against a running server.
 *
 *   npm run hedge:scan                      # localhost:3000
 *   HEDGE_URL=http://127.0.0.1:3500 npm run hedge:scan
 *
 * A scan needs the server's SQLite handle, its Redis lock and its provider
 * cache, so it runs *inside* the app rather than in a second process that would
 * open a competing database connection. This script is therefore a thin HTTP
 * client, not a re-implementation.
 *
 * Reads HEDGE_SCAN_SECRET from the environment or from `.env` / `.env.local`,
 * exactly as `scripts/check-apis.mjs` does.
 */

import { readFileSync } from "node:fs";

/** Minimal .env reader — no dependency, and never overrides a real env var. */
function loadEnv(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key]) continue;
    const value = raw.replace(/^["']|["']$/g, "").trim();
    if (value) process.env[key] = value;
  }
}

loadEnv(".env");
loadEnv(".env.local");

const base = process.env.HEDGE_URL ?? "http://127.0.0.1:3000";
const secret = process.env.HEDGE_SCAN_SECRET;

/** `console` is banned outside `src/lib/logger.ts`; CLI scripts write directly. */
const out = (line) => process.stdout.write(`${line}\n`);
const fail = (line) => process.stderr.write(`${line}\n`);

if (!secret) {
  fail(
    "HEDGE_SCAN_SECRET is not set, so the manual-scan endpoint is disabled.",
  );
  fail(
    "That is deliberate: an unauthenticated endpoint that fires ~500 Yahoo requests",
  );
  fail("is a liability, so it fails closed rather than staying open.");
  process.exit(1);
}

const started = Date.now();

try {
  const response = await fetch(`${base}/api/hedge/scan`, {
    method: "POST",
    headers: { "x-hedge-secret": secret },
  });

  if (!response.ok) {
    fail(
      `Scan request failed (${response.status}). ` +
        (response.status === 404
          ? "Either the secret is wrong, or HEDGE_SCAN_SECRET is unset on the server."
          : "Is the server running?"),
    );
    process.exit(1);
  }

  const body = await response.json();
  out(`OK  ${body.message ?? "Scan started"}  (${Date.now() - started}ms)`);
  out(`    Watch ${base}/hedge, or poll ${base}/api/hedge/overview`);
  out("    A full 85-ticker scan takes a couple of minutes.");
} catch (error) {
  fail(`Could not reach ${base}: ${error.message}`);
  fail("Start the server first (npm run dev, or docker compose up).");
  process.exit(1);
}
