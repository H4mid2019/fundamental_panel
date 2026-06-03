import { z } from "zod";

import { env, features } from "../env";
import { getMacroFixture } from "../fixtures";
import { fetchJson } from "../http";
import { ok, type AppError, type MacroMetric, type Result } from "../types";

const BASE_URL = "https://api.stlouisfed.org/fred/series/observations";

const ObservationsSchema = z.object({
  observations: z.array(
    z.object({
      date: z.string(),
      value: z.string(),
    }),
  ),
});

export const fredSchemas = { ObservationsSchema };

interface SeriesConfig {
  id: string;
  label: string;
  unit: string;
  /** FRED `units` transform (e.g. `pc1` for year-over-year percent change). */
  units?: string;
}

const SERIES: readonly SeriesConfig[] = [
  { id: "VIXCLS", label: "VIX", unit: "" },
  { id: "DTWEXBGS", label: "DXY", unit: "" },
  { id: "DGS10", label: "US 10Y", unit: "%" },
  { id: "CPIAUCSL", label: "CPI YoY", unit: "%", units: "pc1" },
  { id: "FEDFUNDS", label: "Fed Funds Rate", unit: "%" },
];

/**
 * Parse the latest numeric observation from a validated FRED response.
 *
 * @param data - The validated observations payload (descending by date).
 * @returns The latest `{ value, asOf }`, or `null` when unavailable.
 */
export function latestObservation(
  data: z.infer<typeof ObservationsSchema>,
): { value: number; asOf: string } | null {
  const first = data.observations[0];
  if (!first) return null;
  const value = Number(first.value);
  if (!Number.isFinite(value)) return null;
  return { value: Math.round(value * 100) / 100, asOf: first.date };
}

/**
 * Fetch the macro sidebar metrics from FRED, degrading to fixtures per-series.
 *
 * @returns A {@link Result} that always resolves to the metric list.
 */
export async function getMacroMetrics(): Promise<
  Result<MacroMetric[], AppError>
> {
  const fixtures = getMacroFixture();
  if (features.forceFixtures || !features.fred) return ok(fixtures);

  const metrics = await Promise.all(
    SERIES.map(async (series): Promise<MacroMetric> => {
      const fallback = fixtures.find((m) => m.id === series.id) ?? {
        id: series.id,
        label: series.label,
        value: null,
        unit: series.unit,
        asOf: "",
      };
      const url =
        `${BASE_URL}?series_id=${series.id}&api_key=${env.FRED_API_KEY}` +
        `&file_type=json&sort_order=desc&limit=1` +
        (series.units ? `&units=${series.units}` : "");
      const result = await fetchJson<unknown>(url);
      if (!result.ok) return fallback;
      const parsed = ObservationsSchema.safeParse(result.data);
      if (!parsed.success) return fallback;
      const latest = latestObservation(parsed.data);
      if (!latest) return fallback;
      return {
        id: series.id,
        label: series.label,
        value: latest.value,
        unit: series.unit,
        asOf: latest.asOf,
      };
    }),
  );

  return ok(metrics);
}
