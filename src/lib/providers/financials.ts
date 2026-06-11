import { z } from "zod";

import { features } from "../env";
import { STATEMENT_LINE_ITEMS } from "../financials";
import { getFinancialsFixture } from "../fixtures";
import { logger } from "../logger";
import {
  err,
  ok,
  type AppError,
  type Result,
  type FinancialStatements,
  type StatementFrequency,
  type StatementKind,
  type StatementPeriod,
} from "../types";

import { yahooFinance } from "./yahoo";

/** How many periods we keep per cadence. */
const KEEP_PERIODS: Record<StatementFrequency, number> = {
  annual: 5,
  quarterly: 6,
};

/** Lookback window per cadence (years). */
const LOOKBACK_YEARS: Record<StatementFrequency, number> = {
  annual: 6,
  quarterly: 2.5,
};

/** Yahoo `fundamentalsTimeSeries` module name per statement kind. */
const YAHOO_MODULE: Record<StatementKind, string> = {
  income: "financials",
  balance: "balance-sheet",
  cashflow: "cash-flow",
};

// Rows arrive with a coerced `date` plus the line items we registered;
// everything else is passed through untouched and ignored.
const RowSchema = z.looseObject({ date: z.coerce.date() });
const RowsSchema = z.array(RowSchema);

export const financialsSchemas = { RowSchema, RowsSchema };

const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Format a fiscal period label, e.g. `2025` (annual) or `Q3 '25` (quarterly). */
function periodLabel(date: Date, frequency: StatementFrequency): string {
  const year = date.getUTCFullYear();
  if (frequency === "annual") return String(year);
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `Q${quarter} '${String(year).slice(2)}`;
}

/**
 * Map validated time-series rows into normalized statement periods.
 *
 * @param rows - Validated Yahoo rows (date + raw line items).
 * @param kind - Which statement's line items to extract.
 * @param frequency - Annual or quarterly (drives labels and trimming).
 * @returns Chronologically ascending periods, trimmed to the display window.
 */
export function mapStatementRows(
  rows: z.infer<typeof RowsSchema>,
  kind: StatementKind,
  frequency: StatementFrequency,
): StatementPeriod[] {
  const items = STATEMENT_LINE_ITEMS[kind];
  return rows
    .slice()
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((row) => {
      const values: Record<string, number | null> = {};
      for (const item of items) values[item.key] = numOrNull(row[item.key]);
      return {
        date: row.date.toISOString().slice(0, 10),
        label: periodLabel(row.date, frequency),
        values,
      };
    })
    .filter((p) => Object.values(p.values).some((v) => v !== null))
    .slice(-KEEP_PERIODS[frequency]);
}

/**
 * Fetch income statement, balance sheet and cash flow data for a stock via
 * Yahoo's `fundamentalsTimeSeries` (the quote-summary statement modules stopped
 * returning line items in late 2024). Serves deterministic fixtures in fixture
 * mode.
 *
 * @param symbol - The stock ticker.
 * @param frequency - Annual or quarterly reporting periods.
 * @returns A {@link Result} with the normalized statements.
 */
export async function getFinancialStatements(
  symbol: string,
  frequency: StatementFrequency,
): Promise<Result<FinancialStatements, AppError>> {
  if (features.forceFixtures) {
    return ok(getFinancialsFixture(symbol, frequency, Date.now()));
  }

  const period1 = new Date(
    Date.now() - LOOKBACK_YEARS[frequency] * 365.25 * 86_400_000,
  );

  const fetchKind = async (kind: StatementKind): Promise<StatementPeriod[]> => {
    try {
      const raw: unknown = await yahooFinance.fundamentalsTimeSeries(symbol, {
        period1,
        type: frequency,
        module: YAHOO_MODULE[kind],
      });
      const parsed = RowsSchema.safeParse(raw);
      if (!parsed.success) {
        logger.warn("yahoo.fundamentalsTimeSeries failed validation", {
          symbol,
          kind,
        });
        return [];
      }
      return mapStatementRows(parsed.data, kind, frequency);
    } catch (error) {
      logger.warn("yahoo.fundamentalsTimeSeries failed", {
        symbol,
        kind,
        error,
      });
      return [];
    }
  };

  const [income, balance, cashflow] = await Promise.all([
    fetchKind("income"),
    fetchKind("balance"),
    fetchKind("cashflow"),
  ]);

  if (income.length === 0 && balance.length === 0 && cashflow.length === 0) {
    return err({
      code: "NOT_FOUND",
      message: `No financial statements for ${symbol}`,
    });
  }

  return ok({
    symbol: symbol.toUpperCase(),
    frequency,
    income,
    balance,
    cashflow,
    asOf: new Date().toISOString(),
  });
}
