import { z } from "zod";

import { cached } from "../cache";
import { env, features } from "../env";
import { fetchJson } from "../http";
import { logger } from "../logger";
import {
  err,
  ok,
  type AIBrief,
  type AppError,
  type Result,
  type TradeIdea,
} from "../types";

import { buildBriefPrompt, SYSTEM_PROMPT, type BriefInput } from "./prompts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const BRIEF_TTL_SECONDS = 6 * 60 * 60;
const HYPOTHETICAL_CAPITAL_EUR = 10_000;

const RecommendationSchema = z.object({
  stance: z.enum(["long", "short", "avoid"]),
  horizon: z.string(),
  bestHorizonMonths: z.number().optional(),
  conviction: z.enum(["low", "medium", "high"]),
  rationale: z.string(),
  hedge: z.string().nullable().optional(),
  scenario: z
    .object({
      capitalEur: z.number(),
      maxGainEur: z.number().nullable().optional(),
      maxLossEur: z.number().nullable().optional(),
      assumptions: z.string(),
    })
    .nullable()
    .optional(),
});

const BriefPayloadSchema = z.object({
  summary: z.string().min(1),
  perIndicator: z.record(z.string(), z.string()),
  recommendation: RecommendationSchema.optional(),
});

const CompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string() }),
      }),
    )
    .min(1),
});

/** Deterministic, key-free hash used to key cached briefs by content. */
export function hashInput(input: BriefInput): string {
  const serialized = JSON.stringify([
    input.indicators.map((i) => [i.id, i.value, i.sentiment]),
    input.newsIndex ?? null,
    input.newsHeadlines ?? [],
    input.macro?.map((m) => [m.label, m.value, m.reading]) ?? null,
    input.performance ?? null,
    input.options ?? null,
  ]);
  let hash = 5381;
  for (let i = 0; i < serialized.length; i++) {
    hash = (hash * 33) ^ serialized.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/** Human-readable phrase for a sentiment value. */
function phrase(sentiment: string): string {
  switch (sentiment) {
    case "bullish":
      return "supportive";
    case "bearish":
      return "a concern";
    case "neutral":
      return "in a normal range";
    default:
      return "unavailable";
  }
}

/**
 * Pick an illustrative best holding period (months, 3-24): strong near-term news
 * favors a shorter window; fundamental-led theses favor a longer one.
 */
function estimateBestHorizonMonths(input: BriefInput): number {
  const newsMag = Math.abs(input.newsIndex ?? 0); // 0..100
  const months = Math.round(16 - newsMag / 8); // strong news → shorter
  return Math.min(24, Math.max(3, months));
}

/** Estimate an illustrative horizon price move (percent) from risk indicators. */
function estimateMovePct(input: BriefInput): number {
  const find = (id: string) =>
    input.indicators.find((i) => i.id === id)?.value ?? null;
  const vol = find("volatility30d");
  const beta = find("beta");
  if (vol !== null) return Math.min(70, Math.max(20, Math.round(vol * 0.6)));
  if (beta !== null)
    return Math.min(50, Math.max(15, Math.round(20 * beta + 10)));
  return 30;
}

/**
 * Produce a deterministic local trade recommendation from indicators + news.
 *
 * @param input - The asset and its indicators.
 * @returns A hypothetical {@link TradeIdea}.
 */
export function buildFallbackRecommendation(input: BriefInput): TradeIdea {
  const known = input.indicators.filter((i) => i.value !== null);
  const bullish = known.filter((i) => i.sentiment === "bullish").length;
  const bearish = known.filter((i) => i.sentiment === "bearish").length;
  const newsAdj = (input.newsIndex ?? 0) / 20;
  const score = bullish - bearish + newsAdj;

  const stance: TradeIdea["stance"] =
    score > 1.5 ? "long" : score < -1.5 ? "short" : "avoid";
  const magnitude = Math.abs(score);
  const conviction: TradeIdea["conviction"] =
    magnitude >= 4 ? "high" : magnitude >= 2 ? "medium" : "low";

  const best = estimateBestHorizonMonths(input);
  const newsPart =
    input.newsIndex !== undefined && input.newsHeadlines?.length
      ? `, news index ${input.newsIndex}`
      : "";
  const rationale = `${bullish} bullish vs ${bearish} bearish fundamental signals${newsPart}. ${
    stance === "long"
      ? "Fundamentals and tone tilt constructive."
      : stance === "short"
        ? "Fundamentals and tone tilt negative."
        : "Signals are mixed; conviction is low."
  }`;

  if (stance === "avoid") {
    return {
      stance,
      horizon: "3-24 months",
      bestHorizonMonths: best,
      conviction,
      rationale,
      hedge: null,
      scenario: null,
    };
  }

  const move = estimateMovePct(input);
  const capital = HYPOTHETICAL_CAPITAL_EUR;
  const maxGainEur = Math.round((capital * move) / 100);
  const hedge =
    stance === "long"
      ? "Protective put ~5-10% out-of-the-money to cap downside while keeping upside."
      : "Cap upside risk with a stop or a long out-of-the-money call as a tail hedge.";
  const maxLossEur = Math.round(capital * 0.1);

  return {
    stance,
    horizon: "3-24 months",
    bestHorizonMonths: best,
    conviction,
    rationale: `${rationale} A ~${best}-month ${stance} looks most favorable on this read.`,
    hedge,
    scenario: {
      capitalEur: capital,
      maxGainEur,
      maxLossEur,
      assumptions: `Illustrative ±${move}% move over the horizon; the suggested hedge caps loss near 10% of capital. Hypothetical, not advice.`,
    },
  };
}

/**
 * Produce a deterministic local brief without calling any external model.
 *
 * @param input - The asset and its indicators.
 * @returns A fully-formed {@link AIBrief} flagged as a fallback.
 */
export function buildFallbackBrief(input: BriefInput): AIBrief {
  const known = input.indicators.filter((i) => i.value !== null);
  const bullish = known.filter((i) => i.sentiment === "bullish").length;
  const bearish = known.filter((i) => i.sentiment === "bearish").length;
  const tilt =
    bullish > bearish
      ? "leans constructive"
      : bearish > bullish
        ? "shows notable risks"
        : "looks balanced";

  const strengths = known
    .filter((i) => i.sentiment === "bullish")
    .slice(0, 3)
    .map((i) => i.label);
  const risks = known
    .filter((i) => i.sentiment === "bearish")
    .slice(0, 3)
    .map((i) => i.label);

  const newsSentence =
    input.newsIndex !== undefined && input.newsHeadlines?.length
      ? `Recent news tone is ${
          input.newsIndex > 15
            ? "positive"
            : input.newsIndex < -15
              ? "negative"
              : "mixed"
        } (news index ${input.newsIndex}).`
      : "";

  const summary = [
    `${input.name} (${input.symbol}) ${tilt} across ${known.length} available fundamental indicators.`,
    strengths.length
      ? `Relative strengths include ${strengths.join(", ")}.`
      : "No standout strengths were detected in the current dataset.",
    risks.length
      ? `Areas to watch include ${risks.join(", ")}.`
      : "No major red flags were detected in the current dataset.",
    newsSentence,
    "This is an automated, offline summary and not financial advice.",
  ]
    .filter(Boolean)
    .join(" ");

  const perIndicator: Record<string, string> = {};
  for (const i of input.indicators) {
    const valueText =
      i.value === null ? "not available" : `${i.value}${i.unit}`;
    perIndicator[i.id] =
      `${i.label} is ${valueText}, currently ${phrase(i.sentiment)}.`;
  }

  return {
    symbol: input.symbol,
    summary,
    perIndicator,
    recommendation: buildFallbackRecommendation(input),
    model: "local-fallback",
    generatedAt: new Date().toISOString(),
    fallback: true,
  };
}

/**
 * Extract a JSON object from a model response, tolerating code fences and any
 * surrounding prose — e.g. a reasoning model that emits text around the JSON.
 *
 * @param content - The model's message content.
 * @returns The parsed JSON value, or `null` if none could be parsed.
 */
export function extractJson(content: string): unknown | null {
  const trimmed = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  const candidate =
    start !== -1 && end > start ? body.slice(start, end + 1) : body;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** Map a validated recommendation payload into a {@link TradeIdea}. */
function toRecommendation(
  input: BriefInput,
  rec: z.infer<typeof RecommendationSchema> | undefined,
): TradeIdea {
  if (!rec) return buildFallbackRecommendation(input);
  return {
    stance: rec.stance,
    horizon: rec.horizon,
    bestHorizonMonths:
      rec.bestHorizonMonths && Number.isFinite(rec.bestHorizonMonths)
        ? Math.min(24, Math.max(3, Math.round(rec.bestHorizonMonths)))
        : estimateBestHorizonMonths(input),
    conviction: rec.conviction,
    rationale: rec.rationale,
    hedge: rec.hedge ?? null,
    scenario: rec.scenario
      ? {
          capitalEur: rec.scenario.capitalEur,
          maxGainEur: rec.scenario.maxGainEur ?? null,
          maxLossEur: rec.scenario.maxLossEur ?? null,
          assumptions: rec.scenario.assumptions,
        }
      : null,
  };
}

/** One OpenRouter attempt; `jsonMode` toggles the `response_format` hint. */
async function requestBrief(
  input: BriefInput,
  jsonMode: boolean,
): Promise<Result<AIBrief, AppError>> {
  const result = await fetchJson<unknown>(OPENROUTER_URL, {
    // Full briefs (20 per-indicator notes + recommendation) take ~15s, and
    // reasoning models add latency; give headroom. Cached 6h.
    timeoutMs: 60_000,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
        "X-Title": "Fundamental Analysis Dashboard",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        temperature: 0.3,
        // Reasoning models: think internally but don't return the trace (we
        // only need the JSON answer). Ignored by non-reasoning models.
        reasoning: { exclude: true },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildBriefPrompt(input) },
        ],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    },
  });
  if (!result.ok) return result;

  const completion = CompletionSchema.safeParse(result.data);
  if (!completion.success || !completion.data.choices[0]) {
    return err({
      code: "PROVIDER_ERROR",
      message: "Malformed OpenRouter response",
    });
  }

  const parsedJson = extractJson(completion.data.choices[0].message.content);
  if (parsedJson === null) {
    return err({
      code: "PROVIDER_ERROR",
      message: "OpenRouter did not return JSON",
    });
  }

  const payload = BriefPayloadSchema.safeParse(parsedJson);
  if (!payload.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: "AI brief failed schema validation",
    });
  }

  return ok({
    symbol: input.symbol,
    summary: payload.data.summary,
    perIndicator: payload.data.perIndicator,
    recommendation: toRecommendation(input, payload.data.recommendation),
    model: env.OPENROUTER_MODEL,
    generatedAt: new Date().toISOString(),
    fallback: false,
  });
}

async function callOpenRouter(
  input: BriefInput,
): Promise<Result<AIBrief, AppError>> {
  const first = await requestBrief(input, true);
  if (first.ok) return first;
  // Some models/providers reject response_format=json_object (common with
  // reasoning models). Retry once relying on the prompt + robust extraction.
  logger.warn("openrouter json-mode failed; retrying without response_format", {
    symbol: input.symbol,
    error: first.error,
  });
  return requestBrief(input, false);
}

/**
 * Generate (or fetch a cached) AI brief for an asset.
 *
 * Uses OpenRouter when configured; otherwise returns a deterministic local
 * brief. Any upstream failure also degrades to the local brief so the panel
 * always populates. Results are cached for six hours, keyed by content hash.
 *
 * @param input - The asset and its computed indicators.
 * @returns A {@link Result} that always resolves to an {@link AIBrief}.
 */
export async function getAIBrief(
  input: BriefInput,
): Promise<Result<AIBrief, AppError>> {
  const cacheKey = `ai:${input.symbol.toUpperCase()}:${hashInput(input)}`;

  const brief = await cached<AIBrief>(cacheKey, BRIEF_TTL_SECONDS, async () => {
    if (features.forceFixtures || !features.openrouter)
      return buildFallbackBrief(input);
    const result = await callOpenRouter(input);
    if (result.ok) return result.data;
    logger.warn("openrouter call failed; using fallback brief", {
      symbol: input.symbol,
      error: result.error,
    });
    return buildFallbackBrief(input);
  });

  return ok(brief);
}
