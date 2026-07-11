/**
 * Slack delivery — optional, and silent when unconfigured.
 *
 * This is the *only* way HedgeScope reaches you when the tab is closed. Be honest
 * about that: without `SLACK_WEBHOOK_URL` set, alerts exist solely in the database
 * and the dashboard, and you will not learn about them until you next look. There
 * is no push notification, no email, no background worker with your phone number.
 */

import { env, features } from "../../env";
import { logger } from "../../logger";
import type { HedgeDb } from "../db/client";

import { markSlackDelivered, type AlertRecord } from "./engine";

/** Slack's colour bar per severity. */
const COLOR: Record<AlertRecord["severity"], string> = {
  info: "#4a90d9",
  warn: "#e8a33d",
  critical: "#d64545",
};

/**
 * Post alerts to the configured Slack webhook.
 *
 * Skipped silently when no webhook is set — that is a configuration choice, not an
 * error, and it must never fail a scan. A delivery failure is likewise logged and
 * swallowed: the alerts are already durably in the database, and losing a scan
 * because Slack had a bad minute would be absurd.
 *
 * @param alerts - The alerts that fired this scan.
 * @param db - Database handle, for marking delivery.
 * @returns How many were delivered.
 */
export async function deliverToSlack(
  alerts: readonly AlertRecord[],
  db?: HedgeDb,
): Promise<number> {
  if (!features.slack || !env.SLACK_WEBHOOK_URL) return 0;
  if (alerts.length === 0) return 0;

  // One message per scan, not one per alert — a scan that trips twelve thresholds
  // should not send twelve pings.
  const attachments = alerts.slice(0, 20).map((a) => ({
    color: COLOR[a.severity],
    title: a.title,
    text: a.proxied ? `${a.detail}\n_(based on a proxied IV rank)_` : a.detail,
    footer: `HedgeScope · ${a.type}`,
  }));

  // Deliberately plain `fetch`, not this repo's `fetchJson`: a Slack webhook
  // answers with the bare string `ok`, not JSON, so `fetchJson` would fail to
  // parse it and report a delivery failure on every *successful* post.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `HedgeScope: ${alerts.length} new alert${alerts.length === 1 ? "" : "s"}`,
        attachments,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      logger.warn(
        "hedge.slack delivery failed; alerts remain in the database",
        {
          status: response.status,
          alerts: alerts.length,
        },
      );
      return 0;
    }

    for (const a of alerts) {
      if (a.id > 0) markSlackDelivered(a.id, db);
    }
    logger.info("hedge.slack delivered", { count: alerts.length });
    return alerts.length;
  } catch (error) {
    // The alerts are already durably in the database. Losing a scan because
    // Slack had a bad minute would be absurd.
    logger.warn("hedge.slack delivery threw; alerts remain in the database", {
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  } finally {
    clearTimeout(timeout);
  }
}
