import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createIntent,
  getIntentByToken,
  getOpenIntentForTracker,
  getMostRecentTerminalIntent,
  approveIntent,
  resolveIntentPurchased,
  resolveIntentNotCompleted,
  expireStaleIntents,
} from './purchase-intents.js';

let trackerId: number;

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
  ).run();
  trackerId = Number(db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes, buy_armed, last_price)
     VALUES ('T', 'https://amazon.com/dp/B000000000', 1, 100, 60, 0, 1, 79.99)`,
  ).run().lastInsertRowid);
});

const baseInput = () => ({
  tracker_id: trackerId,
  tracker_url_id: null,
  asin: 'B000000000',
  price_at_arm: 79.99,
  threshold_at_arm: 100,
  quantity: 1,
  expires_at: '2999-01-01 00:00:00',
});

describe('purchase_intents state machine', () => {
  it('creates an armed intent with a unique token and finds it as the open intent', () => {
    const intent = createIntent(baseInput());
    expect(intent.status).toBe('armed');
    expect(intent.token).toBeTruthy();
    expect(getOpenIntentForTracker(trackerId)?.id).toBe(intent.id);
    expect(getIntentByToken(intent.token)?.id).toBe(intent.id);
  });

  it('approve transitions armed -> approved and is idempotent', () => {
    const intent = createIntent(baseInput());
    const a1 = approveIntent(intent.id);
    expect(a1.status).toBe('approved');
    expect(a1.approved_at).toBeTruthy();
    const a2 = approveIntent(intent.id);
    expect(a2.status).toBe('approved');
    expect(a2.approved_at).toBe(a1.approved_at);
  });

  it('resolve purchased logs a purchase, links it, disarms the tracker, flips status', () => {
    const intent = createIntent(baseInput());
    approveIntent(intent.id);
    const { intent: resolved, purchase } = resolveIntentPurchased(intent.id);
    expect(resolved.status).toBe('purchased');
    expect(resolved.purchase_id).toBe(purchase.id);
    expect(purchase.purchase_price).toBe(79.99);
    const tracker = getDb().prepare('SELECT status, buy_armed FROM trackers WHERE id = ?').get(trackerId) as { status: string; buy_armed: number };
    expect(tracker.status).toBe('purchased');
    expect(tracker.buy_armed).toBe(0);
    expect(getOpenIntentForTracker(trackerId)).toBeUndefined();
  });

  it('resolve not_completed leaves the tracker active and still armed', () => {
    const intent = createIntent(baseInput());
    approveIntent(intent.id);
    const resolved = resolveIntentNotCompleted(intent.id);
    expect(resolved.status).toBe('not_completed');
    const tracker = getDb().prepare('SELECT status, buy_armed FROM trackers WHERE id = ?').get(trackerId) as { status: string; buy_armed: number };
    expect(tracker.status).toBe('active');
    expect(tracker.buy_armed).toBe(1);
    expect(getMostRecentTerminalIntent(trackerId)?.id).toBe(intent.id);
  });

  it('expireStaleIntents retires armed/approved intents past expires_at', () => {
    const intent = createIntent({ ...baseInput(), expires_at: '2000-01-01 00:00:00' });
    const n = expireStaleIntents('2026-05-31 00:00:00');
    expect(n).toBe(1);
    expect(getIntentByToken(intent.token)?.status).toBe('expired');
    expect(getMostRecentTerminalIntent(trackerId)?.id).toBe(intent.id);
  });

  it('does not double-open: getOpenIntentForTracker returns the live one only', () => {
    const a = createIntent(baseInput());
    resolveIntentNotCompleted(a.id);
    const b = createIntent(baseInput());
    expect(getOpenIntentForTracker(trackerId)?.id).toBe(b.id);
  });
});
