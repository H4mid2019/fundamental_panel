import { describe, expect, it } from "vitest";

import { computeReturns } from "@/lib/providers/performance";

describe("computeReturns", () => {
  const now = Date.parse("2026-06-15T00:00:00Z");
  const points = [
    { ms: Date.parse("2021-01-01T00:00:00Z"), close: 50 },
    { ms: Date.parse("2023-06-15T00:00:00Z"), close: 80 },
    { ms: Date.parse("2025-06-15T00:00:00Z"), close: 100 },
    { ms: Date.parse("2025-12-31T00:00:00Z"), close: 105 },
    { ms: now, close: 120 },
  ];

  it("computes YTD/1Y/3Y/5Y from a monthly close series", () => {
    const r = computeReturns(points, 120, now);
    expect(r.ytd).toBeCloseTo(14.3, 1); // 120/105
    expect(r.oneY).toBe(20); // 120/100
    expect(r.threeY).toBe(50); // 120/80
    expect(r.fiveY).toBe(140); // 120/50
  });

  it("returns null when no base price is available", () => {
    const r = computeReturns([{ ms: now, close: 120 }], 120, now);
    expect(r.fiveY).toBeNull();
  });
});
