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
