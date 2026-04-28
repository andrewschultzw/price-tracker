import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', () => ({
  extractPrice: vi.fn().mockResolvedValue({
    price: 600, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
  }),
}));
vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyPriceAlert: vi.fn().mockResolvedValue(true),
  sendNtfyErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericPriceAlert: vi.fn().mockResolvedValue(true),
  sendGenericErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailPriceAlert: vi.fn().mockResolvedValue(true),
  sendEmailErrorAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createTracker, addPriceRecord, getTrackerUrlById } from '../db/queries.js';
import { startScheduler, stopScheduler } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';

function seedTestUser(): number {
  return Number(getDb().prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('t@example.com', 'h', 'T', 'user', 1)
  `).run().lastInsertRowid);
}

function seedSellerWithStalePending(
  userId: number,
  pendingAtIso: string,
): number {
  const tracker = createTracker({
    name: 'Test',
    url: 'https://example.com/item',
    threshold_price: 100,
    user_id: userId,
  });
  const seller = getDb()
    .prepare('SELECT * FROM tracker_urls WHERE tracker_id = ?')
    .get(tracker.id) as { id: number };
  // Some history so the guard can run on the recovery scrape.
  for (let i = 0; i < 10; i++) addPriceRecord(tracker.id, 600, 'USD', seller.id);
  // Plant a stale pending flag.
  getDb()
    .prepare(
      'UPDATE tracker_urls SET pending_confirmation_price = 10, pending_confirmation_at = ? WHERE id = ?',
    )
    .run(pendingAtIso, seller.id);
  return seller.id;
}

describe('plausibility guard — restart recovery', () => {
  beforeEach(() => {
    initSettingsCrypto(randomBytes(32).toString('hex'));
    _setDbForTesting(new Database(':memory:'));
    initializeSchema();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopScheduler();
    _setDbForTesting(null);
    resetCrypto();
  });

  it('re-enqueues stale pending confirmations (>10 min old)', async () => {
    const userId = seedTestUser();
    // 30 min ago, formatted to match the scheduler's ISO format.
    const staleIso = new Date(Date.now() - 30 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const sellerId = seedSellerWithStalePending(userId, staleIso);

    startScheduler();

    // The recovery enqueues an immediate scrape via p-queue. Let it drain.
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(extractPrice).toHaveBeenCalledTimes(1);
    // After recovery + scrape, the new $600 read clears the pending flag.
    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_at).toBeNull();
  });

  it('leaves young pending confirmations alone', async () => {
    const userId = seedTestUser();
    // 1 min ago — well under the 10-min stale threshold.
    const youngIso = new Date(Date.now() - 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const sellerId = seedSellerWithStalePending(userId, youngIso);

    startScheduler();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(extractPrice).not.toHaveBeenCalled();
    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_at).not.toBeNull();
  });
});
