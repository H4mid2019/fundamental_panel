import type { IndicatorFormat } from "./types";

/**
 * Format a large number into a compact currency string (e.g. `$1.23T`).
 *
 * @param value - The raw number.
 * @returns A compact currency string.
 */
export function formatLargeCurrency(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

/**
 * Format an indicator value for display according to its format kind.
 *
 * @param value - The numeric value, or `null` when unavailable.
 * @param format - The indicator's display format.
 * @returns A display string (`"N/A"` when the value is null).
 */
export function formatIndicatorValue(
  value: number | null,
  format: IndicatorFormat,
): string {
  if (value === null || !Number.isFinite(value)) return "N/A";
  switch (format) {
    case "ratio":
      return `${value.toFixed(2)}x`;
    case "percent":
      return `${value.toFixed(2)}%`;
    case "currency":
      return `$${value.toFixed(2)}`;
    case "largeCurrency":
      return formatLargeCurrency(value);
    case "number":
      return value.toFixed(2);
  }
}

/**
 * Format a signed percentage change with a leading sign.
 *
 * @param value - The percentage value, or `null`.
 * @returns A signed percent string, or `"—"` when null.
 */
export function formatChange(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}
