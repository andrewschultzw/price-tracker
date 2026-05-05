import type { Tracker } from '../db/queries.js';
import { logger } from '../logger.js';

/**
 * Generic JSON webhook. POSTs a fixed-schema JSON body to any user-supplied
 * URL — intended as an escape hatch for Home Assistant, Slack incoming
 * webhooks, n8n, Mattermost, custom bots, etc. Users who need to reshape the
 * payload should put something like n8n between us and their destination.
 *
 * Payload schema:
 *   {
 *     "event": "price_drop" | "tracker_error" | "test",
 *     "tracker": { "id", "name", "url", "threshold_price" },
 *     "current_price": number | null,
 *     "savings": number | null,     // price_drop only
 *     "error": string | null,       // tracker_error only
 *     "consecutive_failures": number | null,
 *     "timestamp": ISO-8601 string
 *   }
 */

function assertWebhookUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Webhook URL must be http or https');
  }
}

export async function sendGenericPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  webhookUrl: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (!tracker.threshold_price) return false;

  try {
    assertWebhookUrl(webhookUrl);
    const payload = {
      event: 'price_drop' as const,
      tracker: {
        id: tracker.id,
        name: tracker.name,
        url: tracker.url,
        threshold_price: tracker.threshold_price,
      },
      current_price: currentPrice,
      savings: Number((tracker.threshold_price - currentPrice).toFixed(2)),
      error: null,
      consecutive_failures: null,
      ai_commentary: aiCommentary || null,
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, body: await response.text(), trackerId: tracker.id },
        'Generic webhook price alert failed',
      );
      return false;
    }

    logger.info({ trackerId: tracker.id, price: currentPrice }, 'Generic webhook price alert sent');
    return true;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Generic webhook request failed');
    return false;
  }
}

export async function sendGenericErrorAlert(
  tracker: Tracker,
  error: string,
  webhookUrl: string,
): Promise<boolean> {
  try {
    assertWebhookUrl(webhookUrl);
    const payload = {
      event: 'tracker_error' as const,
      tracker: {
        id: tracker.id,
        name: tracker.name,
        url: tracker.url,
        threshold_price: tracker.threshold_price,
      },
      current_price: tracker.last_price,
      savings: null,
      error,
      consecutive_failures: tracker.consecutive_failures,
      timestamp: new Date().toISOString(),
    };
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Generic webhook error alert failed');
    return false;
  }
}

import type { Project as ProjectType3, BasketState as BasketStateType3, BasketMember as BasketMemberType3 } from '../projects/types.js';

export async function sendGenericBasketAlert(
  project: ProjectType3,
  basket: BasketStateType3,
  members: BasketMemberType3[],
  webhookUrl: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;
  try {
    assertWebhookUrl(webhookUrl);
    const payload = {
      event: 'bundle_ready' as const,
      project: {
        id: project.id, name: project.name,
        target_total: project.target_total, status: project.status,
      },
      basket: {
        total: basket.total,
        target_total: basket.target_total,
        savings: project.target_total - basket.total,
        item_count: basket.item_count,
      },
      members: members.map(m => ({
        tracker_id: m.tracker_id,
        tracker_name: m.tracker_name,
        last_price: m.last_price,
        per_item_ceiling: m.per_item_ceiling,
        ai_verdict_tier: m.ai_verdict_tier,
      })),
      ai_commentary: aiCommentary ?? null,
    };
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.ok;
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'Generic webhook basket alert failed');
    return false;
  }
}

export async function testGenericWebhook(webhookUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    assertWebhookUrl(webhookUrl);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'test',
        message: 'Price Tracker test notification',
        timestamp: new Date().toISOString(),
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `Webhook returned ${response.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
