import type { StatementKind } from "./types";

/**
 * Static registry of the financial-statement line items the app renders.
 *
 * The `key` matches the (un-prefixed) field name returned by Yahoo's
 * `fundamentalsTimeSeries` module, so the provider can extract values
 * generically and the UI can render labels in a stable order.
 */
export interface StatementLineItem {
  key: string;
  label: string;
  /** Render style: large currency totals, per-share currency, or plain count. */
  format: "largeCurrency" | "currency" | "number";
  /** Visually emphasized rows (statement totals). */
  emphasis?: boolean;
}

const INCOME_ITEMS: StatementLineItem[] = [
  {
    key: "totalRevenue",
    label: "Total Revenue",
    format: "largeCurrency",
    emphasis: true,
  },
  { key: "costOfRevenue", label: "Cost of Revenue", format: "largeCurrency" },
  {
    key: "grossProfit",
    label: "Gross Profit",
    format: "largeCurrency",
    emphasis: true,
  },
  {
    key: "operatingExpense",
    label: "Total Operating Expense",
    format: "largeCurrency",
  },
  {
    key: "operatingIncome",
    label: "Operating Income",
    format: "largeCurrency",
    emphasis: true,
  },
  { key: "pretaxIncome", label: "Income Before Tax", format: "largeCurrency" },
  { key: "taxProvision", label: "Income Tax", format: "largeCurrency" },
  {
    key: "netIncome",
    label: "Net Income",
    format: "largeCurrency",
    emphasis: true,
  },
  { key: "EBITDA", label: "EBITDA", format: "largeCurrency" },
  {
    key: "dilutedAverageShares",
    label: "Diluted Avg. Shares",
    format: "number",
  },
  { key: "dilutedEPS", label: "Diluted EPS", format: "currency" },
];

const BALANCE_ITEMS: StatementLineItem[] = [
  {
    key: "totalAssets",
    label: "Total Assets",
    format: "largeCurrency",
    emphasis: true,
  },
  { key: "currentAssets", label: "Current Assets", format: "largeCurrency" },
  {
    key: "cashAndCashEquivalents",
    label: "Cash & Equivalents",
    format: "largeCurrency",
  },
  {
    key: "totalLiabilitiesNetMinorityInterest",
    label: "Total Liabilities",
    format: "largeCurrency",
    emphasis: true,
  },
  {
    key: "currentLiabilities",
    label: "Current Liabilities",
    format: "largeCurrency",
  },
  { key: "totalDebt", label: "Total Debt", format: "largeCurrency" },
  {
    key: "stockholdersEquity",
    label: "Stockholders' Equity",
    format: "largeCurrency",
    emphasis: true,
  },
  { key: "workingCapital", label: "Working Capital", format: "largeCurrency" },
];

const CASHFLOW_ITEMS: StatementLineItem[] = [
  {
    key: "operatingCashFlow",
    label: "Operating Cash Flow",
    format: "largeCurrency",
    emphasis: true,
  },
  {
    key: "investingCashFlow",
    label: "Investing Cash Flow",
    format: "largeCurrency",
  },
  {
    key: "financingCashFlow",
    label: "Financing Cash Flow",
    format: "largeCurrency",
  },
  {
    key: "capitalExpenditure",
    label: "Capital Expenditure",
    format: "largeCurrency",
  },
  {
    key: "freeCashFlow",
    label: "Free Cash Flow",
    format: "largeCurrency",
    emphasis: true,
  },
  {
    key: "endCashPosition",
    label: "End Cash Position",
    format: "largeCurrency",
  },
];

/** Ordered line items per statement kind. */
export const STATEMENT_LINE_ITEMS: Record<StatementKind, StatementLineItem[]> =
  {
    income: INCOME_ITEMS,
    balance: BALANCE_ITEMS,
    cashflow: CASHFLOW_ITEMS,
  };
