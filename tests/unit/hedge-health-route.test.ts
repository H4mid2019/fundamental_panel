/**
 * @vitest-environment node
 *
 * The health route opens the database (and therefore runs migrations), so it
 * needs the Node runtime rather than the suite's jsdom default.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Route = typeof import("@/app/api/hedge/health/route");
type Client = typeof import("@/lib/hedge/db/client");

let route: Route;
let client: Client;
let dir: string;

beforeAll(async () => {
  // Point the DB at a throwaway file before `lib/env` is evaluated, so the
  // route bootstraps a real (empty) database rather than the developer's.
  dir = mkdtempSync(join(tmpdir(), "hedge-health-"));
  vi.stubEnv("HEDGE_DB_PATH", join(dir, "test.db"));
  vi.resetModules();
  // Imported from the same fresh module graph as the route, so this is the very
  // handle the route opened — not a second one.
  client = await import("@/lib/hedge/db/client");
  route = await import("@/app/api/hedge/health/route");
});

afterAll(() => {
  // The route holds a process-wide SQLite handle. Windows refuses to unlink an
  // open file, so leaving it open turns cleanup into an EBUSY failure — and
  // leaks the handle for the rest of the run on every platform.
  client.closeDb();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/hedge/health", () => {
  it("bootstraps a fresh database and reports the schema version", async () => {
    const response = await route.GET();
    expect(response.status).toBe(200);

    const body = (await response.json()) as Record<string, unknown>;
    expect(body.schemaVersion).toBe(body.expectedSchemaVersion);
    expect(body.schemaVersion).toBeGreaterThan(0);
    expect(body.universeSize).toBeGreaterThan(50);
    // Nothing has scanned yet.
    expect(body.lastScan).toBeNull();
  });

  // The honesty requirement: on a fresh install IV rank is a realized-vol rank
  // in disguise, and the API has to say so rather than quietly serving it.
  it("declares IV rank proxied while the history is empty", async () => {
    const response = await route.GET();
    const body = (await response.json()) as {
      ivRank: {
        proxied: boolean;
        realDays: number;
        requiredDays: number;
        lookbackDays: number;
      };
      history: { tickers: number; days: number };
    };

    expect(body.ivRank.proxied).toBe(true);
    expect(body.ivRank.realDays).toBe(0);
    expect(body.ivRank.requiredDays).toBeGreaterThan(0);
    expect(body.ivRank.lookbackDays).toBe(252);
    expect(body.history.tickers).toBe(0);
    expect(body.history.days).toBe(0);
  });

  it("is not cached — a health check must never be served stale", async () => {
    const response = await route.GET();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is idempotent: repeated calls re-run migrations harmlessly", async () => {
    const first = await route.GET();
    const second = await route.GET();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
  });
});
