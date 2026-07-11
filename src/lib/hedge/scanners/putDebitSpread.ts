/**
 * Put debit spread scanner — buy a near-the-money put, sell a further one.
 *
 * Ranked by **put-skew steepness (z-score)**. The logic is structural: a steep put
 * skew means the deep out-of-the-money put you are *selling* is priced at a much
 * higher implied vol than the one you are *buying*. You are short the expensive
 * wing and long the cheap body, so the spread is financed by the market's own fear
 * premium. When the skew is flat there is no such subsidy and the same structure
 * is simply a worse trade.
 *
 * Hence the ranking is on the skew z-score, not on the skew level: a name whose
 * skew is always steep offers no edge by being steep again today.
 */

import {
  annualize,
  earningsInTenor,
  hashSignal,
  pickByMoneyness,
  pickExpiry,
  round,
  toLeg,
  type ScanContext,
  type Scanner,
  type Setup,
} from "./types";

export const putDebitSpreadScanner: Scanner = {
  id: "putDebitSpread",

  run(ctx: ScanContext): Setup | null {
    const { metrics: m, surface, config } = ctx;
    const cfg = config.scanners.putDebitSpread;
    if (!cfg.enabled) return null;

    // No skew reading, no ranking — this scanner is *defined* by the skew.
    if (m.putSkewZ === null || m.putSkewZ < cfg.minSkewZ) return null;

    const expiry = pickExpiry(
      surface.expiries,
      cfg.dteRange[0],
      cfg.dteRange[1],
      {
        requireSkewUsable: true,
      },
    );
    if (!expiry) return null;

    const spot = surface.spot;
    const longPut = pickByMoneyness(expiry.puts, spot, cfg.longStrikeOffsetPct);
    const shortPut = pickByMoneyness(
      expiry.puts,
      spot,
      cfg.shortStrikeOffsetPct,
    );
    if (!longPut || !shortPut) return null;

    // A "spread" whose legs collapsed onto the same strike is not a spread.
    if (longPut.strike <= shortPut.strike) return null;

    const netDebit = longPut.mid - shortPut.mid;
    if (netDebit <= 0) return null; // a credit here means the quotes are nonsense

    const width = longPut.strike - shortPut.strike;
    const maxPayoff = width - netDebit;
    // The number that actually matters: how much you win if you are right,
    // per unit risked.
    const payoffRatio = maxPayoff / netDebit;

    const costPct = (netDebit / spot) * 100;

    let score = m.putSkewZ + payoffRatio / 2;

    const warnings: string[] = [];
    if (
      earningsInTenor(
        m.earningsDate,
        expiry.expiration,
        surface.expiries[0]?.expiration ?? "",
      )
    ) {
      warnings.push(`Earnings ${m.earningsDate} falls inside the tenor`);
      score -= 0.5;
    }
    if (m.dataQuality !== "good") {
      warnings.push(`Chain data quality is ${m.dataQuality}`);
    }
    if (m.ratesFallback) {
      warnings.push("Deltas used a fallback rate or dividend yield");
    }
    const worstOi = Math.min(
      longPut.openInterest ?? 0,
      shortPut.openInterest ?? 0,
    );
    if (worstOi < 100) warnings.push(`Thin open interest: ${worstOi}`);

    return {
      scanner: "putDebitSpread",
      ticker: m.ticker,
      score,
      legs: [toLeg("buy", longPut, expiry), toLeg("sell", shortPut, expiry)],
      stats: {
        putSkewZ: round(m.putSkewZ),
        putSkew: round(m.putSkew25d),
        netDebit: round(netDebit),
        costPct: round(costPct),
        width: round(width),
        maxPayoff: round(maxPayoff),
        payoffRatio: round(payoffRatio),
        annualizedCost: round(annualize(costPct, expiry.dte)),
        dte: expiry.dte,
      },
      summary:
        `Buy ${expiry.expiration} ${longPut.strike}P / sell ${shortPut.strike}P for ` +
        `${netDebit.toFixed(2)} debit. Pays ${payoffRatio.toFixed(1)}:1 if it works; ` +
        `skew is ${m.putSkewZ.toFixed(1)}σ steep.`,
      warnings,
      proxied: m.ivRankProxied,
      ratesFallback: m.ratesFallback,
      dataQuality: m.dataQuality,
      signalHash: hashSignal("putDebitSpread", m.ticker, [
        expiry.expiration,
        longPut.strike,
        shortPut.strike,
        round(m.putSkewZ, 1),
      ]),
    };
  },
};
