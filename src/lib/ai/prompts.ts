import type { AssetType, Sentiment } from "../types";

/** Minimal indicator shape the AI layer needs to reason about. */
export interface BriefIndicatorInput {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  sentiment: Sentiment;
}

/** A macro reading passed to the model (risk-asset framing). */
export interface BriefMacroInput {
  label: string;
  value: number | null;
  unit: string;
  reading: string;
}

/** Trailing returns passed to the model. */
export interface BriefPerformanceInput {
  ytd: number | null;
  oneY: number | null;
  threeY: number | null;
  fiveY: number | null;
}

/** Market-implied options positioning passed to the model. */
export interface BriefOptionsInput {
  putCallRatio: number | null;
  /** At-the-money implied volatility as a decimal fraction (e.g. 0.31). */
  atmIV: number | null;
}

/** Everything required to generate an AI brief for one asset. */
export interface BriefInput {
  symbol: string;
  name: string;
  assetType: AssetType;
  indicators: BriefIndicatorInput[];
  /** Weighted news index in [-100, 100], when available. */
  newsIndex?: number;
  /** Top-weighted news headlines (max 20), when available. */
  newsHeadlines?: string[];
  /** Macro backdrop (VIX, yields, etc.) with risk-asset readings. */
  macro?: BriefMacroInput[];
  /** Trailing price returns. */
  performance?: BriefPerformanceInput;
  /** Options positioning (put/call ratio, ATM IV). */
  options?: BriefOptionsInput;
}

/** The system prompt establishing tone and strict output contract. */
export const SYSTEM_PROMPT = [
  "You are a concise equity and crypto research assistant.",
  "You explain fundamental indicators in plain, neutral language.",
  "You never give financial advice or price predictions.",
  "You MUST respond with a single valid JSON object and nothing else.",
].join(" ");

/**
 * Build the user prompt for the AI brief from an asset's indicators.
 *
 * @param input - The asset and its computed indicators.
 * @returns A prompt string instructing the model to return strict JSON.
 */
export function buildBriefPrompt(input: BriefInput): string {
  const rows = input.indicators
    .map((i) => {
      const value = i.value === null ? "N/A" : `${i.value}${i.unit}`;
      return `- ${i.id} (${i.label}): ${value} [${i.sentiment}]`;
    })
    .join("\n");

  const ids = input.indicators.map((i) => i.id).join(", ");

  const newsBlock =
    input.newsHeadlines && input.newsHeadlines.length > 0
      ? [
          "",
          `Recent news (weighted news index: ${input.newsIndex ?? "n/a"} on a -100..100 scale).`,
          "Top headlines:",
          ...input.newsHeadlines.slice(0, 20).map((h, i) => `${i + 1}. ${h}`),
          "Factor the news tone into the overall summary.",
        ].join("\n")
      : "";

  const macroBlock =
    input.macro && input.macro.length > 0
      ? [
          "",
          "Macro backdrop (reading is for risk assets — good/bad/neutral):",
          ...input.macro.map(
            (m) =>
              `- ${m.label}: ${m.value === null ? "N/A" : `${m.value}${m.unit}`} [${m.reading}]`,
          ),
        ].join("\n")
      : "";

  const fmtPct = (n: number | null) =>
    n === null ? "N/A" : `${n > 0 ? "+" : ""}${n}%`;
  const perfBlock = input.performance
    ? `\nTrailing returns: YTD ${fmtPct(input.performance.ytd)}, 1Y ${fmtPct(
        input.performance.oneY,
      )}, 3Y ${fmtPct(input.performance.threeY)}, 5Y ${fmtPct(
        input.performance.fiveY,
      )}.`
    : "";

  const optionsBlock =
    input.options &&
    (input.options.putCallRatio !== null || input.options.atmIV !== null)
      ? `\nOptions positioning: put/call ratio ${
          input.options.putCallRatio ?? "n/a"
        }, ATM implied volatility ${
          input.options.atmIV === null
            ? "n/a"
            : `${Math.round(input.options.atmIV * 1000) / 10}%`
        }.`
      : "";

  return [
    `Asset: ${input.name} (${input.symbol}), type: ${input.assetType}.`,
    "Indicators (value and pre-computed sentiment):",
    rows,
    newsBlock,
    macroBlock,
    perfBlock,
    optionsBlock,
    "",
    "Analyze the fundamentals, news, macro backdrop, trailing returns and",
    "options positioning together, then judge whether a",
    "position makes sense over a 3-24 month horizon. Identify the SINGLE best",
    "holding period in whole months (between 3 and 24) where the risk/reward is",
    "most favorable, and justify it in the rationale (e.g. 'a 4-month long looks",
    "most favorable because ...'). If you suggest a trade, also suggest a sensible",
    "hedge (e.g. a protective put for a long) and give illustrative max gain/loss",
    "on a hypothetical position of 10000 EUR.",
    "This is educational analysis, NOT financial advice.",
    "",
    "Return a JSON object with exactly this shape:",
    "{",
    '  "summary": string,            // 3-4 sentences on overall fundamentals + news',
    '  "perIndicator": {             // one entry per indicator id below',
    `    // keys: ${ids}`,
    '    "<id>": string              // max 20 words, plain explanation',
    "  },",
    '  "recommendation": {',
    '    "stance": "long" | "short" | "avoid",',
    '    "horizon": string,          // e.g. "3-24 months"',
    '    "bestHorizonMonths": number,// the single best holding period, 3-24',
    '    "conviction": "low" | "medium" | "high",',
    '    "rationale": string,        // 2-3 sentences citing the data + news',
    '    "hedge": string | null,     // hedge idea; null when stance is "avoid"',
    '    "scenario": {               // illustrative only',
    '      "capitalEur": 10000,',
    '      "maxGainEur": number | null,',
    '      "maxLossEur": number | null,',
    '      "assumptions": string',
    "    }",
    "  }",
    "}",
    "Do not include markdown fences or any prose outside the JSON.",
  ].join("\n");
}
