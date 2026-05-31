import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { maybeArmPurchase } from './cron.js';
import { getOpenIntentForTracker, createIntent } from '../db/purchase-intents.js';

let trackerId: number;
let sellerId: number;

function seed(opts: { buy_armed: number; url: string }) {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active) VALUES ('t@x.com','h','T','user',1)`).run();
  trackerId = Number(db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes, buy_armed, buy_quantity, normalized_url)
     VALUES ('T', ?, 1, 100, 60, 0, ?, 1, ?)`,
  ).run(opts.url, opts.buy_armed, opts.url).lastInsertRowid);
  sellerId = Number(db.prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position, status) VALUES (?, ?, 0, 'active')`,
  ).run(trackerId, opts.url).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

const noChannels = {} as never; // all channels off → no network calls
const sellerRow = () => getDb().prepare('SELECT * FROM tracker_urls WHERE id = ?').get(sellerId) as never;

describe('maybeArmPurchase', () => {
  it('arms an Amazon tracker with an ASIN and creates exactly one intent', async () => {
    seed({ buy_armed: 1, url: 'https://www.amazon.com/dp/B07XYZ1234' });
    const armed = await maybeArmPurchase(trackerId, 79.99, sellerRow(), noChannels);
    expect(armed).toBe(true);
    const intent = getOpenIntentForTracker(trackerId);
    expect(intent?.asin).toBe('B07XYZ1234');
    expect(intent?.price_at_arm).toBe(79.99);
  });

  it('does not arm an unarmed tracker', async () => {
    seed({ buy_armed: 0, url: 'https://www.amazon.com/dp/B07XYZ1234' });
    expect(await maybeArmPurchase(trackerId, 79.99, sellerRow(), noChannels)).toBe(false);
  });

  it('does not arm a non-Amazon seller', async () => {
    seed({ buy_armed: 1, url: 'https://www.newegg.com/p/N82E16819' });
    expect(await maybeArmPurchase(trackerId, 79.99, sellerRow(), noChannels)).toBe(false);
  });

  it('does not arm twice when an open intent exists', async () => {
    seed({ buy_armed: 1, url: 'https://www.amazon.com/dp/B07XYZ1234' });
    createIntent({ tracker_id: trackerId, tracker_url_id: sellerId, asin: 'B07XYZ1234', price_at_arm: 80, threshold_at_arm: 100, quantity: 1, expires_at: '2999-01-01 00:00:00' });
    expect(await maybeArmPurchase(trackerId, 79.99, sellerRow(), noChannels)).toBe(false);
  });
});
