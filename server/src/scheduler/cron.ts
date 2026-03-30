import cron from 'node-cron';
import PQueue from 'p-queue';
import { getDueTrackers, updateTracker, addPriceRecord, getSetting } from '../db/queries.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendPriceAlert, sendErrorAlert } from '../notifications/discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const queue = new PQueue({ concurrency: config.maxConcurrentScrapes });
let task: cron.ScheduledTask | null = null;

export async function checkTracker(trackerId: number): Promise<void> {
  try {
    const { getTrackerById } = await import('../db/queries.js');
    const tracker = getTrackerById(trackerId);
    if (!tracker) return;

    const webhookUrl = tracker.user_id
      ? getSetting('discord_webhook_url', tracker.user_id) || null
      : null;

    logger.info({ trackerId: tracker.id, name: tracker.name }, 'Checking tracker');

    try {
      const result = await extractPrice(tracker.url, tracker.css_selector);

      // Store price history
      addPriceRecord(tracker.id, result.price, result.currency);

      // Update tracker
      updateTracker(tracker.id, {
        last_price: result.price,
        last_checked_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
        last_error: null,
        consecutive_failures: 0,
        status: 'active',
      });

      logger.info({ trackerId: tracker.id, price: result.price, strategy: result.strategy }, 'Price check complete');

      // Check threshold and notify
      if (tracker.threshold_price && result.price <= tracker.threshold_price) {
        await sendPriceAlert(tracker, result.price, webhookUrl);
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
        await sendErrorAlert(tracker, errorMsg, webhookUrl);
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
  // Run every minute
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
