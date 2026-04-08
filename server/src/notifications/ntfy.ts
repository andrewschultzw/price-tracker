import type { Tracker } from '../db/queries.js';
import { logger } from '../logger.js';

/**
 * ntfy publishes a plain-text body as the message, and uses HTTP headers for
 * title, priority, click-through URL, and tags. Works with ntfy.sh or any
 * self-hosted ntfy instance — the user just pastes their topic URL
 * (e.g. https://ntfy.sh/my-price-alerts).
 *
 * See https://docs.ntfy.sh/publish/
 */

function assertNtfyUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('ntfy URL must be http or https');
  }
}

export async function sendNtfyPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  ntfyUrl: string,
): Promise<boolean> {
  if (!tracker.threshold_price) return false;

  try {
    assertNtfyUrl(ntfyUrl);
    const savings = (tracker.threshold_price - currentPrice).toFixed(2);
    const body = `Now $${currentPrice.toFixed(2)} (target $${tracker.threshold_price.toFixed(2)}, save $${savings})`;

    const response = await fetch(ntfyUrl, {
      method: 'POST',
      headers: {
        'Title': `Price Drop: ${tracker.name}`,
        'Priority': 'high',
        'Tags': 'tada,money_with_wings',
        'Click': tracker.url,
      },
      body,
    });

    if (!response.ok) {
      logger.error(
        { status: response.status, body: await response.text(), trackerId: tracker.id },
        'ntfy price alert failed',
      );
      return false;
    }

    logger.info({ trackerId: tracker.id, price: currentPrice }, 'ntfy price alert sent');
    return true;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'ntfy request failed');
    return false;
  }
}

export async function sendNtfyErrorAlert(
  tracker: Tracker,
  error: string,
  ntfyUrl: string,
): Promise<boolean> {
  try {
    assertNtfyUrl(ntfyUrl);
    const body = `Scrape failed ${tracker.consecutive_failures}x: ${error.slice(0, 300)}`;
    const response = await fetch(ntfyUrl, {
      method: 'POST',
      headers: {
        'Title': `Tracker Error: ${tracker.name}`,
        'Priority': 'default',
        'Tags': 'warning',
        'Click': tracker.url,
      },
      body,
    });
    return response.ok;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'ntfy error alert failed');
    return false;
  }
}

export async function testNtfyWebhook(ntfyUrl: string): Promise<boolean> {
  try {
    assertNtfyUrl(ntfyUrl);
    const response = await fetch(ntfyUrl, {
      method: 'POST',
      headers: {
        'Title': 'Price Tracker — Test Notification',
        'Priority': 'default',
        'Tags': 'white_check_mark',
      },
      body: 'ntfy is wired up and working correctly.',
    });
    return response.ok;
  } catch {
    return false;
  }
}
