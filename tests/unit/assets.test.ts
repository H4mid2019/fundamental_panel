import { describe, expect, it } from "vitest";

import {
  CRYPTO_IDS,
  resolveAssetName,
  resolveAssetType,
  SUPPORTED_ASSETS,
  TOP_CRYPTO_FALLBACK,
} from "@/lib/assets";

describe("resolveAssetType", () => {
  it("classifies indexes by the caret prefix", () => {
    expect(resolveAssetType("^GSPC")).toBe("index");
  });
  it("classifies known crypto tickers", () => {
    expect(resolveAssetType("BTC")).toBe("crypto");
    expect(resolveAssetType("eth")).toBe("crypto");
  });
  it("defaults to stock", () => {
    expect(resolveAssetType("AAPL")).toBe("stock");
  });
});

describe("resolveAssetName", () => {
  it("resolves known names case-insensitively", () => {
    expect(resolveAssetName("aapl")).toBe("Apple Inc.");
  });
  it("falls back to the upper-cased symbol", () => {
    expect(resolveAssetName("ZZZZ")).toBe("ZZZZ");
  });
});

describe("registry", () => {
  it("has five fallback coins all present in the id map", () => {
    expect(TOP_CRYPTO_FALLBACK).toHaveLength(5);
    for (const coin of TOP_CRYPTO_FALLBACK) {
      expect(CRYPTO_IDS[coin.symbol]).toBeTruthy();
    }
  });
  it("includes stocks, indexes, crypto and commodities", () => {
    const types = new Set(SUPPORTED_ASSETS.map((a) => a.type));
    expect(types).toEqual(new Set(["stock", "index", "crypto", "commodity"]));
  });

  it("offers gold and silver so commodities are findable", () => {
    const symbols = new Set(SUPPORTED_ASSETS.map((a) => a.symbol));
    expect(symbols.has("GC=F")).toBe(true);
    expect(symbols.has("SI=F")).toBe(true);
  });
});
