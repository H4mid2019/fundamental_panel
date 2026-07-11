/**
 * Protective put finder — buy downside insurance while it is cheap.
 *
 * Admission: **IV rank below the configured floor AND price above the 200-day MA.**
 * The pairing is deliberate. Cheap vol on its own is not a reason to buy
 * protection (vol is usually cheap because nothing is happening); an uptrend on
 * its own is not a reason either (you would just be paying carry). It is the
 * combination — an asset you still want to own, whose insurance happens to be on
 * sale — that makes the trade.
 *
 * ⚠️ IV rank is the gate here, and until ~60 days of real IV history accumulate it
 * is a **realized-volatility rank wearing an IV-rank costume**. Every setup this
 * scanner emits in that period is marked `proxied`. VRP, which needs no history,
 * is the honest cross-check and is reported alongside.
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

export const protectivePutScanner: Scanner = {
  id: "protectivePut",

  run(ctx: ScanContext): Setup | null {
    const { metrics: m, surface, config } = ctx;
    const cfg = config.scanners.protectivePut;
    if (!cfg.enabled) return null;

    // Protection is cheap AND the asset is still in an uptrend.
    if (m.ivRank === null || m.ivRank > cfg.maxIvRank) return null;
    if (m.pctVs200dma === null || m.pctVs200dma < cfg.minPctVs200dma)
      return null;

    const expiry = pickExpiry(
      surface.expiries,
      cfg.dteRange[0],
      cfg.dteRange[1],
    );
    if (!expiry) return null;

    // Mid-point of the configured OTM band, below spot.
    const otmPct = -(cfg.otmPctRange[0] + cfg.otmPctRange[1]) / 2;
    const put = pickByMoneyness(expiry.puts, surface.spot, otmPct);
    if (!put) return null;

    const spot = surface.spot;
    const costPct = (put.mid / spot) * 100;
    const annualizedCost = annualize(costPct, expiry.dte);
    const floorPct = (put.strike / spot - 1) * 100;

    // Cheaper IV rank scores better; a negative VRP (protection underpriced
    // relative to what vol is *actually* doing) scores better still.
    let score = (cfg.maxIvRank - m.ivRank) / 10;

    const vrpCfg = config.scanners.vrp;
    if (m.vrpZ !== null) score -= vrpCfg.rankWeight * m.vrpZ;
    // Hard gate, only if you asked for one: refuse to call protection "cheap"
    // when it is expensive relative to realized vol, whatever IV rank says.
    if (
      vrpCfg.hardGate &&
      m.vrp !== null &&
      m.vrp > vrpCfg.maxVrpForProtection
    ) {
      return null;
    }

    const warnings: string[] = [];
    if (m.ivRankProxied) {
      warnings.push(
        `IV rank is proxied from realized vol (${m.ivHistoryDays} real days) — ` +
          `this gate is not yet reading true implied vol`,
      );
    }
    if (m.vrp !== null && m.vrp > 0) {
      warnings.push(
        `IV rank says cheap, but VRP is +${m.vrp.toFixed(1)} — implied is running ` +
          `ABOVE realized, so protection is not cheap versus reality`,
      );
    }
    if (
      earningsInTenor(
        m.earningsDate,
        expiry.expiration,
        surface.expiries[0]?.expiration ?? "",
      )
    ) {
      warnings.push(`Earnings ${m.earningsDate} falls inside the tenor`);
    }
    if (m.dataQuality !== "good") {
      warnings.push(`Chain data quality is ${m.dataQuality}`);
    }
    if (m.ratesFallback) {
      warnings.push("Deltas used a fallback rate or dividend yield");
    }

    return {
      scanner: "protectivePut",
      ticker: m.ticker,
      score,
      legs: [toLeg("buy", put, expiry)],
      stats: {
        ivRank: round(m.ivRank, 1),
        vrp: round(m.vrp),
        cost: round(put.mid),
        costPct: round(costPct),
        annualizedCost: round(annualizedCost),
        floorPct: round(floorPct),
        pctVs200dma: round(m.pctVs200dma, 1),
        dte: expiry.dte,
        iv: round(put.iv * 100, 1),
      },
      summary:
        `Buy ${expiry.expiration} ${put.strike}P for ${put.mid.toFixed(2)} — ` +
        `${costPct.toFixed(2)}% of notional (${annualizedCost.toFixed(1)}% annualized) ` +
        `to floor losses at ${floorPct.toFixed(1)}%.`,
      warnings,
      proxied: m.ivRankProxied,
      ratesFallback: m.ratesFallback,
      dataQuality: m.dataQuality,
      signalHash: hashSignal("protectivePut", m.ticker, [
        expiry.expiration,
        put.strike,
        round(m.ivRank, 0),
      ]),
    };
  },
};
