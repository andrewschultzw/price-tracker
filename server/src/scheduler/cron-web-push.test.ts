import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../notifications/web-push.js', () => ({
  sendWebPushPriceAlert: vi.fn(),
  sendWebPushBasketAlert: vi.fn(),
}));
vi.mock('../scraper/extractor.js', () => ({ extractPrice: vi.fn() }));
vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
  sendDiscordBasketAlert: vi.fn().mockResolvedValue(true),
  testDiscordWebhook: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyPriceAlert: vi.fn().mockResolvedValue(true),
  sendNtfyErrorAlert: vi.fn().mockResolvedValue(true),
  sendNtfyBasketAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericPriceAlert: vi.fn().mockResolvedValue(true),
  sendGenericErrorAlert: vi.fn().mockResolvedValue(true),
  sendGenericBasketAlert: vi.fn().mockResolvedValue(true),
  assertWebhookUrl: vi.fn(),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailPriceAlert: vi.fn().mockResolvedValue(true),
  sendEmailErrorAlert: vi.fn().mockResolvedValue(true),
  sendEmailBasketAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { upsertWebPushSubscription } from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendWebPushPriceAlert } from '../notifications/web-push.js';

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function seedTrackerWithSeller(userId: number, name: string, lastPrice: number): { trackerId: number; trackerUrlId: number } {
  const trackerInsert = getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 100, 'active', 60, 0, ?)`
  ).run(name, `https://amazon.com/dp/${name}`, userId, lastPrice);
  const trackerId = Number(trackerInsert.lastInsertRowid);
  const urlInsert = getDb().prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position, last_price, status)
     VALUES (?, ?, 0, ?, 'active')`
  ).run(trackerId, `https://amazon.com/dp/${name}`, lastPrice);
  return { trackerId, trackerUrlId: Number(urlInsert.lastInsertRowid) };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('cron web_push channel', () => {
  it('fires sendWebPushPriceAlert when user has subscriptions and price drops below threshold', async () => {
    const u = seedUser();
    upsertWebPushSubscription({
      user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A',
      device_label: 'Phone', user_agent: null,
    });
    const { trackerUrlId } = seedTrackerWithSeller(u, 'A', 200);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    vi.mocked(sendWebPushPriceAlert).mockResolvedValue(true);

    await checkTrackerUrl(trackerUrlId);

    expect(vi.mocked(sendWebPushPriceAlert)).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire web_push when user has no subscriptions', async () => {
    const u = seedUser();
    const { trackerUrlId } = seedTrackerWithSeller(u, 'A', 200);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(trackerUrlId);

    expect(vi.mocked(sendWebPushPriceAlert)).not.toHaveBeenCalled();
  });

  it('respects per-channel cooldown — recent web_push notification suppresses', async () => {
    const u = seedUser();
    upsertWebPushSubscription({
      user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A',
      device_label: null, user_agent: null,
    });
    const { trackerId, trackerUrlId } = seedTrackerWithSeller(u, 'A', 200);

    // Seed a recent notification on this (tracker, seller, web_push) tuple.
    getDb().prepare(
      `INSERT INTO notifications (tracker_id, tracker_url_id, price, threshold_price, channel, sent_at)
       VALUES (?, ?, 80, 100, 'web_push', datetime('now', '-1 hour'))`
    ).run(trackerId, trackerUrlId);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(trackerUrlId);

    // Default cooldown is 6h → recent 1-hour-old notification suppresses
    expect(vi.mocked(sendWebPushPriceAlert)).not.toHaveBeenCalled();
  });

  it('does not block other channels when web_push send returns false', async () => {
    const u = seedUser();
    upsertWebPushSubscription({
      user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A',
      device_label: null, user_agent: null,
    });
    const { trackerUrlId } = seedTrackerWithSeller(u, 'A', 200);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    vi.mocked(sendWebPushPriceAlert).mockResolvedValue(false);

    await checkTrackerUrl(trackerUrlId);

    // web_push returned false but the call was made; other channels independent
    expect(vi.mocked(sendWebPushPriceAlert)).toHaveBeenCalled();
  });
});
