import type { Tracker, TrackerUrlCondition } from '../db/queries.js';
import type { Confidence } from '../ai/confidence.js';
import { logger } from '../logger.js';
import { conditionLabel, formatPriceWithCondition } from './condition-label.js';

function discordTitlePrefix(level: Confidence['level']): string {
  if (level === 'HIGH') return '🟢 STRONG BUY — ';
  if (level === 'MEDIUM') return '🟡 GOOD DEAL — ';
  return '';
}

/**
 * Pure HTTP sender for Discord. Threshold checks and cooldown are handled
 * upstream in cron.ts so all notification channels share the same logic.
 *
 * `condition` (when non-'new') tags the Current Price field so a user sees
 * "$239.00 (Warehouse)" instead of just "$239.00" — disambiguates a
 * winning warehouse / refurb / open-box listing from a fresh-new one.
 */
export async function sendDiscordPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  webhookUrl: string,
  aiCommentary?: string | null,
  confidence?: Confidence | null,
  condition?: TrackerUrlCondition | null,
): Promise<boolean> {
  if (!tracker.threshold_price) return false;

  const savings = (tracker.threshold_price - currentPrice).toFixed(2);

  const titlePrefix = confidence ? discordTitlePrefix(confidence.level) : '';

  const embed: Record<string, unknown> = {
    title: `${titlePrefix}Price Drop Alert: ${tracker.name}`,
    color: 0x00c853,
    fields: [
      { name: 'Current Price', value: formatPriceWithCondition(currentPrice, condition), inline: true },
      { name: 'Threshold', value: `$${tracker.threshold_price.toFixed(2)}`, inline: true },
      { name: 'Savings', value: `$${savings}`, inline: true },
    ],
    url: tracker.url,
    timestamp: new Date().toISOString(),
    footer: { text: 'Price Tracker' },
  };

  // Build description: aiCommentary (when present) above reasons line.
  const descriptionParts: string[] = [];
  if (aiCommentary) descriptionParts.push(aiCommentary);
  if (confidence && confidence.reasons.length > 0) {
    descriptionParts.push(confidence.reasons.join(' · '));
  }
  if (descriptionParts.length > 0) {
    embed.description = descriptionParts.join('\n');
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, body: await response.text(), trackerId: tracker.id },
        'Discord webhook failed',
      );
      return false;
    }

    logger.info({ trackerId: tracker.id, price: currentPrice }, 'Discord price alert sent');
    return true;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Discord webhook request failed');
    return false;
  }
}

export async function sendDiscordErrorAlert(
  tracker: Tracker,
  error: string,
  webhookUrl: string,
): Promise<boolean> {
  const embed = {
    title: `Tracker Error: ${tracker.name}`,
    color: 0xff1744,
    description: `Failed to check price after ${tracker.consecutive_failures} consecutive attempts.`,
    fields: [
      { name: 'Error', value: error.slice(0, 1024) },
      { name: 'URL', value: tracker.url },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Price Tracker' },
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return response.ok;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Discord error alert failed');
    return false;
  }
}

import type { Project, BasketState, BasketMember } from '../projects/types.js';

export async function sendDiscordBasketAlert(
  project: Project,
  basket: BasketState,
  members: BasketMember[],
  webhookUrl: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;
  const savings = (project.target_total - basket.total).toFixed(2);
  const memberLines = members
    .map(m => `• ${m.tracker_name} — $${(m.last_price ?? 0).toFixed(2)}`)
    .join('\n');
  const baseDescription = `${memberLines}`;
  const description = aiCommentary
    ? `${baseDescription}\n\n${aiCommentary}`
    : baseDescription;

  const embed: Record<string, unknown> = {
    title: `Bundle Ready: ${project.name}`,
    color: 0x00c853,
    description,
    fields: [
      { name: 'Total', value: `$${basket.total.toFixed(2)}`, inline: true },
      { name: 'Target', value: `$${project.target_total.toFixed(2)}`, inline: true },
      { name: 'Savings', value: `$${savings}`, inline: true },
      { name: 'Items', value: String(basket.item_count), inline: true },
    ],
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return resp.ok;
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'Discord basket alert failed');
    return false;
  }
}

export async function sendDiscordPurchaseArm(
  trackerName: string,
  currentPrice: number,
  threshold: number,
  buyUrl: string,
  webhookUrl: string,
): Promise<boolean> {
  const embed = {
    title: `🛒 Ready to buy: ${trackerName}`,
    color: 0xff9900,
    description: `Hit **$${currentPrice.toFixed(2)}** (your limit $${threshold.toFixed(2)}).`,
    fields: [{ name: 'Approve', value: `[Review & buy →](${buyUrl})` }],
  };
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return resp.ok;
  } catch (err) {
    logger.error({ err }, 'Discord purchase-arm failed');
    return false;
  }
}

export async function testDiscordWebhook(webhookUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'Price Tracker - Test Notification',
          description: 'Webhook is working correctly!',
          color: 0x2196f3,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `Discord returned ${response.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
