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

  it("prefers standard monthlies over nearer weeklies", () => {
    const selected = selectExpiries(available, [30], 21, now);
    expect(selected).toHaveLength(1);
    // 2026-08-14 (34 DTE) is closer to the 30d target than 2026-08-21 (41 DTE),
    // but it is a weekly with a shallow strike ladder, so the monthly wins.
    expect(selected[0]?.expiration).toBe("2026-08-21");
    expect(selected[0]?.standardMonthly).toBe(true);
    expect(selected[0]?.dte).toBe(41);
    expect(selected[0]?.targetDte).toBe(30);
  });

  it("selects one expiration per target tenor", () => {
    const selected = selectExpiries(available, [30, 90, 180], 21, now);
    expect(selected.map((e) => e.expiration)).toEqual([
      "2026-08-21", // ~30d
      "2026-10-16", // ~90d (97 DTE)
      "2027-01-15", // ~180d (188 DTE)
    ]);
    expect(selected.every((e) => e.standardMonthly)).toBe(true);
    // Ascending by DTE, which is what the term-structure metric expects.
    expect(selected.map((e) => e.dte)).toEqual([41, 97, 188]);
  });

  it("honours minDte, excluding the near monthly", () => {
    // 2026-07-17 is a monthly but only 6 DTE — inside the gamma/pin noise zone.
    const selected = selectExpiries(available, [7], 21, now);
    expect(selected[0]?.expiration).not.toBe("2026-07-17");
    expect(selected[0]?.dte).toBeGreaterThanOrEqual(21);
  });

  it("dedupes when two targets resolve to the same expiration", () => {
    const sparse = [utc("2026-08-21"), utc("2026-09-18")];
    const selected = selectExpiries(sparse, [30, 40, 90], 21, now);
    const expirations = selected.map((e) => e.expiration);
    expect(new Set(expirations).size).toBe(expirations.length);
    // 30d and 40d both land on 2026-08-21 (41 DTE); it is kept once, under the
    // target it matches most closely (40, not 30).
    const august = selected.find((e) => e.expiration === "2026-08-21");
    expect(august?.targetDte).toBe(40);
  });

  it("falls back to weeklies only when the ticker lists no monthly in range", () => {
    const weekliesOnly = [
      utc("2026-08-07"),
      utc("2026-08-14"),
      utc("2026-08-28"),
    ];
    const selected = selectExpiries(weekliesOnly, [30], 21, now);
    expect(selected).toHaveLength(1);
    // Flagged, so downstream can discount a reading taken off a thin ladder.
    expect(selected[0]?.standardMonthly).toBe(false);
    // Closest to the 30d target: 2026-08-07 is 27 DTE, 2026-08-14 is 34.
    expect(selected[0]?.expiration).toBe("2026-08-07");
  });

  it("returns nothing when no expiration clears minDte", () => {
    expect(selectExpiries([utc("2026-07-13")], [30], 21, now)).toEqual([]);
    expect(selectExpiries([], [30], 21, now)).toEqual([]);
  });
});
