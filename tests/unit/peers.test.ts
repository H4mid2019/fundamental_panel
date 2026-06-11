import { describe, expect, it } from "vitest";

import { getStockFixture } from "@/lib/fixtures";
import { buildPeerGroups, median, type PeerInput } from "@/lib/peers";

describe("median", () => {
  it("returns null when no values are present", () => {
    expect(median([])).toBeNull();
    expect(median([null, null])).toBeNull();
  });

  it("returns the middle value for odd counts, ignoring nulls", () => {
    expect(median([3, null, 1, 2])).toBe(2);
  });

  it("averages the two middle values for even counts", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe("buildPeerGroups", () => {
  const asInput = (symbol: string): PeerInput => ({
    fundamentals: getStockFixture(symbol),
    stats: { pctOf52wHigh: 71.7, oneYearChangePct: 265.1 },
  });

  it("builds the five tab groups with value, peer median and sector avg", () => {
    const groups = buildPeerGroups(asInput("AAPL"), [
      asInput("MSFT"),
      asInput("GOOGL"),
    ]);

    expect(groups.map((g) => g.id)).toEqual([
      "quote",
      "value",
      "size",
      "growth",
      "profit",
    ]);

    const value = groups.find((g) => g.id === "value");
    const pe = value?.rows.find((r) => r.id === "pe");
    expect(pe?.value).toBe(getStockFixture("AAPL").peRatio);
    // Median of MSFT (36.8) and GOOGL (24.6).
    expect(pe?.peerMedian).toBeCloseTo(30.7, 1);
    expect(pe?.sectorAvg).toBe(22);
    expect(pe?.betterWhen).toBe("lower");
  });

  it("degrades to null medians when there are no peers", () => {
    const groups = buildPeerGroups(asInput("AAPL"), []);
    for (const group of groups) {
      for (const row of group.rows) expect(row.peerMedian).toBeNull();
    }
  });

  it("uses quote stats for the 52-week-high and 1-year-return rows", () => {
    const groups = buildPeerGroups(asInput("AAPL"), [asInput("MSFT")]);
    const quote = groups.find((g) => g.id === "quote");
    expect(quote?.rows.find((r) => r.id === "pctOf52wHigh")?.value).toBe(71.7);
    expect(quote?.rows.find((r) => r.id === "oneYearReturn")?.value).toBe(
      265.1,
    );
  });
});
