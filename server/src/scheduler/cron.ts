import cron from 'node-cron';
import PQueue from 'p-queue';
import {
  getDueTrackers,
  updateTracker,
  addPriceRecord,
  getSetting,
  getLastNotification,
  addNotification,
} from '../db/queries.js';
import type { Tracker } from '../db/queries.js';
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
  webhook?: string;
}

function getEnabledChannels(userId: number | null | undefined): EnabledChannels {
  if (!userId) return {};
  return {
    discord: getSetting('discord_webhook_url', userId) || undefined,
    ntfy: getSetting('ntfy_url', userId) || undefined,
    webhook: getSetting('generic_webhook_url', userId) || undefined,
  };
}

function hasAnyChannel(channels: EnabledChannels): boolean {
  return !!(channels.discord || channels.ntfy || channels.webhook);
}

async function firePriceAlerts(
  tracker: Tracker,
  currentPrice: number,
  channels: EnabledChannels,
): Promise<string[]> {
  // Returns the list of channel names that successfully delivered. The caller
  // uses this to record one notifications row per successful channel.
  const attempts: { name: string; promise: Promise<boolean> }[] = [];
  if (channels.discord) attempts.push({ name: 'discord', promise: sendDiscordPriceAlert(tracker, currentPrice, channels.discord) });
  if (channels.ntfy) attempts.push({ name: 'ntfy', promise: sendNtfyPriceAlert(tracker, currentPrice, channels.ntfy) });
  if (channels.webhook) attempts.push({ name: 'webhook', promise: sendGenericPriceAlert(tracker, currentPrice, channels.webhook) });

  const results = await Promise.all(attempts.map(a => a.promise));
  return attempts.filter((_, i) => results[i]).map(a => a.name);
}

async function fireErrorAlerts(
  tracker: Tracker,
  error: string,
  channels: EnabledChannels,
): Promise<void> {
  const senders: Promise<boolean>[] = [];
  if (channels.discord) senders.push(sendDiscordErrorAlert(tracker, error, channels.discord));
  if (channels.ntfy) senders.push(sendNtfyErrorAlert(tracker, error, channels.ntfy));
  if (channels.webhook) senders.push(sendGenericErrorAlert(tracker, error, channels.webhook));
  await Promise.all(senders);
}

export async function checkTracker(trackerId: number): Promise<void> {
  try {
    const { getTrackerById } = await import('../db/queries.js');
    const tracker = getTrackerById(trackerId);
    if (!tracker) return;

    const channels = getEnabledChannels(tracker.user_id);

    logger.info({ trackerId: tracker.id, name: tracker.name }, 'Checking tracker');

    try {
      const result = await extractPrice(tracker.url, tracker.css_selector);

      addPriceRecord(tracker.id, result.price, result.currency);

      updateTracker(tracker.id, {
        last_price: result.price,
        last_checked_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        last_error: null,
        consecutive_failures: 0,
        status: 'active',
      });

      logger.info(
        { trackerId: tracker.id, price: result.price, strategy: result.strategy },
        'Price check complete',
      );

      // Threshold check + cooldown + fanout — centralized here so every
      // notification channel shares the same gating.
      if (tracker.threshold_price && result.price <= tracker.threshold_price) {
        if (!hasAnyChannel(channels)) {
          logger.warn(
            {
              trackerId: tracker.id,
              trackerName: tracker.name,
              userId: tracker.user_id,
              currentPrice: result.price,
              thresholdPrice: tracker.threshold_price,
            },
            'Price is at/below threshold but no notification channels are configured — alert skipped',
          );
        } else {
          // Cooldown is per-tracker, not per-channel: the point is "don't spam
          // the user about the same item too often". If any channel succeeds,
          // we record the notification and the cooldown applies to all channels
          // on the next pass.
          const lastNotif = getLastNotification(tracker.id);
          const cooldownMs = config.notificationCooldownHours * 60 * 60 * 1000;
          const inCooldown =
            lastNotif && Date.now() - new Date(lastNotif.sent_at + 'Z').getTime() < cooldownMs;

          if (inCooldown) {
            logger.debug({ trackerId: tracker.id }, 'Notification cooldown active, skipping');
          } else {
            const sentChannels = await firePriceAlerts(tracker, result.price, channels);
            for (const channel of sentChannels) {
              addNotification(tracker.id, result.price, tracker.threshold_price, channel);
            }
          }
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const failures = tracker.consecutive_failures + 1;
      const newStatus = failures >= config.maxConsecutiveFailures ? 'error' : tracker.status;

      updateTracker(tracker.id, {
        last_checked_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        last_error: errorMsg,
        consecutive_failures: failures,
        status: newStatus,
      });

      logger.error({ trackerId: tracker.id, failures, err: errorMsg }, 'Price check failed');

      if (newStatus === 'error') {
        if (!hasAnyChannel(channels)) {
          logger.warn(
            { trackerId: tracker.id, trackerName: tracker.name, userId: tracker.user_id },
            'Tracker errored but no notification channels are configured — error alert skipped',
          );
        } else {
          await fireErrorAlerts(tracker, errorMsg, channels);
        }
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes('FOREIGN KEY constraint failed')) {
      logger.warn({ trackerId }, 'Tracker was deleted during scrape, skipping');
      return;
    }
    throw err;
  }
}

function tick(): void {
  const due = getDueTrackers();
  if (due.length === 0) return;

  logger.debug({ count: due.length }, 'Due trackers found');

  for (const tracker of due) {
    queue.add(() => checkTracker(tracker.id));
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
