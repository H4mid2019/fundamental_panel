import { describe, expect, it } from "vitest";

import {
  fredSchemas,
  getMacroMetrics,
  latestObservation,
} from "@/lib/providers/fred";

describe("latestObservation", () => {
  it("parses the first numeric observation", () => {
    const data = {
      observations: [
        { date: "2024-06-01", value: "4.34" },
        { date: "2024-05-01", value: "4.20" },
      ],
    };
    expect(latestObservation(data)).toEqual({
      value: 4.34,
      asOf: "2024-06-01",
    });
  });
  it("returns null when empty or non-numeric", () => {
    expect(latestObservation({ observations: [] })).toBeNull();
    expect(
      latestObservation({ observations: [{ date: "x", value: "." }] }),
    ).toBeNull();
  });
});

describe("fred schemas", () => {
  it("validates observation payloads", () => {
    const good = { observations: [{ date: "2024-01-01", value: "1.0" }] };
    expect(fredSchemas.ObservationsSchema.safeParse(good).success).toBe(true);
    expect(fredSchemas.ObservationsSchema.safeParse({}).success).toBe(false);
  });
});

describe("getMacroMetrics", () => {
  it("returns fixture metrics without a key", async () => {
    const result = await getMacroMetrics();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBeGreaterThanOrEqual(5);
      expect(result.data.map((m) => m.label)).toContain("VIX");
    }
  });
});
