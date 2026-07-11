import type { AssetRef, AssetType } from "./types";

/** Map of crypto ticker → CoinGecko id for the supported coins. */
export const CRYPTO_IDS: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  BNB: "binancecoin",
  XRP: "ripple",
};

/** Hardcoded fallback ranking of the top-5 coins (used if CoinGecko is down). */
export const TOP_CRYPTO_FALLBACK: readonly AssetRef[] = [
  { symbol: "BTC", name: "Bitcoin", type: "crypto" },
  { symbol: "ETH", name: "Ethereum", type: "crypto" },
  { symbol: "SOL", name: "Solana", type: "crypto" },
  { symbol: "BNB", name: "BNB", type: "crypto" },
  { symbol: "XRP", name: "XRP", type: "crypto" },
];

/**
 * Curated commodity futures, keyed by their Yahoo symbol. The `category` feeds
 * the asset-header meta line; `resolveCommodityCategory` reads it back.
 */
export const COMMODITIES: readonly (AssetRef & { category: string })[] = [
  {
    symbol: "GC=F",
    name: "Gold",
    type: "commodity",
    category: "Precious metal",
  },
  {
    symbol: "SI=F",
    name: "Silver",
    type: "commodity",
    category: "Precious metal",
  },
  {
    symbol: "PL=F",
    name: "Platinum",
    type: "commodity",
    category: "Precious metal",
  },
  {
    symbol: "PA=F",
    name: "Palladium",
    type: "commodity",
    category: "Precious metal",
  },
  {
    symbol: "HG=F",
    name: "Copper",
    type: "commodity",
    category: "Industrial metal",
  },
  {
    symbol: "CL=F",
    name: "Crude Oil (WTI)",
    type: "commodity",
    category: "Energy",
  },
  {
    symbol: "BZ=F",
    name: "Brent Crude",
    type: "commodity",
    category: "Energy",
  },
  {
    symbol: "NG=F",
    name: "Natural Gas",
    type: "commodity",
    category: "Energy",
  },
  { symbol: "RB=F", name: "Gasoline", type: "commodity", category: "Energy" },
  { symbol: "ZC=F", name: "Corn", type: "commodity", category: "Agriculture" },
  { symbol: "ZW=F", name: "Wheat", type: "commodity", category: "Agriculture" },
  {
    symbol: "ZS=F",
    name: "Soybeans",
    type: "commodity",
    category: "Agriculture",
  },
  {
    symbol: "KC=F",
    name: "Coffee",
    type: "commodity",
    category: "Agriculture",
  },
  { symbol: "SB=F", name: "Sugar", type: "commodity", category: "Agriculture" },
  {
    symbol: "CT=F",
    name: "Cotton",
    type: "commodity",
    category: "Agriculture",
  },
];

/**
 * Look up the category ("Energy", "Precious metal", …) for a commodity symbol.
 *
 * @param symbol - The commodity ticker (e.g. `GC=F`).
 * @returns The category, or `null` when it isn't a curated commodity.
 */
export function resolveCommodityCategory(symbol: string): string | null {
  const upper = symbol.toUpperCase();
  return COMMODITIES.find((c) => c.symbol === upper)?.category ?? null;
}

/** Curated set of assets offered in the selector. */
export const SUPPORTED_ASSETS: readonly AssetRef[] = [
  { symbol: "AAPL", name: "Apple Inc.", type: "stock" },
  { symbol: "MSFT", name: "Microsoft Corporation", type: "stock" },
  { symbol: "GOOGL", name: "Alphabet Inc.", type: "stock" },
  { symbol: "AMZN", name: "Amazon.com, Inc.", type: "stock" },
  { symbol: "NVDA", name: "NVIDIA Corporation", type: "stock" },
  { symbol: "META", name: "Meta Platforms, Inc.", type: "stock" },
  { symbol: "TSLA", name: "Tesla, Inc.", type: "stock" },
  { symbol: "JPM", name: "JPMorgan Chase & Co.", type: "stock" },
  { symbol: "^GSPC", name: "S&P 500", type: "index" },
  { symbol: "^IXIC", name: "Nasdaq Composite", type: "index" },
  { symbol: "^DJI", name: "Dow Jones Industrial Average", type: "index" },
  { symbol: "^FTSE", name: "FTSE 100", type: "index" },
  { symbol: "^N225", name: "Nikkei 225", type: "index" },
  ...TOP_CRYPTO_FALLBACK,
  ...COMMODITIES.map(({ symbol, name, type }) => ({ symbol, name, type })),
];

/**
 * Infer the asset class from a raw symbol.
 *
 * @param symbol - A ticker such as `AAPL`, `^GSPC` or `BTC`.
 * @returns The inferred {@link AssetType}.
 */
export function resolveAssetType(symbol: string): AssetType {
  const upper = symbol.toUpperCase();
  if (upper.startsWith("^")) return "index";
  if (upper in CRYPTO_IDS) return "crypto";
  // Yahoo suffixes every futures contract with `=F` (e.g. GC=F, CL=F).
  if (upper.endsWith("=F")) return "commodity";
  return "stock";
}

/**
 * Look up a display name for a symbol from the curated registry.
 *
 * @param symbol - The ticker to resolve.
 * @returns The known display name, or the upper-cased symbol as a fallback.
 */
export function resolveAssetName(symbol: string): string {
  const upper = symbol.toUpperCase();
  return (
    SUPPORTED_ASSETS.find((a) => a.symbol.toUpperCase() === upper)?.name ??
    upper
  );
}
