/**
 * Collar scanner — sell an out-of-the-money call, buy an out-of-the-money put.
 *
 * Ranked by the **call-minus-put IV spread**: a collar is cheapest exactly when
 * the calls you are selling are rich relative to the puts you are buying. In
 * equities that is rare — the persistent put skew normally means you sell a cheap
 * call to fund an expensive put — so a positive call-put spread is the signal
 * worth hunting for.
 *
 * The raw score is only half the job. A collar with a beautiful IV spread that you
 * cannot get filled, or that gets your short call assigned the day before an
 * ex-dividend, is not a good trade. The penalties below are what separate a
 * screener from a trade list.
 */

import {
  annualize,
  earlyAssignmentRisk,
  earningsInTenor,
  hashSignal,
  pickByDelta,
  pickExpiry,
  round,
  toLeg,
  type ScanContext,
  type Scanner,
  type Setup,
} from "./types";

/** Sell a 20-30 delta call, buy a 20-25 delta put. */
export const collarScanner: Scanner = {
  id: "collar",

  run(ctx: ScanContext): Setup | null {
    const { metrics: m, surface, dividends, config } = ctx;
    const cfg = config.scanners.collar;
    if (!cfg.enabled) return null;

    // Wing metrics need a monthly: a weekly's ladder cannot reach 20-30 delta.
    const expiry = pickExpiry(
      surface.expiries,
      cfg.dteRange[0],
      cfg.dteRange[1],
      {
        requireSkewUsable: true,
      },
    );
    if (!expiry) return null;

    const [callLo, callHi] = cfg.shortCallDeltaRange;
    const [putLo, putHi] = cfg.longPutDeltaRange;

    const shortCall = pickByDelta(
      expiry.calls,
      (callLo + callHi) / 2,
      callLo,
      callHi,
    );
    const longPut = pickByDelta(expiry.puts, (putLo + putHi) / 2, putLo, putHi);
    if (!shortCall || !longPut) return null;

    const spot = surface.spot;

    // Net cost: positive = you pay to put the collar on, negative = you get paid.
    const netCost = longPut.mid - shortCall.mid;
    const netCostPct = (netCost / spot) * 100;

    // The floor and the cap are the whole point of a collar.
    const floorPct = (longPut.strike / spot - 1) * 100; // negative
    const capPct = (shortCall.strike / spot - 1) * 100; // positive
    // Carry: what the structure costs (or pays) per year, as a % of notional.
    const annualizedCarry = annualize(-netCostPct, expiry.dte);

    // ── Score: richness of calls versus puts, in vol points. ──
    const ivSpread = (shortCall.iv - longPut.iv) * 100;
    let score = ivSpread;

    const warnings: string[] = [];

    // ── Penalties ──
    if (
      earningsInTenor(
        m.earningsDate,
        expiry.expiration,
        surface.expiries[0]?.expiration ?? "",
      )
    ) {
      score -= cfg.penalties.earningsInTenor;
      warnings.push(`Earnings ${m.earningsDate} falls inside the tenor`);
    }

    // B7: not merely "a dividend exists", but "the short call's remaining time
    // value is worth less than the dividend the holder captures by exercising".
    const assignment = earlyAssignmentRisk(
      shortCall.mid,
      spot,
      shortCall.strike,
      expiry.expiration,
      dividends,
      cfg.exDivBuffer,
    );
    if (assignment.atRisk) {
      score -= cfg.penalties.exDivBeforeExpiry;
      warnings.push(
        `Early-assignment risk: short call has ${assignment.extrinsic.toFixed(2)} extrinsic ` +
          `vs a ${(assignment.dividend ?? 0).toFixed(2)} dividend on ${dividends.nextExDate}`,
      );
    }

    const worstSpread = Math.max(shortCall.relSpread, longPut.relSpread) * 100;
    if (worstSpread > cfg.maxRelativeSpreadPct) {
      score -= cfg.penalties.wideSpread;
      warnings.push(`Wide market: ${worstSpread.toFixed(0)}% of mid`);
    }

    const worstOi = Math.min(
      shortCall.openInterest ?? 0,
      longPut.openInterest ?? 0,
    );
    if (worstOi < cfg.minOpenInterest) {
      score -= cfg.penalties.thinOpenInterest;
      warnings.push(`Thin open interest: ${worstOi}`);
    }

    if (m.dataQuality !== "good") {
      warnings.push(`Chain data quality is ${m.dataQuality}`);
    }
    if (m.ratesFallback) {
      warnings.push("Deltas used a fallback rate or dividend yield");
    }

    // VRP as a ranking input, or a hard gate if you asked for one.
    const vrpCfg = config.scanners.vrp;
    if (m.vrpZ !== null) score += vrpCfg.rankWeight * m.vrpZ;
    if (vrpCfg.hardGate && m.vrp !== null && m.vrp < vrpCfg.minVrpForSelling) {
      return null;
    }

    return {
      scanner: "collar",
      ticker: m.ticker,
      score,
      legs: [toLeg("sell", shortCall, expiry), toLeg("buy", longPut, expiry)],
      stats: {
        ivSpread: round(ivSpread),
        netCost: round(netCost),
        netCostPct: round(netCostPct),
        floorPct: round(floorPct),
        capPct: round(capPct),
        annualizedCarry: round(annualizedCarry),
        dte: expiry.dte,
        vrp: round(m.vrp),
        callIv: round(shortCall.iv * 100, 1),
        putIv: round(longPut.iv * 100, 1),
      },
      summary:
        `Sell ${expiry.expiration} ${shortCall.strike}C / buy ${longPut.strike}P for ` +
        `${netCost >= 0 ? "a net debit" : "a net credit"} of ${Math.abs(netCost).toFixed(2)} ` +
        `(${Math.abs(netCostPct).toFixed(2)}% of spot). Floor ${floorPct.toFixed(1)}%, ` +
        `cap +${capPct.toFixed(1)}%.`,
      warnings,
      proxied: m.ivRankProxied,
      ratesFallback: m.ratesFallback,
      dataQuality: m.dataQuality,
      signalHash: hashSignal("collar", m.ticker, [
        expiry.expiration,
        shortCall.strike,
        longPut.strike,
        round(ivSpread, 1),
      ]),
    };
  },
};
