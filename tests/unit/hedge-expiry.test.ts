import { describe, expect, it } from "vitest";

import {
  daysBetween,
  isStandardMonthly,
  selectExpiries,
  toIsoDate,
} from "@/lib/hedge/expiry";

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("isStandardMonthly", () => {
  it("accepts the third Friday of a month", () => {
    // Verified third Fridays.
    expect(isStandardMonthly(utc("2026-07-17"))).toBe(true);
    expect(isStandardMonthly(utc("2026-08-21"))).toBe(true);
    expect(isStandardMonthly(utc("2026-09-18"))).toBe(true);
    expect(isStandardMonthly(utc("2026-10-16"))).toBe(true);
    expect(isStandardMonthly(utc("2027-01-15"))).toBe(true);
  });

  it("rejects other Fridays, including the first, second, fourth and fifth", () => {
    expect(isStandardMonthly(utc("2026-08-07"))).toBe(false); // 1st Friday
    expect(isStandardMonthly(utc("2026-08-14"))).toBe(false); // 2nd Friday
    expect(isStandardMonthly(utc("2026-08-28"))).toBe(false); // 4th Friday
    expect(isStandardMonthly(utc("2026-07-31"))).toBe(false); // 5th Friday
  });

  it("rejects non-Fridays inside the third-week window", () => {
    expect(isStandardMonthly(utc("2026-08-20"))).toBe(false); // Thursday
    expect(isStandardMonthly(utc("2026-08-19"))).toBe(false); // Wednesday
  });

  // Yahoo hands back expirations as UTC midnight. Reading them with local
  // getters west of Greenwich shifts the date back a day and turns every
  // monthly into a Thursday — this asserts we use UTC parts throughout.
  it("classifies UTC-midnight dates regardless of the host timezone", () => {
    const monthly = new Date(Date.UTC(2026, 7, 21));
    expect(isStandardMonthly(monthly)).toBe(true);
  });
});

describe("daysBetween / toIsoDate", () => {
  it("counts whole days and formats UTC dates", () => {
    expect(daysBetween(utc("2026-07-11"), utc("2026-08-21"))).toBe(41);
    expect(daysBetween(utc("2026-07-11"), utc("2026-07-11"))).toBe(0);
    expect(toIsoDate(utc("2026-08-21"))).toBe("2026-08-21");
  });
});

describe("selectExpiries", () => {
  const now = utc("2026-07-11");

  // The live chain shape observed on AAPL: a dense weekly ladder plus monthlies.
  const available = [
    utc("2026-07-13"),
    utc("2026-07-17"), // monthly, but only 6 DTE
    utc("2026-07-24"),
    utc("2026-07-31"),
    utc("2026-08-07"),
    utc("2026-08-14"), // weekly — the thin one that spans only 200-335
    utc("2026-08-21"), // monthly — 110-600
    utc("2026-09-18"), // monthly
    utc("2026-10-16"), // monthly
    utc("2027-01-15"), // monthly
  ];

  const skewOnly = (skew: number[]) => ({ skew, term: [] });

  it("resolves a skew tenor to a monthly, never a nearer weekly", () => {
    const selected = selectExpiries(available, skewOnly([30]), 21, now);
    expect(selected).toHaveLength(1);
    // 2026-08-14 (34 DTE) is closer to the 30d target than 2026-08-21 (41 DTE),
    // but it is a weekly with a shallow strike ladder, so the monthly wins.
    expect(selected[0]?.expiration).toBe("2026-08-21");
    expect(selected[0]?.standardMonthly).toBe(true);
    expect(selected[0]?.dte).toBe(41);
    expect(selected[0]?.targetDtes).toEqual([30]);
    expect(selected[0]?.usableForSkew).toBe(true);
  });

  it("selects one expiration per skew tenor", () => {
    const selected = selectExpiries(
      available,
      skewOnly([30, 90, 180]),
      21,
      now,
    );
    expect(selected.map((e) => e.expiration)).toEqual([
      "2026-08-21", // ~30d
      "2026-10-16", // ~90d (97 DTE)
      "2027-01-15", // ~180d (188 DTE)
    ]);
    expect(selected.every((e) => e.standardMonthly)).toBe(true);
    // Ascending by DTE, which is what the term-structure metric expects.
    expect(selected.map((e) => e.dte)).toEqual([41, 97, 188]);
  });

  // The reason the two lists exist at all: ATM strikes are listed on every
  // expiry, so a term tenor may take a weekly — and only a weekly can bracket
  // the 30-day point from below, which VRP's constant-maturity ATM IV needs.
  it("resolves a term tenor to any expiration, weeklies included", () => {
    const selected = selectExpiries(
      available,
      { skew: [30], term: [14] },
      10,
      now,
    );
    const weekly = selected.find((e) => !e.standardMonthly);
    expect(weekly).toBeDefined();
    expect(weekly?.expiration).toBe("2026-07-24"); // 13 DTE, a weekly
    // Flagged unusable for wing metrics — a 25-delta search here would clamp.
    expect(weekly?.usableForSkew).toBe(false);

    // And the 30-day point is now genuinely bracketed: 13 DTE below, 41 above.
    const dtes = selected.map((e) => e.dte).sort((a, b) => a - b);
    expect(dtes.some((d) => d < 30)).toBe(true);
    expect(dtes.some((d) => d > 30)).toBe(true);
  });

  it("honours minDte, excluding the near monthly", () => {
    // 2026-07-17 is a monthly but only 6 DTE — inside the gamma/pin noise zone.
    const selected = selectExpiries(available, skewOnly([7]), 21, now);
    expect(selected[0]?.expiration).not.toBe("2026-07-17");
    expect(selected[0]?.dte).toBeGreaterThanOrEqual(21);
  });

  it("fetches an expiry once when several targets resolve to it", () => {
    const sparse = [utc("2026-08-21"), utc("2026-09-18")];
    const selected = selectExpiries(sparse, skewOnly([30, 40, 90]), 21, now);
    const expirations = selected.map((e) => e.expiration);
    expect(new Set(expirations).size).toBe(expirations.length);

    // 30d and 40d both land on 2026-08-21 (41 DTE). It is captured once, and
    // records both targets — each Yahoo call is an expiration, so paying twice
    // for the same one is pure rate-limit budget burned.
    const august = selected.find((e) => e.expiration === "2026-08-21");
    expect(august?.targetDtes).toEqual([30, 40]);
  });

  it("marks an expiry serving both a term and a skew target usable for skew", () => {
    const selected = selectExpiries(
      available,
      { skew: [30], term: [40] },
      21,
      now,
    );
    const august = selected.find((e) => e.expiration === "2026-08-21");
    expect(august?.targetDtes).toEqual([30, 40]);
    // It is a real monthly, so the term target does not demote it.
    expect(august?.usableForSkew).toBe(true);
  });

  it("falls back to weeklies only when the ticker lists no monthly in range", () => {
    const weekliesOnly = [
      utc("2026-08-07"),
      utc("2026-08-14"),
      utc("2026-08-28"),
    ];
    const selected = selectExpiries(weekliesOnly, skewOnly([30]), 21, now);
    expect(selected).toHaveLength(1);
    // Flagged, so no 25-delta reading is ever taken off a thin ladder.
    expect(selected[0]?.standardMonthly).toBe(false);
    expect(selected[0]?.usableForSkew).toBe(false);
    // Closest to the 30d target: 2026-08-07 is 27 DTE, 2026-08-14 is 34.
    expect(selected[0]?.expiration).toBe("2026-08-07");
  });

  it("returns nothing when no expiration clears minDte", () => {
    expect(
      selectExpiries([utc("2026-07-13")], skewOnly([30]), 21, now),
    ).toEqual([]);
    expect(selectExpiries([], skewOnly([30]), 21, now)).toEqual([]);
  });
});
