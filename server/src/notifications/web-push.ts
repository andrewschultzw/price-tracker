// server/src/notifications/web-push.ts
import webpush from 'web-push';
import {
  getActiveWebPushSubscriptionsForUser,
  deleteWebPushSubscriptionByEndpoint,
  updateWebPushLastUsedAt,
} from '../db/queries.js';
import { logger } from '../logger.js';
import type { Tracker, TrackerUrlCondition } from '../db/queries.js';
import type { Confidence } from '../ai/confidence.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';
import { formatPriceWithCondition } from './condition-label.js';

function webPushBodyPrefix(level: Confidence['level']): string {
  if (level === 'HIGH') return '🟢 ';
  if (level === 'MEDIUM') return '🟡 ';
  return '';
}

interface WebPushError extends Error {
  statusCode?: number;
}

function configureVapid(): boolean {
  const pub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '';
  const priv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '';
  const subject = process.env.WEB_PUSH_SUBJECT || '';
  // Silent return when not configured — the channel naturally inert. A
  // one-time startup warning lives in index.ts so the operator knows once
  // at boot rather than per-alert.
  if (!pub || !priv || !subject) return false;
  try {
    webpush.setVapidDetails(subject, pub, priv);
    return true;
  } catch (err) {
    logger.error({ err: String(err) }, 'web_push_vapid_setup_failed');
    return false;
  }
}

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

async function dispatchToAllSubs(userId: number, payload: PushPayload): Promise<boolean> {
  if (!configureVapid()) return false;

  const subs = getActiveWebPushSubscriptionsForUser(userId);
  if (subs.length === 0) return false;

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(subs.map(async (sub) => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh_key, auth: sub.auth_key },
    };
    const startMs = Date.now();
    try {
      await webpush.sendNotification(subscription, body);
      updateWebPushLastUsedAt(sub.id);
      logger.info({
        user_id: userId, subscription_id: sub.id, status: 'ok',
        endpoint_host: new URL(sub.endpoint).hostname,
        latency_ms: Date.now() - startMs,
      }, 'web_push_send');
      return true;
    } catch (err) {
      const wpe = err as WebPushError;
      const status = wpe.statusCode;
      if (status === 410 || status === 404) {
        deleteWebPushSubscriptionByEndpoint(sub.endpoint);
        logger.info({
          user_id: userId, subscription_id: sub.id, status,
        }, 'web_push_subscription_stale');
      } else {
        logger.warn({
          user_id: userId, subscription_id: sub.id, status, err: String(err),
        }, 'web_push_send_failed');
      }
      return false;
    }
  }));

  return results.some(r => r.status === 'fulfilled' && r.value === true);
}

export async function sendWebPushPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  userId: number,
  aiCommentary: string | null,
  confidence?: Confidence | null,
  condition?: TrackerUrlCondition | null,
): Promise<boolean> {
  // Tag both the title and the body so the condition is visible whether
  // the user only sees the lock-screen preview (title) or expands.
  const title = `${formatPriceWithCondition(currentPrice, condition)} — ${tracker.name}`;
  const baseBody = tracker.last_price !== null && tracker.last_price > currentPrice
    ? `Down from $${tracker.last_price.toFixed(2)}`
    : `Now at ${formatPriceWithCondition(currentPrice, condition)}`;

  const prefix = confidence ? webPushBodyPrefix(confidence.level) : '';
  // Existing format keeps ` — ` between baseBody and aiCommentary so today's
  // alerts read identically. Reasons (when present) get appended with ` · `
  // per spec — they're additive, not a replacement for aiCommentary.
  let body = `${prefix}${baseBody}`;
  if (aiCommentary) body += ` — ${aiCommentary}`;
  if (confidence && confidence.reasons.length > 0) {
    body += ` · ${confidence.reasons.join(' · ')}`;
  }

  return dispatchToAllSubs(userId, {
    title,
    body,
    url: `/tracker/${tracker.id}`,
    tag: `tracker-${tracker.id}-price`,
  });
}

export async function sendWebPushBasketAlert(
  project: Project,
  basket: BasketState,
  members: BasketMember[],
  userId: number,
  aiCommentary: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;

  const title = `Bundle Ready: ${project.name}`;
  const baseBody = `$${basket.total.toFixed(2)} / $${project.target_total.toFixed(2)} target (${basket.item_count} items)`;
  const body = aiCommentary ? `${baseBody} — ${aiCommentary}` : baseBody;

  return dispatchToAllSubs(userId, {
    title,
    body,
    url: `/projects/${project.id}`,
    tag: `project-${project.id}-basket`,
  });
}
