/**
 * The whole-market brief: one read of the entire universe, not one setup.
 *
 * The per-setup notes in `interpret.ts` answer "what does THIS trade mean?".
 * They cannot answer "what is the market doing?", because each is written with
 * one ticker in front of it. This does the other job: it reduces the scan to a
 * compact digest — the volatility regime, what is rich, what is cheap, where the
 * risk sits — and asks the model to read the picture.
 *
 * Two rules make it trustworthy rather than decorative:
 *
 *  1. **The digest is computed, not narrated.** Every number the model sees is
 *     already derived from the scan (medians, extremes, counts). The model is
 *     given facts and asked to interpret them; it is never asked to recall or
 *     estimate a number, which is where a language model invents.
 *
 *  2. **It is cached on a hash of that digest.** The brief only changes when the
 *     market does. An unchanged universe never re-bills the model — the same
 *     property the per-setup cache has, for the same reason.
 *
 * With no API key the deterministic fallback below writes the brief from the same
 * digest. It says less, but it says nothing false, and the dashboard stays useful
 * with AI switched off.
 */

import { z } from "zod";

import { extractJson } from "../../ai/openrouter";
import { env, features } from "../../env";
import { fetchJson } from "../../http";
import { logger } from "../../logger";
import type { AlertDraft } from "../alerts/engine";
import type { HedgeDb } from "../db/client";
import { getDb } from "../db/client";
import { readMarketBrief, writeMarketBrief } from "../db/repo";
import type { TickerMetrics } from "../metrics/engine";
import type { Setup } from "../scanners";
import { hashSignal, round } from "../scanners/types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** One ticker at an extreme of some measure. */
export interface Extreme {
  ticker: string;
  value: number;
}

/**
 * The scan, reduced to what a market read actually needs.
 *
 * Deliberately small. The model reasons better about twenty numbers than about
 * eighty-five rows, and a compact digest is also a stable cache key.
 */
export interface MarketDigest {
  /** Tickers that produced a usable chain. */
  tickers: number;
  /** Median VRP (variance risk premium) across the universe, in vol points. */
  vrpMedian: number | null;
  /** How many tickers price options above their realized-vol forecast. */
  vrpRichCount: number;
  /** Richest and cheapest by VRP — where the premium actually is. */
  vrpRichest: Extreme[];
  vrpCheapest: Extreme[];
  /** Median IV rank (implied-volatility rank), 0-100. */
  ivRankMedian: number | null;
  /** How many of those IV ranks rest on a realized-vol proxy rather than real IV. */
  ivRankProxied: number;
  /** Tickers whose term structure is inverted — front vol above back vol. */
  termInverted: string[];
  /** The most extreme put-skew z-scores, by absolute value. */
  skewExtremes: Extreme[];
  /** Chains graded by the put-call-parity staleness test. */
  quality: { good: number; degraded: number; poor: number };
  /** The highest-scoring setups across every scanner. */
  topSetups: { scanner: string; ticker: string; score: number }[];
  /** The credit-vs-equity-vol divergence the tail hedge watches. */
  tailHedge: { firing: boolean; composite: number | null };
  /** Alerts this scan, by severity, plus the loudest few. */
  alerts: { critical: number; warn: number; info: number; titles: string[] };
}

/** The model's read of the digest. */
export interface MarketBrief {
  /** One sentence: the whole picture. */
  headline: string;
  /** The volatility regime — what implied vol is doing against realized. */
  regime: string;
  /** Where the edge is, given that regime. */
  opportunities: string;
  /** What would break the read, and what the data cannot be trusted on. */
  risks: string;
  model: string;
  /** True when written by the deterministic local fallback. */
  fallback: boolean;
}

const BriefSchema = z.object({
  headline: z.string().min(1),
  regime: z.string().min(1),
  opportunities: z.string().min(1),
  risks: z.string().min(1),
});

const CompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

const SYSTEM_PROMPT = `You are an options-market strategist writing the morning read for a professional trader who hedges an equity book.

You are given a computed digest of a full option-market scan across a universe of tickers. Every number in it is already measured. Interpret them; never invent a number that is not there, and never restate the digest back as a list.

Write exactly four things:
1. "headline" - one sentence, the whole picture. The single most important thing about this market right now.
2. "regime" - what implied volatility is doing against realized volatility across the universe, and what that means about how the market is pricing risk.
3. "opportunities" - where the edge is, given that regime. Name specific tickers from the digest. Say whether the trade is to buy protection or sell premium, and why.
4. "risks" - what would break this read, plus any measurement caveat that should temper it (proxied IV rank, degraded chains, inverted term structure).

Rules:
- Analytical commentary only. Never give financial advice, never use advice framing ("you should", "we recommend").
- Be specific and quantitative, and cite the tickers. "Vol is low" is useless; "median VRP of -1.2 vol points with GLD and SLV the only names pricing above realized" is useful.
- 2-4 sentences per field. Open with the conclusion. No preamble, no filler, no hedging language for its own sake.
- Spell an abbreviation out in parentheses the first time it appears in a field: IVR (implied-volatility rank), VRP (variance risk premium), IV (implied volatility), RV (realized volatility), ATM (at-the-money), OTM (out-of-the-money), DTE (days to expiry). Fields are read in isolation, so each one expands its own first use.
- If a large share of the universe rests on a proxied IV rank or a degraded chain, say so plainly in the risks. A confident read off bad data is worse than no read.

Respond ONLY with JSON of the form:
{"headline":"...","regime":"...","opportunities":"...","risks":"..."}`;

/** The median of a numeric series, or `null` when it is empty. */
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return s[mid] ?? null;
  const lo = s[mid - 1];
  const hi = s[mid];
  return lo === undefined || hi === undefined ? null : (lo + hi) / 2;
}

/** The `n` tickers with the largest (or smallest) value of some measure. */
function extremes(
  metrics: readonly TickerMetrics[],
  pick: (m: TickerMetrics) => number | null,
  direction: "high" | "low",
  n = 5,
): Extreme[] {
  const rows: Extreme[] = [];
  for (const m of metrics) {
    const value = pick(m);
    if (value === null || !Number.isFinite(value)) continue;
    rows.push({ ticker: m.ticker, value: round(value, 2) ?? 0 });
  }
  rows.sort((a, b) =>
    direction === "high" ? b.value - a.value : a.value - b.value,
  );
  return rows.slice(0, n);
}

/**
 * Reduce a whole scan to the digest the brief is written from.
 *
 * @param metrics - Per-ticker metrics from this scan.
 * @param setups - Every setup every scanner produced.
 * @param alerts - The alerts this scan fired.
 * @param tailHedge - The tail-hedge composite reading.
 * @returns A compact, fully-computed picture of the universe.
 */
export function buildMarketDigest(
  metrics: readonly TickerMetrics[],
  setups: readonly Setup[],
  alerts: readonly AlertDraft[],
  tailHedge: { firing: boolean; composite: number | null },
): MarketDigest {
  const vrps = metrics
    .map((m) => m.vrp)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const ivRanks = metrics
    .map((m) => m.ivRank)
    .filter((v): v is number => v !== null && Number.isFinite(v));

  const skew = extremes(
    metrics,
    (m) => m.putSkewZ,
    "high",
    // Ranked by absolute value: a deeply negative skew z-score is every bit as
    // interesting as a deeply positive one, and sorting by signed value would
    // show only one tail.
    Number.POSITIVE_INFINITY,
  );
  skew.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const top = [...setups]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((s) => ({
      scanner: s.scanner,
      ticker: s.ticker,
      score: round(s.score, 2) ?? 0,
    }));

  return {
    tickers: metrics.length,
    vrpMedian: round(median(vrps), 2),
    vrpRichCount: vrps.filter((v) => v > 0).length,
    vrpRichest: extremes(metrics, (m) => m.vrp, "high"),
    vrpCheapest: extremes(metrics, (m) => m.vrp, "low"),
    ivRankMedian: round(median(ivRanks), 1),
    ivRankProxied: metrics.filter((m) => m.ivRankProxied).length,
    termInverted: metrics.filter((m) => m.termInverted).map((m) => m.ticker),
    skewExtremes: skew.slice(0, 5),
    quality: {
      good: metrics.filter((m) => m.dataQuality === "good").length,
      degraded: metrics.filter((m) => m.dataQuality === "degraded").length,
      poor: metrics.filter((m) => m.dataQuality === "poor").length,
    },
    topSetups: top,
    tailHedge: {
      firing: tailHedge.firing,
      composite: round(tailHedge.composite, 2),
    },
    alerts: {
      critical: alerts.filter((a) => a.severity === "critical").length,
      warn: alerts.filter((a) => a.severity === "warn").length,
      info: alerts.filter((a) => a.severity === "info").length,
      titles: alerts.slice(0, 5).map((a) => a.title),
    },
  };
}

/** The cache key: the brief changes only when the market does. */
export function marketSignalHash(digest: MarketDigest): string {
  return hashSignal("market", "__universe__", digest);
}

/**
 * The deterministic, key-free market brief.
 *
 * Not a placeholder apology — it states what the digest actually shows, so the
 * dashboard says something true with AI switched off.
 */
export function buildFallbackMarketBrief(digest: MarketDigest): MarketBrief {
  const vrp = digest.vrpMedian;
  const rich = digest.vrpRichest[0];
  const cheap = digest.vrpCheapest[0];
  const proxiedShare =
    digest.tickers > 0
      ? Math.round((100 * digest.ivRankProxied) / digest.tickers)
      : 0;
  const badChains = digest.quality.degraded + digest.quality.poor;

  const stance =
    vrp === null
      ? "no VRP (variance risk premium) could be measured"
      : vrp > 0
        ? `options are priced ${vrp} vol points above forecast realized volatility, so premium is being paid for risk that has not yet shown up`
        : `options are priced ${Math.abs(vrp)} vol points below forecast realized volatility, so the market is underpricing recent movement`;

  return {
    headline:
      `Across ${digest.tickers} tickers the median VRP (variance risk premium) is ` +
      `${vrp ?? "n/a"} vol points, with ${digest.vrpRichCount} names pricing implied above realized.`,
    regime:
      `Median IVR (implied-volatility rank) is ${digest.ivRankMedian ?? "n/a"} and ${stance}. ` +
      `${digest.termInverted.length} ticker(s) show an inverted term structure` +
      `${digest.termInverted.length > 0 ? ` (${digest.termInverted.slice(0, 5).join(", ")})` : ""}, ` +
      `which is where the market prices near-term stress above longer-dated risk.`,
    opportunities:
      (rich
        ? `${rich.ticker} carries the richest VRP at ${rich.value} vol points, which favours selling premium. `
        : "") +
      (cheap
        ? `${cheap.ticker} is the cheapest at ${cheap.value}, which favours buying protection. `
        : "") +
      (digest.topSetups[0]
        ? `The highest-scoring setup is ${digest.topSetups[0].scanner} on ${digest.topSetups[0].ticker}.`
        : "No setup cleared its scanner's threshold."),
    risks:
      `${proxiedShare}% of IVR readings rest on a realized-volatility proxy rather than real implied-vol history, ` +
      `so any rank-based signal is provisional. ` +
      (badChains > 0
        ? `${badChains} chain(s) are graded degraded or poor by the put-call-parity staleness test and should not be traded off. `
        : "") +
      (digest.tailHedge.firing
        ? "The tail-hedge composite is firing: credit is deteriorating while equity volatility stays subdued."
        : "The tail-hedge composite is not firing."),
    model: "local-fallback",
    fallback: true,
  };
}

/** One OpenRouter attempt; `jsonMode` toggles the `response_format` hint. */
async function request(
  digest: MarketDigest,
  jsonMode: boolean,
): Promise<MarketBrief | null> {
  const result = await fetchJson<unknown>(OPENROUTER_URL, {
    timeoutMs: 60_000,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": env.NEXT_PUBLIC_APP_URL,
        "X-Title": "HedgeScope",
      },
      body: JSON.stringify({
        model: env.OPENROUTER_MODEL,
        temperature: 0.3,
        reasoning: { exclude: true },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `Read this option-market scan:\n\n${JSON.stringify(digest, null, 2)}`,
          },
        ],
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    },
  });
  if (!result.ok) return null;

  const completion = CompletionSchema.safeParse(result.data);
  const content = completion.success
    ? completion.data.choices[0]?.message.content
    : undefined;
  if (content === undefined) return null;

  const json = extractJson(content);
  if (json === null) return null;

  const parsed = BriefSchema.safeParse(json);
  if (!parsed.success) return null;

  return { ...parsed.data, model: env.OPENROUTER_MODEL, fallback: false };
}

/**
 * Write the market brief for this scan, caching on the digest.
 *
 * @param digest - The computed picture of the universe.
 * @param db - Database handle.
 * @returns The brief and the hash it is cached under. Never throws.
 */
export async function interpretMarket(
  digest: MarketDigest,
  db: HedgeDb = getDb(),
): Promise<{ hash: string; brief: MarketBrief }> {
  const hash = marketSignalHash(digest);

  // An unchanged market must never re-bill the model.
  const cached = readMarketBrief(hash, db);
  if (cached) return { hash, brief: cached };

  const persist = (
    brief: MarketBrief,
  ): { hash: string; brief: MarketBrief } => {
    writeMarketBrief(hash, brief, db);
    return { hash, brief };
  };

  if (features.forceFixtures || !features.openrouter) {
    return persist(buildFallbackMarketBrief(digest));
  }

  let brief = await request(digest, true);
  if (!brief) {
    logger.warn(
      "hedge.ai.market: json-mode failed; retrying without response_format",
    );
    brief = await request(digest, false);
  }
  if (!brief) {
    logger.warn("hedge.ai.market: model call failed; using local fallback");
    return persist(buildFallbackMarketBrief(digest));
  }

  return persist(brief);
}
