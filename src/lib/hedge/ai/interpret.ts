/**
 * AI interpretation of the top setups.
 *
 * Reuses the existing OpenRouter plumbing in `src/lib/ai/openrouter.ts` — the
 * strict JSON-only contract, the retry-without-`response_format` fallback for
 * reasoning models, and the robust `extractJson` extraction. What is added here is
 * a hedge-specific prompt, a hedge-specific schema, and a **durable** cache in the
 * `ai_cache` table keyed by `(ticker, signal_hash)` rather than the app's
 * ephemeral Redis, because a scan's interpretations should survive a restart and
 * an unchanged signal must never re-bill the model on a re-render.
 *
 * Everything degrades: with no API key the deterministic local interpretation
 * below fills in, and the dashboard is fully usable with AI switched off.
 */

import { z } from "zod";

import { extractJson } from "../../ai/openrouter";
import { env, features } from "../../env";
import { fetchJson } from "../../http";
import { logger } from "../../logger";
import type { HedgeDb } from "../db/client";
import { getDb } from "../db/client";
import type { Setup } from "../scanners";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Analytical commentary only. The system prompt is explicit that this is not
 * advice, and — more usefully — that a hedging signal has to be falsifiable: if
 * nothing could invalidate it, it is not a thesis, it is a horoscope.
 */
const SYSTEM_PROMPT = `You are an options-market analyst writing terse, technical notes for a professional trader.

For each setup you are given, write exactly three things:
1. "meaning" - what the signal actually says about the market's pricing. Be concrete about the numbers.
2. "risk" - the single biggest way this trade loses money. Not a generic disclaimer; the specific failure mode.
3. "invalidation" - what observable event would prove the thesis wrong. It must be falsifiable and specific.

Rules:
- Analytical commentary only. Never give financial advice, never use advice framing ("you should", "we recommend").
- Be specific and quantitative. "Vol is low" is useless; "30d IV at 13% against 20d realized of 17% means the market is underpricing recent movement" is useful.
- If a setup carries warnings (proxied IV rank, stale chain data, earnings in the tenor), say so plainly in the risk.
- 2-3 sentences per field, maximum. Open with the number or the conclusion. No preamble, no filler, no restating the question.
- Spell an abbreviation out in parentheses the first time it appears in a field: IVR (implied-volatility rank), VRP (variance risk premium), IV (implied volatility), RV (realized volatility), ATM (at-the-money), OTM (out-of-the-money), DTE (days to expiry). Fields are read in isolation, so each one expands its own first use.

Respond ONLY with JSON of the form:
{"interpretations":[{"ticker":"...","meaning":"...","risk":"...","invalidation":"..."}]}`;

const InterpretationSchema = z.object({
  ticker: z.string(),
  meaning: z.string().min(1),
  risk: z.string().min(1),
  invalidation: z.string().min(1),
});

const PayloadSchema = z.object({
  interpretations: z.array(InterpretationSchema).min(1),
});

const CompletionSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string() }) }))
    .min(1),
});

/** One setup's interpretation. */
export interface Interpretation {
  ticker: string;
  meaning: string;
  risk: string;
  invalidation: string;
  model: string;
  /** True when produced by the deterministic local fallback. */
  fallback: boolean;
}

/** Render one setup as compact prompt context. */
function describe(setup: Setup): string {
  const stats = Object.entries(setup.stats)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const legs = setup.legs
    .map(
      (l) =>
        `${l.action} ${l.expiration} ${l.strike}${l.right === "call" ? "C" : "P"} ` +
        `@${l.mid.toFixed(2)} (${(l.absDelta * 100).toFixed(0)}Δ, IV ${(l.iv * 100).toFixed(1)}%)`,
    )
    .join(" / ");
  const warn =
    setup.warnings.length > 0 ? ` WARNINGS: ${setup.warnings.join("; ")}` : "";
  return `[${setup.scanner}] ${setup.ticker} score=${setup.score.toFixed(2)} | ${legs} | ${stats}${warn}`;
}

/**
 * The deterministic, key-free interpretation.
 *
 * Not a placeholder apology — it says something true and useful using the numbers
 * already computed, so the dashboard is genuinely usable with AI switched off.
 */
export function buildFallbackInterpretation(setup: Setup): Interpretation {
  const s = setup.stats;
  const num = (k: string): string =>
    s[k] === null || s[k] === undefined ? "n/a" : String(s[k]);

  const meaningByScanner: Record<string, string> = {
    protectivePut:
      `IVR (implied-volatility rank) of ${num("ivRank")} puts IV (implied volatility) near the bottom of ` +
      `its trailing range, so downside protection costs ${num("costPct")}% of notional ` +
      `(${num("annualizedCost")}% annualized) for a floor at ${num("floorPct")}%. ` +
      `VRP (variance risk premium) is ${num("vrp")} vol points.`,
    putDebitSpread:
      `Put skew sits ${num("putSkewZ")} standard deviations above its own mean, so the wing being sold ` +
      `is priced richly against the body being bought. The spread pays ${num("payoffRatio")}:1 for ` +
      `${num("netDebit")} of debit.`,
    callCredit:
      `IVR (implied-volatility rank) of ${num("ivRank")} and a price ${num("pctVs200dma")}% above the ` +
      `200-day mean make upside expensive to buy and therefore attractive to sell: ` +
      `${num("yieldOnRisk")}% on capital at risk (${num("annualizedYield")}% annualized).`,
    collar:
      `Calls are priced ${num("ivSpread")} vol points over the puts, which is what makes this collar ` +
      `cheap: a floor at ${num("floorPct")}% and a cap at +${num("capPct")}% for ${num("netCostPct")}% ` +
      `of notional.`,
    tailHedge:
      `The composite reads ${num("composite")}: credit is deteriorating while equity volatility stays ` +
      `subdued, so far-OTM (out-of-the-money) convexity is priced for calm. The spread pays ` +
      `${num("payoffRatio")}:1 for ${num("costPct")}% of notional.`,
  };

  const riskByScanner: Record<string, string> = {
    protectivePut:
      "The premium is a certain, recurring cost against an uncertain payoff; if the underlying simply drifts up, the put expires worthless and the carry compounds.",
    putDebitSpread:
      "The short leg caps the payoff, so a genuine crash pays no more than the spread width — and if the skew flattens before the move, the position loses on vega even if direction is right.",
    callCredit:
      "The loss is capped but asymmetric: a breakout through the short strike costs multiples of the credit received, and momentum in a stretched name can persist far longer than the tenor.",
    collar:
      "The short call caps the upside precisely in the scenario you own the asset for. Early assignment before an ex-dividend can also strip the position at the worst moment.",
    tailHedge:
      "Tail hedges bleed. If the divergence closes quietly — credit recovering rather than equities falling — the premium is simply lost, and the signal can persist for months without resolving.",
  };

  const invalidation =
    setup.scanner === "tailHedge"
      ? "Credit spreads recovering while equity vol stays flat would remove the divergence the trade is built on."
      : setup.scanner === "protectivePut" || setup.scanner === "callCredit"
        ? `A move in IVR (implied-volatility rank) back through the ${setup.scanner === "protectivePut" ? "cheap" : "rich"} threshold, or a break of the 200-day trend, removes the premise.`
        : "The skew or IV (implied volatility) spread reverting to its mean removes the pricing anomaly this trade is built on.";

  const warned =
    setup.warnings.length > 0 ? ` Caveats: ${setup.warnings.join("; ")}.` : "";

  return {
    ticker: setup.ticker,
    meaning: meaningByScanner[setup.scanner] ?? setup.summary,
    risk:
      (riskByScanner[setup.scanner] ??
        "The position can lose its full premium.") + warned,
    invalidation,
    model: "local-fallback",
    fallback: true,
  };
}

/* ── durable cache ─────────────────────────────────────────────────────────── */

function readCache(
  ticker: string,
  signalHash: string,
  db: HedgeDb,
): Interpretation | null {
  const row = db.get<{ payload: string; model: string; fallback: number }>(
    `SELECT payload, model, fallback FROM ai_cache
      WHERE ticker = :ticker AND signal_hash = :hash`,
    { ticker, hash: signalHash },
  );
  if (!row) return null;
  try {
    const parsed = InterpretationSchema.safeParse(JSON.parse(row.payload));
    if (!parsed.success) return null;
    return { ...parsed.data, model: row.model, fallback: row.fallback === 1 };
  } catch {
    return null;
  }
}

function writeCache(
  signalHash: string,
  interpretation: Interpretation,
  db: HedgeDb,
): void {
  db.run(
    `INSERT OR REPLACE INTO ai_cache (ticker, signal_hash, model, payload, fallback, created_at)
     VALUES (:ticker, :hash, :model, :payload, :fallback, :createdAt)`,
    {
      ticker: interpretation.ticker,
      hash: signalHash,
      model: interpretation.model,
      payload: JSON.stringify({
        ticker: interpretation.ticker,
        meaning: interpretation.meaning,
        risk: interpretation.risk,
        invalidation: interpretation.invalidation,
      }),
      fallback: interpretation.fallback ? 1 : 0,
      createdAt: new Date().toISOString(),
    },
  );
}

/** One OpenRouter attempt; `jsonMode` toggles the `response_format` hint. */
async function request(
  setups: readonly Setup[],
  jsonMode: boolean,
): Promise<Interpretation[] | null> {
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
            content: `Interpret these ${setups.length} option setups:\n\n${setups
              .map(describe)
              .join("\n")}`,
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

  const payload = PayloadSchema.safeParse(json);
  if (!payload.success) return null;

  return payload.data.interpretations.map((i) => ({
    ...i,
    model: env.OPENROUTER_MODEL,
    fallback: false,
  }));
}

/**
 * Interpret the top setups, caching by `(ticker, signal_hash)`.
 *
 * @param setups - The setups to interpret (already truncated to `ai.topN`).
 * @param db - Database handle.
 * @returns One interpretation per setup, keyed by signal hash. Never throws.
 */
export async function interpretSetups(
  setups: readonly Setup[],
  db: HedgeDb = getDb(),
): Promise<Map<string, Interpretation>> {
  const out = new Map<string, Interpretation>();
  if (setups.length === 0) return out;

  // Cache first: an unchanged signal must never re-bill the model.
  const uncached: Setup[] = [];
  for (const s of setups) {
    const hit = readCache(s.ticker, s.signalHash, db);
    if (hit) out.set(s.signalHash, hit);
    else uncached.push(s);
  }
  if (uncached.length === 0) return out;

  const applyFallback = (): void => {
    for (const s of uncached) {
      const interpretation = buildFallbackInterpretation(s);
      writeCache(s.signalHash, interpretation, db);
      out.set(s.signalHash, interpretation);
    }
  };

  if (features.forceFixtures || !features.openrouter) {
    applyFallback();
    return out;
  }

  // Same two-attempt strategy as the existing brief client: some reasoning models
  // reject `response_format: json_object`.
  let interpretations = await request(uncached, true);
  if (!interpretations) {
    logger.warn("hedge.ai: json-mode failed; retrying without response_format");
    interpretations = await request(uncached, false);
  }

  if (!interpretations) {
    logger.warn("hedge.ai: model call failed; using deterministic fallback");
    applyFallback();
    return out;
  }

  // Match interpretations back to setups by ticker. The model can drop or
  // reorder entries, so anything unmatched falls back rather than going missing.
  const byTicker = new Map(
    interpretations.map((i) => [i.ticker.toUpperCase(), i]),
  );
  for (const s of uncached) {
    const matched = byTicker.get(s.ticker.toUpperCase());
    const interpretation = matched ?? buildFallbackInterpretation(s);
    writeCache(s.signalHash, interpretation, db);
    out.set(s.signalHash, interpretation);
  }

  return out;
}
