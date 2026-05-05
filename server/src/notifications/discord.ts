import type { Tracker } from '../db/queries.js';
import { logger } from '../logger.js';

/**
 * Pure HTTP sender for Discord. Threshold checks and cooldown are handled
 * upstream in cron.ts so all notification channels share the same logic.
 */
export async function sendDiscordPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  webhookUrl: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (!tracker.threshold_price) return false;

  const savings = (tracker.threshold_price - currentPrice).toFixed(2);

  const embed: Record<string, unknown> = {
    title: `Price Drop Alert: ${tracker.name}`,
    color: 0x00c853,
    fields: [
      { name: 'Current Price', value: `$${currentPrice.toFixed(2)}`, inline: true },
      { name: 'Threshold', value: `$${tracker.threshold_price.toFixed(2)}`, inline: true },
      { name: 'Savings', value: `$${savings}`, inline: true },
    ],
    url: tracker.url,
    timestamp: new Date().toISOString(),
    footer: { text: 'Price Tracker' },
  };

  if (aiCommentary) {
    embed.description = aiCommentary;
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
