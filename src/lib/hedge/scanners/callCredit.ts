/**
 * Call credit spread / covered call ranker — sell upside when vol is rich and the
 * price is stretched.
 *
 * Admission: **IV rank above the floor AND price extended well beyond its 200-day
 * MA.** Rich vol makes the call worth selling; a stretched price makes the strike
 * more likely to survive. Either alone is a worse trade: selling calls into a rich
 * vol regime on a name that is merely drifting is how you get run over on the
 * breakout.
 *
 * A protective long wing is always attached rather than left optional. Naked short
 * calls have unbounded loss, and a screener that emits them as "setups" is
 * emitting a liability.
 *
 * ⚠️ IV rank gates this scanner too, so the same proxied-until-mature caveat as the
 * protective-put finder applies.
 */

import {
  annualize,
  earlyAssignmentRisk,
  earningsInTenor,
  hashSignal,
  pickByDelta,
  pickByMoneyness,
  pickExpiry,
  round,
  toLeg,
  type ScanContext,
  type Scanner,
  type Setup,
} from "./types";

export const callCreditScanner: Scanner = {
  id: "callCredit",

  run(ctx: ScanContext): Setup | null {
    const { metrics: m, surface, dividends, config } = ctx;
    const cfg = config.scanners.callCredit;
    if (!cfg.enabled) return null;

    if (m.ivRank === null || m.ivRank < cfg.minIvRank) return null;
    if (m.pctVs200dma === null || m.pctVs200dma < cfg.minPctVs200dma)
      return null;

    const expiry = pickExpiry(
      surface.expiries,
      cfg.dteRange[0],
      cfg.dteRange[1],
      {
        requireSkewUsable: true,
      },
    );
    if (!expiry) return null;

    const [lo, hi] = cfg.shortDeltaRange;
    const shortCall = pickByDelta(expiry.calls, (lo + hi) / 2, lo, hi);
    if (!shortCall) return null;

    const spot = surface.spot;

    // The protective wing, `wingWidthPct` further out. Never optional.
    const wingStrikePct =
      (shortCall.strike / spot - 1) * 100 + cfg.wingWidthPct;
    const longCall = pickByMoneyness(expiry.calls, spot, wingStrikePct);
    if (!longCall || longCall.strike <= shortCall.strike) return null;

    const credit = shortCall.mid - longCall.mid;
    if (credit <= 0) return null;

    const width = longCall.strike - shortCall.strike;
    const maxLoss = width - credit;
    if (maxLoss <= 0) return null;

    // Yield on the capital actually at risk, which is the width minus the credit —
    // not on notional. Quoting it on notional flatters the trade enormously.
    const yieldOnRisk = (credit / maxLoss) * 100;
    const annualizedYield = annualize(yieldOnRisk, expiry.dte);

    let score = (m.ivRank - cfg.minIvRank) / 10 + yieldOnRisk / 20;

    const vrpCfg = config.scanners.vrp;
    if (m.vrpZ !== null) score += vrpCfg.rankWeight * m.vrpZ;
    if (vrpCfg.hardGate && m.vrp !== null && m.vrp < vrpCfg.minVrpForSelling) {
      return null;
    }

    const warnings: string[] = [];
    if (m.ivRankProxied) {
      warnings.push(
        `IV rank is proxied from realized vol (${m.ivHistoryDays} real days) — ` +
          `this gate is not yet reading true implied vol`,
      );
    }

    // B7: the short call can be assigned early to capture a dividend.
    const assignment = earlyAssignmentRisk(
      shortCall.mid,
      spot,
      shortCall.strike,
      expiry.expiration,
      dividends,
      config.scanners.collar.exDivBuffer,
    );
    if (assignment.atRisk) {
      score -= 1;
      warnings.push(
        `Early-assignment risk: short call has ${assignment.extrinsic.toFixed(2)} extrinsic ` +
          `vs a ${(assignment.dividend ?? 0).toFixed(2)} dividend on ${dividends.nextExDate}`,
      );
    }

    if (
      earningsInTenor(
        m.earningsDate,
        expiry.expiration,
        surface.expiries[0]?.expiration ?? "",
      )
    ) {
      score -= 1;
      warnings.push(`Earnings ${m.earningsDate} falls inside the tenor`);
    }
    if (m.rsi14 !== null && m.rsi14 > 75) {
      warnings.push(
        `RSI ${m.rsi14.toFixed(0)} — stretched, but momentum can persist`,
      );
    }
    if (m.dataQuality !== "good") {
      warnings.push(`Chain data quality is ${m.dataQuality}`);
    }
    if (m.ratesFallback) {
      warnings.push("Deltas used a fallback rate or dividend yield");
    }

    return {
      scanner: "callCredit",
      ticker: m.ticker,
      score,
      legs: [toLeg("sell", shortCall, expiry), toLeg("buy", longCall, expiry)],
      stats: {
        ivRank: round(m.ivRank, 1),
        vrp: round(m.vrp),
        credit: round(credit),
        width: round(width),
        maxLoss: round(maxLoss),
        yieldOnRisk: round(yieldOnRisk, 1),
        annualizedYield: round(annualizedYield, 1),
        pctVs200dma: round(m.pctVs200dma, 1),
        shortDelta: round(shortCall.absDelta, 2),
        dte: expiry.dte,
      },
      summary:
        `Sell ${expiry.expiration} ${shortCall.strike}C / buy ${longCall.strike}C for ` +
        `${credit.toFixed(2)} credit — ${yieldOnRisk.toFixed(1)}% on risk ` +
        `(${annualizedYield.toFixed(0)}% annualized). Short leg is ${(shortCall.absDelta * 100).toFixed(0)}Δ.`,
      warnings,
      proxied: m.ivRankProxied,
      ratesFallback: m.ratesFallback,
      dataQuality: m.dataQuality,
      signalHash: hashSignal("callCredit", m.ticker, [
        expiry.expiration,
        shortCall.strike,
        longCall.strike,
        round(m.ivRank, 0),
      ]),
    };
  },
};
