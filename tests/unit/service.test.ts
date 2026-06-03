import { describe, expect, it, vi } from "vitest";

vi.mock("yahoo-finance2", () => ({
  default: class YahooFinance {
    quote = vi.fn().mockRejectedValue(new Error("offline"));
  },
}));

import { getAssetSnapshot, getIndicatorSet } from "@/lib/service";

describe("getAssetSnapshot", () => {
  it("builds a stock snapshot from fixtures", async () => {
    const result = await getAssetSnapshot("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("stock");
      expect(result.data.symbol).toBe("AAPL");
      expect(result.data.meta).toBe("Technology");
    }
  });

  it("builds a crypto snapshot with rank metadata", async () => {
    const result = await getAssetSnapshot("BTC");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.type).toBe("crypto");
      expect(result.data.meta).toContain("Rank");
    }
  });

  it("builds an index snapshot (yahoo offline → fixture)", async () => {
    const result = await getAssetSnapshot("^GSPC");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.type).toBe("index");
  });
});

describe("getIndicatorSet", () => {
  it("returns 20 indicators for a stock", async () => {
    const result = await getIndicatorSet("AAPL");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.indicators).toHaveLength(20);
  });

  it("returns the universal indicators for crypto", async () => {
    const result = await getIndicatorSet("ETH");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assetType).toBe("crypto");
      expect(result.data.indicators).toHaveLength(3);
    }
  });
});
