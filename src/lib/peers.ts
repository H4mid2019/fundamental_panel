import { SECTOR_AVERAGES } from "./indicators/stock";
import type { QuoteStats } from "./providers/peers";
import type {
  IndicatorFormat,
  PeerGroup,
  PeerMetricRow,
  StockFundamentals,
} from "./types";

/**
 * Median of the non-null values, or `null` when none are present.
 *
 * @param values - The candidate values.
 * @returns The median, or `null`.
 */
export function median(values: (number | null)[]): number | null {
  const nums = values
    .filter((v): v is number => v !== null && Number.isFinite(v))
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  const upper = nums[mid] ?? null;
  if (nums.length % 2 === 1 || upper === null) return upper;
  const lower = nums[mid - 1];
  return lower === undefined ? upper : (lower + upper) / 2;
}

/** A peer or the selected asset with its quote-derived stats attached. */
export interface PeerInput {
  fundamentals: StockFundamentals;
  stats: QuoteStats | undefined;
}

/** Trailing revenue implied by market cap and P/S (both already normalized). */
function impliedRevenue(f: StockFundamentals): number | null {
  if (f.marketCap === null || f.psRatio === null || f.psRatio <= 0) return null;
  return f.marketCap / f.psRatio;
}

interface MetricSpec {
  id: string;
  label: string;
  format: IndicatorFormat;
  betterWhen: "higher" | "lower" | null;
  /** Static broad-market reference, when one exists. */
  sectorAvg: number | null;
  get: (p: PeerInput) => number | null;
}

const sector = (id: keyof typeof SECTOR_AVERAGES): number | null =>
  SECTOR_AVERAGES[id] ?? null;

/** Row specs per tab, mirroring the indicator definitions where they exist. */
const GROUP_SPECS: {
  id: PeerGroup["id"];
  label: string;
  rows: MetricSpec[];
}[] = [
  {
    id: "quote",
    label: "Quote",
    rows: [
      {
        id: "marketCap",
        label: "Market Cap",
        format: "largeCurrency",
        betterWhen: null,
        sectorAvg: null,
        get: (p) => p.fundamentals.marketCap,
      },
      {
        id: "pctOf52wHigh",
        label: "Price % of 52 Week High",
        format: "percent",
        betterWhen: null,
        sectorAvg: null,
        get: (p) => p.stats?.pctOf52wHigh ?? null,
      },
      {
        id: "dividendYield",
        label: "Dividend Yield",
        format: "percent",
        betterWhen: "higher",
        sectorAvg: sector("dividendYield"),
        get: (p) => p.fundamentals.dividendYield,
      },
      {
        id: "oneYearReturn",
        label: "1 Year Price Return",
        format: "percent",
        betterWhen: "higher",
        sectorAvg: null,
        get: (p) => p.stats?.oneYearChangePct ?? null,
      },
      {
        id: "beta",
        label: "Beta",
        format: "number",
        betterWhen: null,
        sectorAvg: null,
        get: (p) => p.fundamentals.beta,
      },
    ],
  },
  {
    id: "value",
    label: "Value",
    rows: [
      {
        id: "pe",
        label: "P/E Ratio",
        format: "ratio",
        betterWhen: "lower",
        sectorAvg: sector("pe"),
        get: (p) => p.fundamentals.peRatio,
      },
      {
        id: "peg",
        label: "PEG Ratio",
        format: "ratio",
        betterWhen: "lower",
        sectorAvg: sector("peg"),
        get: (p) => p.fundamentals.pegRatio,
      },
      {
        id: "pb",
        label: "Price / Book",
        format: "ratio",
        betterWhen: "lower",
        sectorAvg: sector("pb"),
        get: (p) => p.fundamentals.pbRatio,
      },
      {
        id: "ps",
        label: "Price / LTM Sales",
        format: "ratio",
        betterWhen: "lower",
        sectorAvg: sector("ps"),
        get: (p) => p.fundamentals.psRatio,
      },
      {
        id: "evEbitda",
        label: "EV / EBITDA",
        format: "ratio",
        betterWhen: "lower",
        sectorAvg: sector("evEbitda"),
        get: (p) => p.fundamentals.evToEbitda,
      },
    ],
  },
  {
    id: "size",
    label: "Size",
    rows: [
      {
        id: "marketCap",
        label: "Market Cap",
        format: "largeCurrency",
        betterWhen: null,
        sectorAvg: null,
        get: (p) => p.fundamentals.marketCap,
      },
      {
        id: "revenue",
        label: "Revenue (LTM, implied)",
        format: "largeCurrency",
        betterWhen: null,
        sectorAvg: null,
        get: (p) => impliedRevenue(p.fundamentals),
      },
      {
        id: "freeCashFlow",
        label: "Free Cash Flow",
        format: "largeCurrency",
        betterWhen: "higher",
        sectorAvg: null,
        get: (p) => p.fundamentals.freeCashFlow,
      },
    ],
  },
  {
    id: "growth",
    label: "Growth",
    rows: [
      {
        id: "revenueGrowthYoY",
        label: "Revenue Growth YoY",
        format: "percent",
        betterWhen: "higher",
        sectorAvg: null,
        get: (p) => p.fundamentals.revenueGrowthYoY,
      },
      {
        id: "peg",
        label: "PEG Ratio",
        format: "ratio",
        betterWhen: "lower",
        sectorAvg: sector("peg"),
        get: (p) => p.fundamentals.pegRatio,
      },
      {
        id: "oneYearReturn",
        label: "1 Year Price Return",
        format: "percent",
        betterWhen: "higher",
        sectorAvg: null,
        get: (p) => p.stats?.oneYearChangePct ?? null,
      },
    ],
  },
  {
    id: "profit",
    label: "Profit",
    rows: [
      {
        id: "netProfitMargin",
        label: "Net Profit Margin",
        format: "percent",
        betterWhen: "higher",
        sectorAvg: sector("netProfitMargin"),
        get: (p) => p.fundamentals.netProfitMargin,
      },
      {
        id: "roe",
        label: "Return on Equity",
        format: "percent",
        betterWhen: "higher",
        sectorAvg: sector("roe"),
        get: (p) => p.fundamentals.roe,
      },
      {
        id: "roa",
        label: "Return on Assets",
        format: "percent",
        betterWhen: "higher",
        sectorAvg: sector("roa"),
        get: (p) => p.fundamentals.roa,
      },
      {
        id: "eps",
        label: "EPS (TTM)",
        format: "currency",
        betterWhen: "higher",
        sectorAvg: null,
        get: (p) => p.fundamentals.eps,
      },
    ],
  },
];

/**
 * Build the peer-benchmark tab groups from normalized fundamentals.
 *
 * @param self - The selected asset with its quote stats.
 * @param peers - The peer assets with their quote stats.
 * @returns The fully-resolved tab groups (value vs peer median vs sector avg).
 */
export function buildPeerGroups(
  self: PeerInput,
  peers: PeerInput[],
): PeerGroup[] {
  return GROUP_SPECS.map((group) => ({
    id: group.id,
    label: group.label,
    rows: group.rows.map(
      (spec): PeerMetricRow => ({
        id: spec.id,
        label: spec.label,
        format: spec.format,
        value: spec.get(self),
        peerMedian: median(peers.map((p) => spec.get(p))),
        sectorAvg: spec.sectorAvg,
        betterWhen: spec.betterWhen,
      }),
    ),
  }));
}
