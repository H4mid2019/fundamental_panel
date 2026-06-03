import type { MacroReading } from "./types";

/**
 * Per-series interpretation config, framed from a **risk-asset (equity)**
 * perspective: lower readings are generally supportive ("good"), higher
 * readings are generally a headwind ("bad").
 */
interface MacroInterp {
  description: string;
  /** At or below this value → good. */
  good: number;
  /** At or above this value → bad. */
  bad: number;
  notes: { good: string; bad: string; neutral: string };
}

const MACRO_INTERP: Readonly<Record<string, MacroInterp>> = {
  VIXCLS: {
    description:
      "CBOE Volatility Index — the market's expected 30-day volatility (the 'fear gauge').",
    good: 15,
    bad: 25,
    notes: {
      good: "Calm markets — supportive of risk assets.",
      bad: "Elevated fear — risk-off conditions.",
      neutral: "Moderate volatility.",
    },
  },
  DTWEXBGS: {
    description:
      "US Dollar Index (broad, trade-weighted). A stronger dollar is a headwind for commodities and non-US earnings.",
    good: 100,
    bad: 107,
    notes: {
      good: "Weaker dollar — tailwind for risk and commodities.",
      bad: "Strong dollar — headwind for risk assets.",
      neutral: "Dollar near typical range.",
    },
  },
  DGS10: {
    description:
      "10-Year US Treasury yield. Higher yields raise the discount rate and pressure equity valuations.",
    good: 3,
    bad: 4.5,
    notes: {
      good: "Low yields support valuations.",
      bad: "High yields pressure valuations and growth stocks.",
      neutral: "Yields in a moderate range.",
    },
  },
  CPIAUCSL: {
    description:
      "Consumer Price Index, year-over-year. Above the Fed's ~2% target invites tighter policy.",
    good: 2.5,
    bad: 3.5,
    notes: {
      good: "Inflation near target — room for easier policy.",
      bad: "Hot inflation — risk of tighter policy.",
      neutral: "Inflation moderately above target.",
    },
  },
  FEDFUNDS: {
    description:
      "Federal Funds Rate — the Fed's policy rate. Higher is more restrictive for the economy and risk assets.",
    good: 2,
    bad: 4.5,
    notes: {
      good: "Accommodative policy — supportive of risk.",
      bad: "Restrictive policy — headwind for risk assets.",
      neutral: "Policy in a neutral-ish range.",
    },
  },
};

/**
 * Interpret a macro metric into a risk-asset reading plus explanatory text.
 *
 * @param id - The FRED series id (e.g. `DGS10`).
 * @param value - The latest value, or `null`.
 * @returns The reading, a description of the metric, and a contextual note.
 */
export function interpretMacro(
  id: string,
  value: number | null,
): { reading: MacroReading; description: string; note: string } {
  const cfg = MACRO_INTERP[id];
  if (!cfg) {
    return { reading: "unknown", description: "", note: "" };
  }
  if (value === null) {
    return { reading: "unknown", description: cfg.description, note: "" };
  }
  if (value <= cfg.good) {
    return {
      reading: "good",
      description: cfg.description,
      note: cfg.notes.good,
    };
  }
  if (value >= cfg.bad) {
    return {
      reading: "bad",
      description: cfg.description,
      note: cfg.notes.bad,
    };
  }
  return {
    reading: "neutral",
    description: cfg.description,
    note: cfg.notes.neutral,
  };
}
