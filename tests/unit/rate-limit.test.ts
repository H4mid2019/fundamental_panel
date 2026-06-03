import { beforeEach, describe, expect, it } from "vitest";

import { rateLimit, resetRateLimit } from "@/lib/rate-limit";

describe("rateLimit", () => {
  beforeEach(() => resetRateLimit());

  it("allows requests up to the limit then blocks", () => {
    const key = "ip-1";
    const now = 1000;
    expect(rateLimit(key, 2, 60_000, now).allowed).toBe(true);
    expect(rateLimit(key, 2, 60_000, now).allowed).toBe(true);
    const third = rateLimit(key, 2, 60_000, now);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it("resets after the window elapses", () => {
    const key = "ip-2";
    rateLimit(key, 1, 1000, 0);
    expect(rateLimit(key, 1, 1000, 500).allowed).toBe(false);
    const afterWindow = rateLimit(key, 1, 1000, 1500);
    expect(afterWindow.allowed).toBe(true);
    expect(afterWindow.remaining).toBe(0);
  });

  it("tracks remaining quota", () => {
    const result = rateLimit("ip-3", 5, 60_000, 0);
    expect(result.remaining).toBe(4);
  });
});
