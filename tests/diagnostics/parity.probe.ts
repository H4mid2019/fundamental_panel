/**
 * Live put-call parity diagnostic. NOT a test — it asserts nothing, hits Yahoo
 * for real, and is not part of the suite (vitest.config.ts includes `tests/unit`
 * only). Run it by hand, against a live chain:
 *
 *   npx vitest run --config tests/diagnostics/vitest.probe.config.ts
 *   # writes tests/diagnostics/parity-report.txt (gitignored)
 *
 * It exists so that `metrics.parity.tolerance` / `halfSpreadMult` are never
 * tuned by taste. The temptation, when the badge says `degraded`, is to loosen
 * the threshold until it turns green — which cannot distinguish "the check is
 * too strict" from "the chain really is stale", and quietly readmits the exact
 * quotes the check exists to keep out. So: measure first.
 *
 * The method: run the REAL `impliedForward` / `checkParity` over a live chain
 * (never a reimplementation — that would only test the copy), and for every pair
 * record the violation-to-threshold ratio ALONGSIDE the independent staleness
 * evidence Yahoo already ships per contract: last-trade age, volume, open
 * interest. Neither is derived from the other, so their agreement is the answer.
 *
 *   - Violators are old and untraded, accepted ones fresh -> the threshold is
 *     honest and the badge is telling the truth. Leave it alone.
 *   - Violators look just like the accepted ones          -> the threshold is
 *     too tight and is condemning live quotes.
 *
 * What it found (2026-07-12, ~3,000 pairs across 8 tickers) was emphatically the
 * first: rejected pairs missed by a MEDIAN of 13x their threshold (only 9.9% were
 * marginal, within 1.5x), had last traded a median of 101 days ago against 4 for
 * the accepted ones, and had a median open interest of ZERO against 71. The
 * threshold is right. What was wrong was the ACCOUNTING — see the attribution
 * note in `metrics/surface.ts`, which is what this probe led to.
 */
import { writeFileSync } from "node:fs";

import { describe, it } from "vitest";

import { getHedgeConfig } from "@/lib/hedge/config";
import { yearsToExpiry } from "@/lib/hedge/math/blackScholes";
import { checkParity, impliedForward } from "@/lib/hedge/math/parity";
import { buildSurface } from "@/lib/hedge/metrics/surface";
import { getRiskFreeRate } from "@/lib/hedge/providers/rates";
import { getUnderlying } from "@/lib/hedge/providers/underlying";
import { YahooChainProvider } from "@/lib/hedge/providers/yahoo";
import type { HedgeContract } from "@/lib/hedge/types";

const TICKERS = ["SPY", "QQQ", "GLD", "GDX", "HYG", "XLU", "LQD", "TLT"];

interface PairRecord {
  ticker: string;
  dte: number;
  strike: number;
  /** ln(K / F) — where the strike sits relative to the implied forward. */
  moneyness: number;
  violation: number;
  threshold: number;
  /** violation / threshold. > 1 is a rejection. */
  ratio: number;
  /** Combined half-spread of the two legs, in dollars. */
  halfSpreadSum: number;
  rejected: boolean;
  /** Staleness evidence, independent of the parity maths. */
  ageDays: number | null;
  minVolume: number;
  minOpenInterest: number;
}

/** Age of the older of the two legs' last trades, in days. `null` if unknown. */
function legAgeDays(
  call: HedgeContract,
  put: HedgeContract,
  capturedAt: Date,
): number | null {
  const ages = [call.lastTradeDate, put.lastTradeDate]
    .map((d) => (d === null ? null : Date.parse(d)))
    .filter((ms): ms is number => ms !== null && Number.isFinite(ms))
    .map((ms) => (capturedAt.getTime() - ms) / 86_400_000);
  if (ages.length < 2) return null;
  return Math.max(...ages);
}

function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[i] ?? Number.NaN;
}

function describeNums(label: string, xs: readonly number[]): string {
  if (xs.length === 0) return `${label.padEnd(22)} (none)`;
  const s = [...xs].sort((a, b) => a - b);
  const f = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "-");
  return (
    `${label.padEnd(22)} n=${String(s.length).padStart(4)}  ` +
    `p10=${f(quantile(s, 0.1)).padStart(7)}  p50=${f(quantile(s, 0.5)).padStart(7)}  ` +
    `p90=${f(quantile(s, 0.9)).padStart(7)}  p99=${f(quantile(s, 0.99)).padStart(7)}  ` +
    `max=${f(s[s.length - 1] ?? Number.NaN).padStart(8)}`
  );
}

const OUT: string[] = [];
const log = (s = ""): void => {
  OUT.push(s);
};

describe("live parity probe", () => {
  it("dumps violation magnitudes against thresholds", async () => {
    const config = getHedgeConfig();
    const limits = config.metrics.parity;
    const provider = new YahooChainProvider();
    const now = new Date();
    const rf = await getRiskFreeRate(now);

    log(
      `\nrate r=${rf.rate.toFixed(4)} (source=${rf.source}, fallback=${String(rf.fallback)})`,
    );
    log(
      `thresholds: tolerance=$${limits.tolerance} halfSpreadMult=${limits.halfSpreadMult} ` +
        `goodFraction=${limits.goodFraction} minGoodFraction=${limits.minGoodFraction}\n`,
    );

    const all: PairRecord[] = [];

    log(
      "ticker  quality    total  excl  illiq  parity  parity%  otherDefect%  goodFrac",
    );
    log("-".repeat(84));

    for (const ticker of TICKERS) {
      const u = await getUnderlying(ticker, now);
      if (!u.ok) {
        log(`${ticker}: underlying failed - ${u.error.message}`);
        continue;
      }
      const chain = await provider.getChainSnapshot({
        ticker,
        tenors: config.chain.tenors,
        minDte: config.chain.minDte,
        now,
      });
      if (!chain.ok || chain.data.spot === null) {
        log(`${ticker}: no chain`);
        continue;
      }

      const spot = chain.data.spot;
      const q = u.data.dividends.q;
      const rates = {
        r: rf.rate,
        q: q ?? 0,
        fallback: rf.fallback || q === null,
      };

      // The real surface build — this is what produces the badge in production.
      const surface = buildSurface(chain.data, rates, config);
      if (surface === null) {
        log(`${ticker}: surface would not build`);
        continue;
      }
      const rep = surface.quality;

      // Decompose the badge: parity is only ONE source of `contractsExcluded`.
      // The others are missing/crossed quotes and absurd IVs. Attributing the
      // whole exclusion rate to parity would be the first mistake.
      const parityPct = rep.contractsTotal
        ? (100 * rep.parityViolations) / rep.contractsTotal
        : 0;
      const otherPct = rep.contractsTotal
        ? (100 * (rep.contractsExcluded - rep.parityViolations)) /
          rep.contractsTotal
        : 0;

      log(
        `${ticker.padEnd(7)} ${rep.quality.padEnd(9)} ` +
          `${String(rep.contractsTotal).padStart(5)} ${String(rep.contractsExcluded).padStart(5)} ` +
          `${String(rep.contractsIlliquid).padStart(6)} ${String(rep.parityViolations).padStart(7)} ` +
          `${parityPct.toFixed(1).padStart(7)}% ${otherPct.toFixed(1).padStart(12)}% ` +
          `${rep.goodFraction.toFixed(3).padStart(9)}`,
      );

      // Re-run the parity check per pair, keeping the magnitudes the production
      // path throws away.
      const capturedAt = new Date(chain.data.capturedAt);
      for (const expiry of chain.data.expiries) {
        const t = yearsToExpiry(expiry.dte);
        const callByStrike = new Map(expiry.calls.map((c) => [c.strike, c]));
        const putByStrike = new Map(expiry.puts.map((p) => [p.strike, p]));
        const strikes = [
          ...new Set([...callByStrike.keys(), ...putByStrike.keys()]),
        ];

        const quotes = strikes
          .map((strike) => {
            const call = callByStrike.get(strike);
            const put = putByStrike.get(strike);
            if (!call || !put) return null;
            return {
              strike,
              callBid: call.bid,
              callAsk: call.ask,
              putBid: put.bid,
              putAsk: put.ask,
              call,
              put,
            };
          })
          .filter((p): p is NonNullable<typeof p> => p !== null);

        const implied = impliedForward(quotes, rates.r, t, spot);
        if (implied === null) continue;

        for (const quote of quotes) {
          const check = checkParity(
            quote,
            { forward: implied.forward, t, r: rates.r },
            limits,
            implied.uncertainty,
          );
          if (check.reason === "missing_quote") continue;

          const { call, put } = quote;
          const callHalf =
            call.bid !== null && call.ask !== null
              ? (call.ask - call.bid) / 2
              : 0;
          const putHalf =
            put.bid !== null && put.ask !== null ? (put.ask - put.bid) / 2 : 0;

          all.push({
            ticker,
            dte: expiry.dte,
            strike: quote.strike,
            moneyness: Math.log(quote.strike / implied.forward),
            violation: check.violation,
            threshold: check.threshold,
            ratio:
              check.threshold > 0 ? check.violation / check.threshold : NaN,
            halfSpreadSum: callHalf + putHalf,
            rejected: !check.ok,
            ageDays: legAgeDays(call, put, capturedAt),
            minVolume: Math.min(call.volume ?? 0, put.volume ?? 0),
            minOpenInterest: Math.min(
              call.openInterest ?? 0,
              put.openInterest ?? 0,
            ),
          });
        }
      }
    }

    // ── The distribution the badge hides ──────────────────────────────────────
    const rejected = all.filter((r) => r.rejected);
    const accepted = all.filter((r) => !r.rejected);

    log(`\n\n=== violation / threshold ratio (>1 = rejected) ===`);
    log(`pairs tested: ${all.length}, rejected: ${rejected.length}`);
    log(
      describeNums(
        "all pairs",
        all.map((r) => r.ratio),
      ),
    );
    log(
      describeNums(
        "rejected only",
        rejected.map((r) => r.ratio),
      ),
    );

    log(`\n=== is the rejection MARGINAL or GROSS? ===`);
    log("If violators cluster just above 1.0, the threshold is too tight.");
    log("If they sit far above it, the quotes are genuinely broken.\n");
    for (const [lo, hi] of [
      [1, 1.5],
      [1.5, 2],
      [2, 4],
      [4, 10],
      [10, Infinity],
    ] as const) {
      const n = rejected.filter((r) => r.ratio >= lo && r.ratio < hi).length;
      const pct = rejected.length ? (100 * n) / rejected.length : 0;
      const bar = "#".repeat(Math.round(pct / 2));
      log(
        `  ratio ${String(lo).padStart(4)}-${String(hi).padEnd(5)} ` +
          `${String(n).padStart(4)} (${pct.toFixed(1).padStart(5)}%) ${bar}`,
      );
    }

    log(`\n=== staleness evidence (independent of the parity maths) ===`);
    const withAge = (rs: readonly PairRecord[]) =>
      rs.map((r) => r.ageDays).filter((a): a is number => a !== null);
    log(describeNums("REJECTED age (days)", withAge(rejected)));
    log(describeNums("ACCEPTED age (days)", withAge(accepted)));
    log(
      describeNums(
        "REJECTED volume",
        rejected.map((r) => r.minVolume),
      ),
    );
    log(
      describeNums(
        "ACCEPTED volume",
        accepted.map((r) => r.minVolume),
      ),
    );
    log(
      describeNums(
        "REJECTED open int",
        rejected.map((r) => r.minOpenInterest),
      ),
    );
    log(
      describeNums(
        "ACCEPTED open int",
        accepted.map((r) => r.minOpenInterest),
      ),
    );

    const untraded = (rs: readonly PairRecord[]) =>
      rs.length
        ? (100 * rs.filter((r) => r.minVolume === 0).length) / rs.length
        : 0;
    log(
      `\n  a leg with ZERO volume:  rejected ${untraded(rejected).toFixed(1)}%  ` +
        `vs accepted ${untraded(accepted).toFixed(1)}%`,
    );

    // ── Counterfactual: what would loosening actually admit? ──────────────────
    log(`\n\n=== counterfactual: loosening halfSpreadMult ===`);
    log(
      "'newly admitted' = pairs a looser threshold would let INTO the metrics.",
    );
    log(
      "Their staleness is the cost of loosening: fresh = the check was wrong,",
    );
    log("stale = loosening is just readmitting the poison.\n");
    log(
      "  mult   rejected%   newly admitted   their median age(d)   their zero-vol%",
    );
    for (const mult of [2, 3, 4, 6, 8, 12]) {
      // Rescale each pair's threshold. The forward-uncertainty term scales with
      // the multiple too, so recompute rather than scaling the total.
      const rescaled = all.map((r) => {
        const base = Math.max(mult * r.halfSpreadSum, limits.tolerance);
        // The forward-uncertainty component of the original threshold, recovered
        // and rescaled by the new multiple.
        const fwdTerm =
          r.threshold -
          Math.max(limits.halfSpreadMult * r.halfSpreadSum, limits.tolerance);
        const threshold = base + (fwdTerm * mult) / limits.halfSpreadMult;
        return { ...r, wouldReject: r.violation > threshold };
      });
      const rej = rescaled.filter((r) => r.wouldReject);
      const newlyAdmitted = rescaled.filter(
        (r) => r.rejected && !r.wouldReject,
      );
      const ages = withAge(newlyAdmitted);
      const medAge = ages.length
        ? quantile(
            [...ages].sort((a, b) => a - b),
            0.5,
          )
        : NaN;
      const rejPct = all.length ? (100 * rej.length) / all.length : 0;
      log(
        `  ${String(mult).padStart(4)}   ${rejPct.toFixed(1).padStart(8)}%   ` +
          `${String(newlyAdmitted.length).padStart(14)}   ` +
          `${(Number.isFinite(medAge) ? medAge.toFixed(1) : "-").padStart(19)}   ` +
          `${untraded(newlyAdmitted).toFixed(1).padStart(14)}%`,
      );
    }

    // ── Where do the violations live? ────────────────────────────────────────
    log(`\n\n=== rejection rate by moneyness (ln K/F) ===`);
    for (const [lo, hi] of [
      [-Infinity, -0.2],
      [-0.2, -0.1],
      [-0.1, -0.02],
      [-0.02, 0.02],
      [0.02, 0.1],
      [0.1, 0.2],
      [0.2, Infinity],
    ] as const) {
      const band = all.filter((r) => r.moneyness >= lo && r.moneyness < hi);
      if (band.length === 0) continue;
      const n = band.filter((r) => r.rejected).length;
      const pct = (100 * n) / band.length;
      log(
        `  ${String(lo).padStart(5)}..${String(hi).padEnd(5)} ` +
          `n=${String(band.length).padStart(4)}  rejected ${pct.toFixed(1).padStart(5)}%  ` +
          `${"#".repeat(Math.round(pct / 2))}`,
      );
    }

    log(`\n=== per-ticker rejection rate ===`);
    for (const ticker of TICKERS) {
      const rs = all.filter((r) => r.ticker === ticker);
      if (rs.length === 0) continue;
      const rej = rs.filter((r) => r.rejected);
      const pct = (100 * rej.length) / rs.length;
      const ages = withAge(rej);
      const medAge = ages.length
        ? quantile(
            [...ages].sort((a, b) => a - b),
            0.5,
          )
        : NaN;
      const ratios = [...rej.map((r) => r.ratio)].sort((a, b) => a - b);
      log(
        `  ${ticker.padEnd(6)} pairs=${String(rs.length).padStart(4)}  ` +
          `rejected=${pct.toFixed(1).padStart(5)}%  ` +
          `median ratio=${(quantile(ratios, 0.5) || 0).toFixed(1).padStart(6)}  ` +
          `median age=${(Number.isFinite(medAge) ? medAge.toFixed(1) : "-").padStart(6)}d`,
      );
    }

    writeFileSync(
      "tests/diagnostics/parity-report.txt",
      OUT.join("\n"),
      "utf8",
    );
  });
});
