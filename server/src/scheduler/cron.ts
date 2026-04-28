import cron from 'node-cron';
import PQueue from 'p-queue';
import { normalizeTrackerUrl } from '../lib/normalize-url.js';
import {
  getDueTrackerUrls,
  getTrackerUrlById,
  getTrackerById,
  updateTrackerUrl,
  updateTrackerNormalizedUrl,
  refreshTrackerAggregates,
  addPriceRecord,
  getSetting,
  getLastNotificationForSeller,
  addNotification,
  getRecentSuccessfulPricesForSeller,
  getSellersWithPendingConfirmation,
} from '../db/queries.js';
import type { Tracker, TrackerUrl } from '../db/queries.js';
import { extractPrice } from '../scraper/extractor.js';
import {
  isPlausibilityGuardSuspicious,
  computePlausibilityBaseline,
} from '../scraper/plausibility-guard.js';
import { sendDiscordPriceAlert, sendDiscordErrorAlert } from '../notifications/discord.js';
import { sendNtfyPriceAlert, sendNtfyErrorAlert } from '../notifications/ntfy.js';
import { sendGenericPriceAlert, sendGenericErrorAlert } from '../notifications/webhook.js';
import { sendEmailPriceAlert, sendEmailErrorAlert } from '../notifications/email.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const queue = new PQueue({ concurrency: config.maxConcurrentScrapes });
let task: cron.ScheduledTask | null = null;

const PLAUSIBILITY_GUARD_MEDIAN_WINDOW = 10;
const PLAUSIBILITY_CONFIRM_DELAY_BASE_MS = 90_000;
const PLAUSIBILITY_CONFIRM_DELAY_JITTER_MS = 90_000;
const PLAUSIBILITY_RESTART_STALE_AGE_MS = 600_000;

interface EnabledChannels {
  discord?: string;
  ntfy?: string;
  // Optional Bearer token for self-hosted ntfy instances with
  // deny-all auth. Only meaningful when ntfy is also set.
  ntfyToken?: string;
  webhook?: string;
  email?: string;
}

function getEnabledChannels(userId: number | null | undefined): EnabledChannels {
  if (!userId) return {};
  return {
    discord: getSetting('discord_webhook_url', userId) || undefined,
    ntfy: getSetting('ntfy_url', userId) || undefined,
    ntfyToken: getSetting('ntfy_token', userId) || undefined,
    webhook: getSetting('generic_webhook_url', userId) || undefined,
    email: getSetting('email_recipient', userId) || undefined,
  };
}

function hasAnyChannel(channels: EnabledChannels): boolean {
  return !!(channels.discord || channels.ntfy || channels.webhook || channels.email);
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
  if (channels.email) attempts.push({ name: 'email', promise: sendEmailPriceAlert(alertTracker, currentPrice, channels.email) });
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
  if (channels.email) senders.push(sendEmailErrorAlert(alertTracker, error, channels.email));
  await Promise.all(senders);
}

/**
 * Scrape a single seller (tracker_urls row). This replaces the old
 * per-tracker checkTracker(). After updating the seller's own state, we
 * re-aggregate the parent tracker's denormalized fields so the dashboard
 * keeps showing the lowest-across-sellers price.
 *
 * `bypassCooldown` is true for manual actions ("Check Now" button, adding
 * a new seller URL) — the user is explicitly asking for a fresh result
 * and silently suppressing a ready-to-send alert because of an arbitrary
 * 6-hour timer is surprising. The scheduler's automatic tick always passes
 * false so spam protection still works for unattended scraping.
 */
export async function checkTrackerUrl(
  trackerUrlId: number,
  bypassCooldown: boolean = false,
): Promise<void> {
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

      // If this was the primary seller (position=0), re-normalize using
      // the finalUrl Playwright resolved. Short links (a.co/d/xyz) now
      // map to their actual product page so overlap matching works.
      if (seller.position === 0) {
        const normalized = normalizeTrackerUrl(result.finalUrl);
        if (normalized !== tracker.normalized_url) {
          updateTrackerNormalizedUrl(tracker.id, normalized);
        }
      }

      refreshTrackerAggregates(tracker.id);

      logger.info(
        { trackerId: tracker.id, trackerUrlId: seller.id, price: result.price, strategy: result.strategy },
        'Seller price check complete',
      );

      // Per-seller threshold + cooldown + fanout. The threshold on the
      // tracker applies to every seller — any seller dropping below it is
      // news worth an alert.
      // Gate alerts on `result.price > 0`. A zero (or sub-cent) price
      // never represents a real product offer — it's the signature of a
      // page-parse glitch (e.g., a regex matching "$0" in promo copy).
      // The plausibility guard below cannot defend against a 0 price
      // alone because `getRecentSuccessfulPricesForSeller` filters
      // `price > 0`, so the just-recorded zero row is absent and
      // `recentPrices.slice(1)` would discard a real prior price. Block
      // here instead.
      if (
        tracker.threshold_price &&
        result.price > 0 &&
        result.price <= tracker.threshold_price
      ) {
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
          // Newegg drop, which is the whole point of multi-seller. Manual
          // actions (Check Now button, adding a new seller) bypass cooldown
          // entirely because the user is explicitly asking for a result.
          const lastNotif = bypassCooldown ? null : getLastNotificationForSeller(tracker.id, seller.id);
          const cooldownMs = config.notificationCooldownHours * 60 * 60 * 1000;
          const inCooldown =
            !!lastNotif && Date.now() - new Date(lastNotif.sent_at + 'Z').getTime() < cooldownMs;

          if (inCooldown) {
            // Logged at info (not debug) so the user can see why an
            // expected alert didn't fire without enabling verbose logging.
            // The earlier "silent skip" bug in the no-webhook case proved
            // the cost of hiding suppression at debug level.
            const sentAtMs = new Date(lastNotif!.sent_at + 'Z').getTime();
            const minutesUntilReady = Math.ceil((cooldownMs - (Date.now() - sentAtMs)) / 60000);
            logger.info(
              {
                trackerId: tracker.id,
                trackerUrlId: seller.id,
                trackerName: tracker.name,
                sellerUrl: seller.url,
                lastSentAt: lastNotif!.sent_at,
                minutesUntilReady,
              },
              `Cooldown active for this seller — alert suppressed for ${minutesUntilReady} more minute(s)`,
            );
          } else {
            const recentPrices = getRecentSuccessfulPricesForSeller(
              seller.id,
              PLAUSIBILITY_GUARD_MEDIAN_WINDOW,
            );
            // The just-recorded scrape is in history now; drop it from
            // the baseline so we compare the new price against PRIOR
            // observations, not against itself.
            const baselineHistory = recentPrices.slice(1);
            const medianBaseline = computePlausibilityBaseline(baselineHistory);
            const suspicious = isPlausibilityGuardSuspicious(
              result.price,
              baselineHistory,
              config.plausibilityGuardDropThreshold,
            );

            const hadPending = seller.pending_confirmation_at !== null;

            if (suspicious && !hadPending) {
              // First time we've seen this — record pending state and
              // suppress alert. Confirmation comes from the next
              // successful scrape (timed re-scrape in Task 6, or the
              // next regular cron tick as a fallback).
              updateTrackerUrl(seller.id, {
                pending_confirmation_price: result.price,
                pending_confirmation_at: new Date()
                  .toISOString()
                  .replace('T', ' ')
                  .slice(0, 19),
              });
              logger.info(
                {
                  trackerId: tracker.id,
                  trackerUrlId: seller.id,
                  trackerName: tracker.name,
                  price: result.price,
                  medianBaseline,
                  baselineSamples: baselineHistory.length,
                  threshold: config.plausibilityGuardDropThreshold,
                },
                'Suspicious price detected, awaiting confirmation',
              );
              scheduleConfirmationRescrape(seller.id);
            } else if (suspicious && hadPending) {
              // Two suspicious-and-below-threshold reads in a row.
              // Treat as confirmed; clear pending and fire alert.
              updateTrackerUrl(seller.id, {
                pending_confirmation_price: null,
                pending_confirmation_at: null,
              });
              logger.info(
                {
                  trackerId: tracker.id,
                  trackerUrlId: seller.id,
                  firstPrice: seller.pending_confirmation_price,
                  secondPrice: result.price,
                },
                'Confirmation matched, firing alert',
              );
              const alertTracker = buildAlertTracker(tracker, seller, result.price);
              const sentChannels = await firePriceAlerts(alertTracker, result.price, channels);
              for (const channel of sentChannels) {
                addNotification(tracker.id, result.price, tracker.threshold_price, channel, seller.id);
              }
            } else if (!suspicious && hadPending) {
              // Pending was set, but the new read is plausible. Either
              // (a) the new price is back to normal (transient anomaly,
              // discard alert) or (b) the new price is also low but
              // within plausibility (real drop, has been confirmed).
              // The "below threshold" branch we're in already implies
              // the price is alert-worthy, so this is case (b): fire.
              updateTrackerUrl(seller.id, {
                pending_confirmation_price: null,
                pending_confirmation_at: null,
              });
              const alertTracker = buildAlertTracker(tracker, seller, result.price);
              const sentChannels = await firePriceAlerts(alertTracker, result.price, channels);
              for (const channel of sentChannels) {
                addNotification(tracker.id, result.price, tracker.threshold_price, channel, seller.id);
              }
            } else {
              // Not suspicious, no pending — normal alert path.
              const alertTracker = buildAlertTracker(tracker, seller, result.price);
              const sentChannels = await firePriceAlerts(alertTracker, result.price, channels);
              for (const channel of sentChannels) {
                addNotification(tracker.id, result.price, tracker.threshold_price, channel, seller.id);
              }
            }
          }
        }
      } else if (seller.pending_confirmation_at !== null) {
        // Pending flag was set on a prior tick when price was below
        // threshold; this scrape brought it back above threshold, so
        // the prior observation was a transient anomaly. Clear the
        // flag and log — no alert.
        updateTrackerUrl(seller.id, {
          pending_confirmation_price: null,
          pending_confirmation_at: null,
        });
        logger.warn(
          {
            trackerId: tracker.id,
            trackerUrlId: seller.id,
            firstPrice: seller.pending_confirmation_price,
            secondPrice: result.price,
            thresholdPrice: tracker.threshold_price,
          },
          'Confirmation diverged, alert suppressed',
        );
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
 * Entry point for the manual "Check Now" button on TrackerDetail and the
 * "Check All Now" button on the /errors page. Fans the request out to
 * every seller for the tracker. Manual invocations bypass the per-seller
 * cooldown by default since the user is explicitly asking for a fresh
 * result — callers can pass bypassCooldown=false to opt into cooldown
 * behavior (the scheduler tick does that via checkTrackerUrl directly).
 */
export async function checkTracker(
  trackerId: number,
  bypassCooldown: boolean = true,
): Promise<void> {
  const { getTrackerUrlsForTracker } = await import('../db/queries.js');
  const sellers = getTrackerUrlsForTracker(trackerId);
  await Promise.all(sellers.map(s => checkTrackerUrl(s.id, bypassCooldown)));
}

function tick(): void {
  const due = getDueTrackerUrls();
  if (due.length === 0) return;

  logger.debug({ count: due.length }, 'Due sellers found');

  for (const seller of due) {
    queue.add(() => checkTrackerUrl(seller.id));
  }
}

/**
 * Schedule a confirmation re-scrape of the given seller after a base
 * delay plus jitter (default 90s + uniform 0-90s). Uses the existing
 * p-queue so concurrency limits still apply. The setTimeout reference
 * is intentionally not retained — confirmations are best-effort and
 * the restart recovery path picks up any pending state if the timer
 * is lost (process exit, hot reload, etc.).
 */
function scheduleConfirmationRescrape(sellerId: number): void {
  const delayMs =
    PLAUSIBILITY_CONFIRM_DELAY_BASE_MS +
    Math.random() * PLAUSIBILITY_CONFIRM_DELAY_JITTER_MS;
  setTimeout(() => {
    queue.add(() => checkTrackerUrl(sellerId));
  }, delayMs);
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
