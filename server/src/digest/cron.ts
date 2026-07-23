/**
 * Weekly digest — scheduling + delivery (phase 3). An hourly tick checks
 * every active user's digest settings; a user whose local (America/Chicago)
 * day+hour match gets one digest per week, stamped in settings for
 * restart idempotency. Empty digests are skipped (still stamped, so the
 * week's slot is consumed) unless digest_always=true.
 */

import cron from 'node-cron';
import { getDb } from '../db/connection.js';
import { getSetting, setSetting } from '../db/queries.js';
import { getEnabledChannels, type EnabledChannels } from '../scheduler/cron.js';
import { sendNtfyDigest } from '../notifications/ntfy.js';
import { sendDiscordDigest } from '../notifications/discord.js';
import { sendEmailDigest } from '../notifications/email.js';
import { sendGenericDigest } from '../notifications/webhook.js';
import { gatherDigestData } from './data.js';
import { isDigestDue, isDigestEmpty, renderDigestHtml, renderDigestText } from './build.js';
import { logger } from '../logger.js';

const PUBLIC_URL = 'https://prices.schultzsolutions.tech';

/** Channel fallback order when digest_channel is unset (spec §Phase 3). */
const CHANNEL_ORDER = ['ntfy', 'discord', 'email', 'webhook'] as const;
type DigestChannel = (typeof CHANNEL_ORDER)[number];

export function resolveDigestChannel(
  explicit: string | undefined,
  channels: EnabledChannels,
): DigestChannel | null {
  const configured = (ch: DigestChannel): boolean =>
    ch === 'ntfy' ? !!channels.ntfy
    : ch === 'discord' ? !!channels.discord
    : ch === 'email' ? !!channels.email
    : !!channels.webhook;

  if (explicit && (CHANNEL_ORDER as readonly string[]).includes(explicit)) {
    return configured(explicit as DigestChannel) ? (explicit as DigestChannel) : null;
  }
  for (const ch of CHANNEL_ORDER) if (configured(ch)) return ch;
  return null;
}

/** One user's digest attempt. Exported for tests and the force-send path. */
export async function runDigestForUser(
  userId: number,
  nowMs: number,
  opts: { force?: boolean } = {},
): Promise<'sent' | 'skipped_empty' | 'not_due' | 'no_channel' | 'send_failed'> {
  const settings = {
    enabled: getSetting('digest_enabled', userId),
    channel: getSetting('digest_channel', userId),
    day: getSetting('digest_day', userId),
    hour: getSetting('digest_hour', userId),
    always: getSetting('digest_always', userId),
    lastSentAt: getSetting('digest_last_sent_at', userId),
  };

  if (!opts.force && !isDigestDue(settings, nowMs)) return 'not_due';

  const channels = getEnabledChannels(userId);
  const channel = resolveDigestChannel(settings.channel, channels);
  if (!channel) {
    logger.info({ userId }, 'digest: due but no notification channel configured');
    return 'no_channel';
  }

  const data = gatherDigestData(userId, nowMs);
  const stamp = (): void =>
    setSetting('digest_last_sent_at', new Date(nowMs).toISOString(), userId);

  if (isDigestEmpty(data) && (settings.always ?? 'false').toLowerCase() !== 'true') {
    stamp(); // consume this week's slot — an empty week stays quiet
    logger.info({ userId }, 'digest: empty week, skipped');
    return 'skipped_empty';
  }

  const { title, body } = renderDigestText(data, PUBLIC_URL);
  let ok = false;
  switch (channel) {
    case 'ntfy':
      ok = await sendNtfyDigest(title, body, channels.ntfy!, channels.ntfyToken, PUBLIC_URL);
      break;
    case 'discord':
      ok = await sendDiscordDigest(title, body, channels.discord!);
      break;
    case 'email':
      ok = await sendEmailDigest(channels.email!, title, body, renderDigestHtml(data, PUBLIC_URL));
      break;
    case 'webhook':
      ok = await sendGenericDigest(channels.webhook!, { title, body, data });
      break;
  }

  if (!ok) {
    // No stamp — the next hourly tick inside the send window retries once
    // per hour until the window passes. A flaky channel gets ~1h of retries,
    // not a silent lost week.
    logger.warn({ userId, channel }, 'digest: send failed');
    return 'send_failed';
  }
  stamp();
  logger.info({ userId, channel }, 'digest: sent');
  return 'sent';
}

async function tick(): Promise<void> {
  const nowMs = Date.now();
  const users = getDb()
    .prepare('SELECT id FROM users WHERE is_active = 1')
    .all() as Array<{ id: number }>;
  for (const { id } of users) {
    try {
      await runDigestForUser(id, nowMs);
    } catch (err) {
      logger.error({ userId: id, err }, 'digest: tick failed for user');
    }
  }
}

let task: cron.ScheduledTask | null = null;

export function startDigestCron(): void {
  if (task) return;
  // Minute 7 — clear of the minute-0 scraper burst.
  task = cron.schedule('7 * * * *', () => { void tick(); });
  logger.info('Weekly digest cron started (hourly check, minute 7)');
}

export function stopDigestCron(): void {
  if (task) {
    task.stop();
    task = null;
  }
}
