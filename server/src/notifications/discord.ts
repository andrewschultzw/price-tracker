import { config } from '../config.js';
import { getLastNotification, addNotification } from '../db/queries.js';
import type { Tracker } from '../db/queries.js';
import { logger } from '../logger.js';

export async function sendPriceAlert(tracker: Tracker, currentPrice: number, webhookUrl: string | null): Promise<boolean> {
  if (!webhookUrl) {
    // Warn (not debug) so silent-failure mode is visible in journalctl.
    // This fires every time a below-threshold tracker is checked for a user
    // with no webhook configured — a real problem the user almost certainly
    // wants to know about.
    logger.warn(
      {
        trackerId: tracker.id,
        trackerName: tracker.name,
        userId: tracker.user_id,
        currentPrice,
        thresholdPrice: tracker.threshold_price,
      },
      'Price is at/below threshold but no Discord webhook is configured — notification skipped',
    );
    return false;
  }

  if (!tracker.threshold_price) return false;

  // Check cooldown
  const lastNotif = getLastNotification(tracker.id);
  if (lastNotif) {
    const cooldownMs = config.notificationCooldownHours * 60 * 60 * 1000;
    const lastSentAt = new Date(lastNotif.sent_at + 'Z').getTime();
    if (Date.now() - lastSentAt < cooldownMs) {
      logger.debug({ trackerId: tracker.id }, 'Notification cooldown active, skipping');
      return false;
    }
  }

  // Only notify if price is at or below threshold
  if (currentPrice > tracker.threshold_price) return false;

  const savings = (tracker.threshold_price - currentPrice).toFixed(2);

  const embed = {
    title: `Price Drop Alert: ${tracker.name}`,
    color: 0x00c853, // Green
    fields: [
      { name: 'Current Price', value: `$${currentPrice.toFixed(2)}`, inline: true },
      { name: 'Threshold', value: `$${tracker.threshold_price.toFixed(2)}`, inline: true },
      { name: 'Savings', value: `$${savings}`, inline: true },
    ],
    url: tracker.url,
    timestamp: new Date().toISOString(),
    footer: { text: 'Price Tracker' },
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!response.ok) {
      logger.error({ status: response.status, body: await response.text() }, 'Discord webhook failed');
      return false;
    }

    addNotification(tracker.id, currentPrice, tracker.threshold_price);
    logger.info({ trackerId: tracker.id, price: currentPrice }, 'Discord notification sent');
    return true;
  } catch (err) {
    logger.error({ err }, 'Discord webhook request failed');
    return false;
  }
}

export async function sendErrorAlert(tracker: Tracker, error: string, webhookUrl: string | null): Promise<void> {
  if (!webhookUrl) {
    logger.warn(
      { trackerId: tracker.id, trackerName: tracker.name, userId: tracker.user_id },
      'Tracker errored but no Discord webhook is configured — error alert skipped',
    );
    return;
  }

  const embed = {
    title: `Tracker Error: ${tracker.name}`,
    color: 0xff1744, // Red
    description: `Failed to check price after ${tracker.consecutive_failures} consecutive attempts.`,
    fields: [
      { name: 'Error', value: error.slice(0, 1024) },
      { name: 'URL', value: tracker.url },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'Price Tracker' },
  };

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to send error alert to Discord');
  }
}

export async function testWebhook(webhookUrl: string): Promise<boolean> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          title: 'Price Tracker — Test Notification',
          description: 'Webhook is working correctly!',
          color: 0x2196f3,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
