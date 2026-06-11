import { afterEach, describe, expect, it, vi } from "vitest";

const { mockedTimeSeries } = vi.hoisted(() => ({
  mockedTimeSeries: vi.fn(),
}));

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    fundamentalsTimeSeries = mockedTimeSeries;
  },
}));

import {
  getFinancialStatements,
  mapStatementRows,
} from "@/lib/providers/financials";

afterEach(() => vi.clearAllMocks());

describe("mapStatementRows", () => {
  it("maps, sorts and labels annual income rows", () => {
    const rows = [
      {
        date: new Date("2025-12-31"),
        totalRevenue: 601_800_000,
        netIncome: -198_210_000,
      },
      {
        date: new Date("2024-12-31"),
        totalRevenue: 436_200_000,
        netIncome: -190_180_000,
      },
    ];

    const mapped = mapStatementRows(rows, "income", "annual");
    expect(mapped.map((p) => p.label)).toEqual(["2024", "2025"]);
    expect(mapped[1]?.values.totalRevenue).toBe(601_800_000);
    expect(mapped[1]?.values.netIncome).toBe(-198_210_000);
    // Registered line items absent from the row come through as null.
    expect(mapped[1]?.values.grossProfit).toBeNull();
  });

  it("labels quarterly periods as Q# 'YY and trims to the window", () => {
    const rows = Array.from({ length: 8 }, (_, i) => ({
      date: new Date(Date.UTC(2024, i * 3, 28)),
      totalRevenue: 100 + i,
    }));

    const mapped = mapStatementRows(rows, "income", "quarterly");
    expect(mapped).toHaveLength(6); // keeps the last 6 quarters
    expect(mapped[0]?.label).toMatch(/^Q\d '2[45]$/);
  });

  it("drops periods where every registered line item is null", () => {
    const rows = [
      { date: new Date("2025-12-31"), unrelatedField: 1 },
      { date: new Date("2024-12-31"), totalRevenue: 5 },
    ];
    const mapped = mapStatementRows(rows, "income", "annual");
    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.label).toBe("2024");
  });
});

describe("getFinancialStatements", () => {
  it("fetches all three statements and normalizes them", async () => {
    mockedTimeSeries.mockImplementation(
      (_symbol: string, opts: { module: string }) => {
        const date = new Date("2025-12-31");
        if (opts.module === "financials") {
          return Promise.resolve([{ date, totalRevenue: 1000 }]);
        }
        if (opts.module === "balance-sheet") {
          return Promise.resolve([{ date, totalAssets: 5000 }]);
        }
        return Promise.resolve([{ date, freeCashFlow: 250 }]);
      },
    );

    const result = await getFinancialStatements("RKLB", "annual");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.symbol).toBe("RKLB");
      expect(result.data.income[0]?.values.totalRevenue).toBe(1000);
      expect(result.data.balance[0]?.values.totalAssets).toBe(5000);
      expect(result.data.cashflow[0]?.values.freeCashFlow).toBe(250);
    }
  });

  it("errors when every statement comes back empty", async () => {
    mockedTimeSeries.mockRejectedValue(new Error("offline"));
    const result = await getFinancialStatements("ZZZZ", "annual");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});
