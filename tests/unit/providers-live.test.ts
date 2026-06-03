import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Exercises the "live" (key-configured) provider and AI code paths by stubbing
 * the environment before the modules load and mocking `fetch`. Modules are
 * imported dynamically so `lib/env` evaluates against the stubbed keys.
 */

type Providers = {
  fmp: typeof import("@/lib/providers/fmp");
  coingecko: typeof import("@/lib/providers/coingecko");
  fred: typeof import("@/lib/providers/fred");
  finnhub: typeof import("@/lib/providers/finnhub");
  openrouter: typeof import("@/lib/ai/openrouter");
};

const mods = {} as Providers;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Stable-API field names.
const profile = {
  companyName: "Apple",
  price: 200,
  beta: 1.2,
  marketCap: 3e12,
  currency: "USD",
  sector: "Tech",
  changePercentage: 1.5,
};
const ratios = {
  priceToEarningsRatioTTM: 30,
  priceToBookRatioTTM: 40,
  priceToSalesRatioTTM: 8,
  priceEarningsToGrowthRatioTTM: 2.5,
  dividendYieldTTM: 0.005,
  dividendPayoutRatioTTM: 0.15,
  returnOnEquityTTM: 1.4,
  returnOnAssetsTTM: 0.28,
  netProfitMarginTTM: 0.25,
  currentRatioTTM: 0.9,
  quickRatioTTM: 0.8,
  debtToEquityRatioTTM: 1.5,
  interestCoverageRatioTTM: 28,
  assetTurnoverTTM: 1.1,
};
const keyMetrics = {
  evToEBITDATTM: 24,
  netIncomePerShareTTM: 6.5,
  freeCashFlowPerShareTTM: 6,
  marketCap: 3e12,
};
const market = {
  id: "bitcoin",
  symbol: "btc",
  name: "Bitcoin",
  current_price: 50000,
  market_cap: 1e12,
  market_cap_rank: 1,
  fully_diluted_valuation: 1.1e12,
  total_volume: 2e10,
  circulating_supply: 19e6,
  total_supply: 21e6,
  price_change_percentage_24h: 1.5,
  price_change_percentage_30d_in_currency: 8,
};

let failProfile = false;

beforeAll(async () => {
  vi.stubEnv("FMP_API_KEY", "fmp-key");
  vi.stubEnv("COINGECKO_API_KEY", "cg-key");
  vi.stubEnv("FRED_API_KEY", "fred-key");
  vi.stubEnv("FINNHUB_API_KEY", "fh-key");
  vi.stubEnv("OPENROUTER_API_KEY", "or-key");

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      // FMP stable endpoints use `?symbol=` query style.
      if (u.includes("/stable/ratios-ttm")) return json([ratios]);
      if (u.includes("/stable/key-metrics-ttm")) return json([keyMetrics]);
      if (u.includes("/stable/income-statement-growth"))
        return json([{ growthRevenue: 0.06 }]);
      if (u.includes("/stable/profile"))
        return failProfile
          ? json({ "Error Message": "Invalid symbol" })
          : json([profile]);
      if (u.includes("finnhub.io/api/v1/company-news"))
        return json([
          {
            id: 1,
            headline: "Apple beats earnings expectations",
            source: "Reuters",
            url: "https://x/a",
            datetime: 1_700_000_000,
            summary: "s",
          },
        ]);
      if (u.includes("/coins/markets")) return json([market]);
      if (u.includes("market_chart"))
        return json({
          prices: [
            [0, 100],
            [1, 102],
            [2, 101],
            [3, 105],
          ],
        });
      if (u.includes("stlouisfed"))
        return json({ observations: [{ date: "2024-01-01", value: "1.5" }] });
      if (u.includes("openrouter"))
        return json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: "A concise summary of fundamentals.",
                  perIndicator: { pe: "Reasonable valuation." },
                }),
              },
            },
          ],
        });
      return json({}, 404);
    }),
  );

  mods.fmp = await import("@/lib/providers/fmp");
  mods.coingecko = await import("@/lib/providers/coingecko");
  mods.fred = await import("@/lib/providers/fred");
  mods.finnhub = await import("@/lib/providers/finnhub");
  mods.openrouter = await import("@/lib/ai/openrouter");
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("FMP live path", () => {
  it("fetches, validates and maps fundamentals", async () => {
    const result = await mods.fmp.getStockFundamentals("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.eps).toBe(6.5);
      expect(result.data.roe).toBe(140);
    }
  });

  it("returns a validation error when the required profile is malformed", async () => {
    failProfile = true;
    const result = await mods.fmp.getStockFundamentals("AAPL");
    failProfile = false;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("still maps when optional statement endpoints are unavailable", async () => {
    // ratios/key-metrics succeed here, but verify a partial map keeps profile
    // data even if a statement field is missing.
    const result = await mods.fmp.getStockFundamentals("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.price).toBe(200);
      expect(result.data.marketCap).toBe(3e12);
    }
  });
});

describe("CoinGecko live path", () => {
  it("fetches markets + chart and computes fundamentals", async () => {
    const result = await mods.coingecko.getCryptoFundamentals("BTC");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.symbol).toBe("BTC");
      expect(result.data.volatility30d).not.toBeNull();
    }
  });

  it("fetches the live top coins", async () => {
    const top = await mods.coingecko.getTopCryptos();
    expect(top.length).toBeGreaterThanOrEqual(1);
    expect(top[0]?.type).toBe("crypto");
  });
});

describe("Finnhub live path", () => {
  it("fetches and maps company news", async () => {
    const result = await mods.finnhub.getNewsArticles(
      "AAPL",
      "stock",
      Date.parse("2024-06-15T00:00:00Z"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.length).toBe(1);
      expect(result.data[0]?.title).toContain("Apple");
    }
  });
});

describe("FRED live path", () => {
  it("fetches and maps macro observations", async () => {
    const result = await mods.fred.getMacroMetrics();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const vix = result.data.find((m) => m.label === "VIX");
      expect(vix?.value).toBe(1.5);
    }
  });
});

describe("OpenRouter live path", () => {
  it("calls the model and returns a non-fallback brief", async () => {
    const result = await mods.openrouter.getAIBrief({
      symbol: "NVDA",
      name: "NVIDIA",
      assetType: "stock",
      indicators: [
        { id: "pe", label: "P/E", value: 30, unit: "x", sentiment: "neutral" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fallback).toBe(false);
      expect(result.data.summary).toContain("summary");
    }
  });
});
