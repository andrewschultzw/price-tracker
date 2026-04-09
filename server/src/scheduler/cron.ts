import cron from 'node-cron';
import PQueue from 'p-queue';
import {
  getDueTrackerUrls,
  getTrackerUrlById,
  getTrackerById,
  updateTrackerUrl,
  refreshTrackerAggregates,
  addPriceRecord,
  getSetting,
  getLastNotificationForSeller,
  addNotification,
} from '../db/queries.js';
import type { Tracker, TrackerUrl } from '../db/queries.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordPriceAlert, sendDiscordErrorAlert } from '../notifications/discord.js';
import { sendNtfyPriceAlert, sendNtfyErrorAlert } from '../notifications/ntfy.js';
import { sendGenericPriceAlert, sendGenericErrorAlert } from '../notifications/webhook.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const queue = new PQueue({ concurrency: config.maxConcurrentScrapes });
let task: cron.ScheduledTask | null = null;

interface EnabledChannels {
  discord?: string;
  ntfy?: string;
  // Optional Bearer token for self-hosted ntfy instances with
  // deny-all auth. Only meaningful when ntfy is also set.
  ntfyToken?: string;
  webhook?: string;
}

function getEnabledChannels(userId: number | null | undefined): EnabledChannels {
  if (!userId) return {};
  return {
    discord: getSetting('discord_webhook_url', userId) || undefined,
    ntfy: getSetting('ntfy_url', userId) || undefined,
    ntfyToken: getSetting('ntfy_token', userId) || undefined,
    webhook: getSetting('generic_webhook_url', userId) || undefined,
  };
}

function hasAnyChannel(channels: EnabledChannels): boolean {
  return !!(channels.discord || channels.ntfy || channels.webhook);
}

/**
 * Build a "synthetic tracker" that carries the seller's URL and price so
 * notification channels (which still take a Tracker for back-compat) see
 * the right URL in the message body. The name is appended with the seller
 * hostname so alerts say "Husq Chainsaw Case @ amazon.com".
 */
function buildAlertTracker(tracker: Tracker, seller: TrackerUrl, currentPrice: number | null): Tracker {
  let host = '';
  try { host = new URL(seller.url).hostname.replace(/^www\./, ''); } catch { host = ''; }
  return {
    ...tracker,
    url: seller.url,
    name: host ? `${tracker.name} @ ${host}` : tracker.name,
    last_price: currentPrice ?? tracker.last_price,
    last_error: seller.last_error,
    consecutive_failures: seller.consecutive_failures,
  };
}

async function firePriceAlerts(
  alertTracker: Tracker,
  currentPrice: number,
  channels: EnabledChannels,
): Promise<string[]> {
  const attempts: { name: string; promise: Promise<boolean> }[] = [];
  if (channels.discord) attempts.push({ name: 'discord', promise: sendDiscordPriceAlert(alertTracker, currentPrice, channels.discord) });
  if (channels.ntfy) attempts.push({ name: 'ntfy', promise: sendNtfyPriceAlert(alertTracker, currentPrice, channels.ntfy, channels.ntfyToken) });
  if (channels.webhook) attempts.push({ name: 'webhook', promise: sendGenericPriceAlert(alertTracker, currentPrice, channels.webhook) });
  const results = await Promise.all(attempts.map(a => a.promise));
  return attempts.filter((_, i) => results[i]).map(a => a.name);
}

async function fireErrorAlerts(
  alertTracker: Tracker,
  error: string,
  channels: EnabledChannels,
): Promise<void> {
  const senders: Promise<boolean>[] = [];
  if (channels.discord) senders.push(sendDiscordErrorAlert(alertTracker, error, channels.discord));
  if (channels.ntfy) senders.push(sendNtfyErrorAlert(alertTracker, error, channels.ntfy, channels.ntfyToken));
  if (channels.webhook) senders.push(sendGenericErrorAlert(alertTracker, error, channels.webhook));
  await Promise.all(senders);
}

/**
 * Scrape a single seller (tracker_urls row). This replaces the old
 * per-tracker checkTracker(). After updating the seller's own state, we
 * re-aggregate the parent tracker's denormalized fields so the dashboard
 * keeps showing the lowest-across-sellers price.
 */
export async function checkTrackerUrl(trackerUrlId: number): Promise<void> {
  try {
    const seller = getTrackerUrlById(trackerUrlId);
    if (!seller) return;
    const tracker = getTrackerById(seller.tracker_id);
    if (!tracker) return;

    const channels = getEnabledChannels(tracker.user_id);

    logger.info(
      { trackerId: tracker.id, trackerUrlId: seller.id, name: tracker.name, sellerUrl: seller.url },
      'Checking seller',
    );

    try {
      const result = await extractPrice(seller.url, tracker.css_selector);

      addPriceRecord(tracker.id, result.price, result.currency, seller.id);

      updateTrackerUrl(seller.id, {
        last_price: result.price,
        last_checked_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        last_error: null,
        consecutive_failures: 0,
        status: 'active',
      });
      refreshTrackerAggregates(tracker.id);

      logger.info(
        { trackerId: tracker.id, trackerUrlId: seller.id, price: result.price, strategy: result.strategy },
        'Seller price check complete',
      );

      // Per-seller threshold + cooldown + fanout. The threshold on the
      // tracker applies to every seller — any seller dropping below it is
      // news worth an alert.
      if (tracker.threshold_price && result.price <= tracker.threshold_price) {
        if (!hasAnyChannel(channels)) {
          logger.warn(
            {
              trackerId: tracker.id,
              trackerUrlId: seller.id,
              trackerName: tracker.name,
              sellerUrl: seller.url,
              userId: tracker.user_id,
              currentPrice: result.price,
              thresholdPrice: tracker.threshold_price,
            },
            'Seller price is at/below threshold but no notification channels are configured — alert skipped',
          );
        } else {
          // Cooldown is per-(tracker, seller): "don't spam about the same
          // seller" — but Amazon dropping doesn't silence a subsequent
          // Newegg drop, which is the whole point of multi-seller.
          const lastNotif = getLastNotificationForSeller(tracker.id, seller.id);
          const cooldownMs = config.notificationCooldownHours * 60 * 60 * 1000;
          const inCooldown =
            lastNotif && Date.now() - new Date(lastNotif.sent_at + 'Z').getTime() < cooldownMs;

          if (inCooldown) {
            logger.debug(
              { trackerId: tracker.id, trackerUrlId: seller.id },
              'Per-seller notification cooldown active, skipping',
            );
          } else {
            const alertTracker = buildAlertTracker(tracker, seller, result.price);
            const sentChannels = await firePriceAlerts(alertTracker, result.price, channels);
            for (const channel of sentChannels) {
              addNotification(tracker.id, result.price, tracker.threshold_price, channel, seller.id);
            }
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failures = seller.consecutive_failures + 1;
      const newStatus = failures >= config.maxConsecutiveFailures ? 'error' : seller.status;

      updateTrackerUrl(seller.id, {
        last_checked_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        last_error: errorMsg,
        consecutive_failures: failures,
        status: newStatus,
      });
      refreshTrackerAggregates(tracker.id);

      logger.error(
        { trackerId: tracker.id, trackerUrlId: seller.id, failures, err: errorMsg },
        'Seller price check failed',
      );

      if (newStatus === 'error') {
        if (!hasAnyChannel(channels)) {
          logger.warn(
            { trackerId: tracker.id, trackerUrlId: seller.id, trackerName: tracker.name, userId: tracker.user_id },
            'Seller errored but no notification channels are configured — error alert skipped',
          );
        } else {
          const alertTracker = buildAlertTracker(tracker, { ...seller, last_error: errorMsg, consecutive_failures: failures }, null);
          await fireErrorAlerts(alertTracker, errorMsg, channels);
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('FOREIGN KEY constraint failed')) {
      logger.warn({ trackerUrlId }, 'Seller was deleted during scrape, skipping');
      return;
    }
    throw err;
  }
}

/**
 * Legacy entry point retained for the manual "Check Now" button on
 * TrackerDetail. Fans the request out to every seller for the tracker so
 * the user sees all their seller prices refresh.
 */
export async function checkTracker(trackerId: number): Promise<void> {
  const { getTrackerUrlsForTracker } = await import('../db/queries.js');
  const sellers = getTrackerUrlsForTracker(trackerId);
  await Promise.all(sellers.map(s => checkTrackerUrl(s.id)));
}

function tick(): void {
  const due = getDueTrackerUrls();
  if (due.length === 0) return;

  logger.debug({ count: due.length }, 'Due sellers found');

  for (const seller of due) {
    queue.add(() => checkTrackerUrl(seller.id));
  }
}

export function startScheduler(): void {
  task = cron.schedule('* * * * *', tick);
  logger.info('Scheduler started (checking every minute)');
}

export function stopScheduler(): void {
  if (task) {
    task.stop();
    task = null;
    logger.info('Scheduler stopped');
  }
}
