/**
 * Alerts engine — decide what is worth telling you about, and only once.
 *
 * Two rules govern this file:
 *
 *  1. **Dedupe or it becomes noise.** A z-score that crosses ±2.5 will still be
 *     across ±2.5 at the next scan, and the one after that. Firing every time
 *     turns the feed into wallpaper, and wallpaper gets ignored — which is worse
 *     than no alert at all, because you will stop reading the one that matters.
 *     Hence a cooldown per `(ticker, type)`.
 *
 *  2. **Say when a signal is not what it appears.** Alerts driven by a proxied IV
 *     rank are tagged, and can be suppressed entirely (`alerts.fireOnProxiedIvRank`).
 */

import { logger } from "../../logger";
import type { HedgeConfig } from "../config";
import type { HedgeDb } from "../db/client";
import { getDb } from "../db/client";
import type { TickerMetrics } from "../metrics/engine";
import type { PairMetric } from "../metrics/pairs";
import type { Setup } from "../scanners";

/** What kind of thing fired. */
export type AlertType =
  | "iv_rank_extreme"
  | "skew_zscore"
  | "term_inversion"
  | "correlation_break"
  | "pair_zscore"
  | "vrp_extreme"
  | "scanner_top"
  | "data_quality";

/** How loudly to shout. */
export type AlertSeverity = "info" | "warn" | "critical";

/** A candidate alert, before dedupe. */
export interface AlertDraft {
  ticker: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  detail: string;
  /** True when the alert rests on a proxied (realized-vol) IV rank. */
  proxied: boolean;
}

/** A persisted alert. */
export interface AlertRecord extends AlertDraft {
  id: number;
  createdAt: string;
  scanId: number | null;
  deliveredSlack: boolean;
}

/** The cooldown key: one alert of a given type per ticker per cooldown window. */
function dedupeKey(draft: AlertDraft): string {
  return `${draft.ticker}:${draft.type}`;
}

/**
 * Build every alert this scan's metrics justify.
 *
 * @param metrics - Every ticker's metrics.
 * @param pairs - Every configured pair.
 * @param setups - Every setup produced this scan.
 * @param config - Thresholds.
 * @returns Candidate alerts, before dedupe.
 */
export function buildAlerts(
  metrics: readonly TickerMetrics[],
  pairs: readonly PairMetric[],
  setups: readonly Setup[],
  config: HedgeConfig,
): AlertDraft[] {
  const cfg = config.alerts;
  const out: AlertDraft[] = [];

  for (const m of metrics) {
    // ── z-score crossings ──
    // A cross-sectional z answers "unusual vs the universe today", not "unusual
    // vs this ticker's own history". Alerting on it is fair; letting you think it
    // is the time-series version is not.
    const skewBasisNote =
      m.skewZBasis === "cross_sectional"
        ? " (measured across the universe today, not against this ticker's own history — no skew history has accumulated yet)"
        : "";

    const zChecks: { z: number | null; label: string; type: AlertType }[] = [
      { z: m.putSkewZ, label: "Put skew", type: "skew_zscore" },
      { z: m.callPutSpreadZ, label: "Call/put IV spread", type: "skew_zscore" },
      { z: m.vrpZ, label: "Variance risk premium", type: "vrp_extreme" },
    ];
    for (const c of zChecks) {
      if (c.z === null || Math.abs(c.z) < cfg.zScoreThreshold) continue;
      out.push({
        ticker: m.ticker,
        type: c.type,
        severity:
          Math.abs(c.z) >= cfg.zScoreThreshold * 1.5 ? "critical" : "warn",
        title: `${m.ticker}: ${c.label} at ${c.z.toFixed(1)}σ`,
        detail:
          `${c.label} is ${c.z.toFixed(2)} standard deviations from its ` +
          `trailing mean — ${c.z > 0 ? "unusually elevated" : "unusually depressed"}.` +
          (c.type === "skew_zscore" ? skewBasisNote : ""),
        proxied: false,
      });
    }

    // ── term-structure inversion ──
    // Front-month vol above back-month means the market is pricing a near-term
    // event. It is a regime statement, not a noisy threshold crossing.
    if (cfg.onTermInversion && m.termInverted && m.termSlope !== null) {
      out.push({
        ticker: m.ticker,
        type: "term_inversion",
        severity: "warn",
        title: `${m.ticker}: term structure inverted (${m.termSlope.toFixed(1)} vol pts)`,
        detail:
          `30-day implied vol is above 90-day by ${Math.abs(m.termSlope).toFixed(1)} vol points. ` +
          `The market is pricing a near-term event; calendar spreads and short-dated ` +
          `premium selling both change character here.`,
        proxied: false,
      });
    }

    // ── correlation regime break ──
    if (
      cfg.onCorrelationRegimeBreak &&
      m.corrSpy60d !== null &&
      m.ticker !== config.context.benchmark
    ) {
      // A defensive asset that starts moving WITH equities has stopped being a
      // diversifier — which is exactly when you needed it to be one.
      const isBond = ["TLT", "LQD", "HYG"].includes(m.ticker);
      if (isBond && m.corrSpy60d > 0.5) {
        out.push({
          ticker: m.ticker,
          type: "correlation_break",
          severity: "critical",
          title: `${m.ticker}: correlation to SPY flipped positive (${m.corrSpy60d.toFixed(2)})`,
          detail:
            `${m.ticker} is now moving WITH equities (60-day correlation ` +
            `${m.corrSpy60d.toFixed(2)}). It has stopped diversifying an equity book ` +
            `precisely when that matters most.`,
          proxied: false,
        });
      }
    }

    // ── data quality ──
    if (m.dataQuality === "poor") {
      out.push({
        ticker: m.ticker,
        type: "data_quality",
        severity: "info",
        title: `${m.ticker}: chain data is unusable`,
        detail:
          `${m.parityViolations} of ${m.contractsTotal} contracts violate put-call ` +
          `parity — the chain is mostly stale. Metrics for this ticker should not be trusted.`,
        proxied: false,
      });
    }
  }

  // ── pair z-scores, but ONLY if the pair actually mean-reverts ──
  for (const p of pairs) {
    if (p.zScore === null || Math.abs(p.zScore) < cfg.zScoreThreshold) continue;
    // The A3 guard, applied at the alert boundary too. Alerting on a stretched
    // spread that never reverts is an invitation to fade a permanent trend.
    if (!p.tradeable) continue;

    out.push({
      ticker: p.pairId,
      type: "pair_zscore",
      severity: "warn",
      title: `${p.label}: ${p.zScore.toFixed(1)}σ stretched`,
      detail:
        `The ${p.label} log-ratio is ${p.zScore.toFixed(2)}σ from its ${p.halfLife?.toFixed(0)}-day ` +
        `half-life mean. This pair passes the mean-reversion test, so the stretch is ` +
        `expected to close.`,
      proxied: false,
    });
  }

  // ── a scanner's top setup crossing the score threshold ──
  const bestByScanner = new Map<string, Setup>();
  for (const s of setups) {
    const best = bestByScanner.get(s.scanner);
    if (!best || s.score > best.score) bestByScanner.set(s.scanner, s);
  }
  for (const s of bestByScanner.values()) {
    if (s.score < cfg.scannerScoreThreshold) continue;
    out.push({
      ticker: s.ticker,
      type: "scanner_top",
      severity: "info",
      title: `${s.ticker}: strong ${s.scanner} setup (score ${s.score.toFixed(1)})`,
      detail: s.summary,
      proxied: s.proxied,
    });
  }

  // Suppress proxied-IV-rank alerts if you asked for that.
  return cfg.fireOnProxiedIvRank ? out : out.filter((a) => !a.proxied);
}

/**
 * Persist the alerts that clear the cooldown.
 *
 * @param drafts - Candidate alerts.
 * @param scanId - The scan that produced them.
 * @param config - Supplies `alerts.cooldownDays`.
 * @param db - Database handle.
 * @param now - Injected for deterministic tests.
 * @returns Only the alerts that actually fired.
 */
export function fireAlerts(
  drafts: readonly AlertDraft[],
  scanId: number,
  config: HedgeConfig,
  db: HedgeDb = getDb(),
  now: Date = new Date(),
): AlertRecord[] {
  const cooldownMs = config.alerts.cooldownDays * 86_400_000;
  const cutoff = new Date(now.getTime() - cooldownMs).toISOString();
  const fired: AlertRecord[] = [];

  for (const draft of drafts) {
    const key = dedupeKey(draft);

    const recent = db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM alerts
        WHERE dedupe_key = :key AND created_at >= :cutoff`,
      { key, cutoff },
    );
    if ((recent?.n ?? 0) > 0) continue; // still inside the cooldown

    const createdAt = now.toISOString();
    db.run(
      `INSERT INTO alerts
         (created_at, scan_id, ticker, type, severity, title, detail, proxied, dedupe_key)
       VALUES
         (:createdAt, :scanId, :ticker, :type, :severity, :title, :detail, :proxied, :key)`,
      {
        createdAt,
        scanId,
        ticker: draft.ticker,
        type: draft.type,
        severity: draft.severity,
        title: draft.title,
        detail: draft.detail,
        proxied: draft.proxied ? 1 : 0,
        key,
      },
    );
    const row = db.get<{ id: number }>("SELECT last_insert_rowid() AS id");

    fired.push({
      ...draft,
      id: row?.id ?? 0,
      createdAt,
      scanId,
      deliveredSlack: false,
    });
  }

  if (drafts.length > fired.length) {
    logger.info("hedge.alerts deduped", {
      candidates: drafts.length,
      fired: fired.length,
      suppressed: drafts.length - fired.length,
    });
  }
  return fired;
}

/**
 * Read the alert feed, newest first.
 *
 * @param limit - Maximum rows.
 * @param db - Database handle.
 * @returns Recent alerts.
 */
export function listAlerts(limit = 50, db: HedgeDb = getDb()): AlertRecord[] {
  return db
    .all<
      Record<string, unknown>
    >(`SELECT * FROM alerts ORDER BY created_at DESC, id DESC LIMIT :limit`, { limit })
    .map((r) => ({
      id: Number(r.id),
      createdAt: String(r.created_at),
      scanId: r.scan_id === null ? null : Number(r.scan_id),
      ticker: String(r.ticker),
      type: r.type as AlertType,
      severity: r.severity as AlertSeverity,
      title: String(r.title),
      detail: String(r.detail),
      proxied: r.proxied === 1,
      deliveredSlack: r.delivered_slack === 1,
    }));
}

/** Mark an alert as delivered to Slack. */
export function markSlackDelivered(id: number, db: HedgeDb = getDb()): void {
  db.run("UPDATE alerts SET delivered_slack = 1 WHERE id = :id", { id });
}
