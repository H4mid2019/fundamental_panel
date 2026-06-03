import { describe, expect, it } from "vitest";

import { fmpSchemas, getStockFundamentals, mapFmp } from "@/lib/providers/fmp";

// Uses legacy v3 field names to verify the candidate-key fallback still maps.
const raw = {
  profile: [
    {
      companyName: "Apple",
      price: 200,
      beta: 1.2,
      mktCap: 3e12,
      currency: "USD",
      sector: "Tech",
      changes: 1.5,
    },
  ],
  ratios: [
    {
      peRatioTTM: 30,
      priceToBookRatioTTM: 40,
      priceToSalesRatioTTM: 8,
      pegRatioTTM: 2.5,
      dividendYielTTM: 0.005,
      payoutRatioTTM: 0.15,
      returnOnEquityTTM: 1.4,
      returnOnAssetsTTM: 0.28,
      netProfitMarginTTM: 0.25,
      currentRatioTTM: 0.9,
      quickRatioTTM: 0.8,
      debtEquityRatioTTM: 1.5,
      interestCoverageTTM: 28,
      assetTurnoverTTM: 1.1,
    },
  ],
  keyMetrics: [
    {
      enterpriseValueOverEBITDATTM: 24,
      netIncomePerShareTTM: 6.5,
      freeCashFlowPerShareTTM: 6,
      marketCapTTM: 3e12,
    },
  ],
  growth: [{ growthRevenue: 0.06 }],
};

describe("mapFmp", () => {
  it("normalizes legacy field names and converts fractions to percentages", () => {
    const f = mapFmp("aapl", raw);
    expect(f.symbol).toBe("AAPL");
    expect(f.name).toBe("Apple");
    expect(f.dividendYield).toBe(0.5);
    expect(f.roe).toBe(140);
    expect(f.eps).toBe(6.5);
    expect(f.revenueGrowthYoY).toBe(6);
    // FCF = fcfPerShare * (marketCap / price) = 6 * (3e12 / 200)
    expect(f.freeCashFlow).toBe(9e10);
  });

  it("maps current stable field names", () => {
    const f = mapFmp("MSFT", {
      profile: [{ companyName: "Microsoft", price: 400, marketCap: 3e12 }],
      ratios: [
        {
          priceToEarningsRatioTTM: 35,
          priceToEarningsGrowthRatioTTM: 1.8,
          debtToEquityRatioTTM: 0.2,
          dividendYieldTTM: 0.007,
        },
      ],
      keyMetrics: [{ netIncomePerShareTTM: 11 }],
      growth: [{ growthRevenue: 0.15 }],
    });
    expect(f.peRatio).toBe(35);
    expect(f.pegRatio).toBe(1.8);
    expect(f.debtToEquity).toBe(0.2);
    expect(f.dividendYield).toBe(0.7);
    expect(f.eps).toBe(11);
  });
});

describe("fmp schemas", () => {
  it("accepts an array of objects", () => {
    expect(fmpSchemas.RowsSchema.safeParse(raw.profile).success).toBe(true);
  });
  it("rejects a non-array payload (e.g. an error object)", () => {
    expect(
      fmpSchemas.RowsSchema.safeParse({ "Error Message": "x" }).success,
    ).toBe(false);
  });
});

describe("getStockFundamentals", () => {
  it("falls back to fixtures when no API key is configured", async () => {
    const result = await getStockFundamentals("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.symbol).toBe("AAPL");
      expect(result.data.peRatio).not.toBeNull();
    }
  });
});
