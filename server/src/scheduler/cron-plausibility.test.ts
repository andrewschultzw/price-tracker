import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', () => ({
  extractPrice: vi.fn(),
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
import {
  createTracker,
  setSetting,
  addPriceRecord,
  getTrackerUrlById,
} from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordPriceAlert } from '../notifications/discord.js';
import { config } from '../config.js';

/**
 * Integration tests for the plausibility guard. Exercises every branch
 * of the guard logic in cron.ts via real DB writes and mocked scrapes.
 *
 * Test plan (one test per spec'd outcome):
 *   1. Suspicious + no pending → flag set, alert suppressed.
 *   2. Suspicious + pending → flag cleared, alert fires (confirmed).
 *   3. Plausible-but-below-threshold + pending → flag cleared,
 *      alert fires (recovery within plausibility).
 *   4. Above-threshold + pending → flag cleared, alert NOT fired
 *      (transient anomaly).
 *   5. Below-threshold but not suspicious + no pending → alert fires
 *      (normal path, no behavior change).
 *   6. threshold = 0 (guard disabled) → alert fires regardless.
 */

function seedTestUser(): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('test@example.com', 'fakehash', 'Test User', 'user', 1)
  `).run();
  return Number(result.lastInsertRowid);
}

/** Seed a tracker with one seller and N successful price_history rows
 *  at `historicalPrice`. Returns the seller_url id. */
function seedTracker(
  userId: number,
  thresholdPrice: number,
  historicalPrice: number,
  historyCount: number,
): { trackerId: number; sellerId: number } {
  const tracker = createTracker({
    name: 'Test Item',
    url: 'https://example.com/item',
    threshold_price: thresholdPrice,
    user_id: userId,
  });
  const seller = getDb()
    .prepare('SELECT * FROM tracker_urls WHERE tracker_id = ?')
    .get(tracker.id) as { id: number };
  for (let i = 0; i < historyCount; i++) {
    addPriceRecord(tracker.id, historicalPrice, 'USD', seller.id);
  }
  return { trackerId: tracker.id, sellerId: seller.id };
}

describe('plausibility guard — integration', () => {
  beforeEach(() => {
    initSettingsCrypto(randomBytes(32).toString('hex'));
    _setDbForTesting(new Database(':memory:'));
    initializeSchema();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  it('suspicious + no pending → flag set, alert suppressed', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    const { sellerId } = seedTracker(userId, /*threshold*/ 100, /*history*/ 600, /*count*/ 10);

    // $10 is well below threshold (100) AND below median (600) * 0.5 = 300.
    vi.mocked(extractPrice).mockResolvedValue({
      price: 10,
      currency: 'USD',
      strategy: 'css-patterns',
      finalUrl: 'https://example.com/item',
    });

    await checkTrackerUrl(sellerId);

    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_price).toBe(10);
    expect(seller!.pending_confirmation_at).not.toBeNull();
    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();
  });

  it('suspicious + pending → flag cleared, alert fires', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    const { sellerId } = seedTracker(userId, 100, 600, 10);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 10,
      currency: 'USD',
      strategy: 'css-patterns',
      finalUrl: 'https://example.com/item',
    });

    await checkTrackerUrl(sellerId);   // first: sets pending
    await checkTrackerUrl(sellerId);   // second: confirms + alerts

    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_price).toBeNull();
    expect(seller!.pending_confirmation_at).toBeNull();
    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
  });

  it('plausible-but-below-threshold + pending → flag cleared, alert fires', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    // History at $50, threshold $40. A $20 read is suspicious (< 50*0.5=25).
    // A $30 read is below threshold and NOT suspicious (>= 25).
    const { sellerId } = seedTracker(userId, /*threshold*/ 40, /*history*/ 50, 10);

    vi.mocked(extractPrice).mockResolvedValueOnce({
      price: 20, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });
    await checkTrackerUrl(sellerId);

    const afterFirst = getTrackerUrlById(sellerId);
    expect(afterFirst!.pending_confirmation_at).not.toBeNull();
    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();

    vi.mocked(extractPrice).mockResolvedValueOnce({
      price: 30, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });
    await checkTrackerUrl(sellerId);

    const afterSecond = getTrackerUrlById(sellerId);
    expect(afterSecond!.pending_confirmation_at).toBeNull();
    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
  });

  it('above-threshold + pending → flag cleared, alert NOT fired (transient)', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    const { sellerId } = seedTracker(userId, 100, 600, 10);

    vi.mocked(extractPrice).mockResolvedValueOnce({
      price: 10, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });
    await checkTrackerUrl(sellerId);

    vi.mocked(extractPrice).mockResolvedValueOnce({
      price: 600, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });
    await checkTrackerUrl(sellerId);

    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_at).toBeNull();
    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();
  });

  it('below-threshold but not suspicious + no pending → alert fires (normal path)', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    // History at $50, threshold $40. $30 is below threshold but
    // NOT suspicious (50*0.5=25, 30>25).
    const { sellerId } = seedTracker(userId, 40, 50, 10);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 30, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });

    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_at).toBeNull();
  });

  it('threshold of 0 (guard disabled) → alert fires immediately', async () => {
    // Mutate the live config object instead of vi.resetModules + dynamic
    // re-import. Re-importing forks the module graph (including the DB
    // connection module), which would orphan _setDbForTesting from the
    // freshly-loaded checkTrackerUrl. The config object is plain mutable
    // state so writing to it is the simplest correct injection point.
    const original = config.plausibilityGuardDropThreshold;
    config.plausibilityGuardDropThreshold = 0;
    try {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
      const { sellerId } = seedTracker(userId, 100, 600, 10);

      vi.mocked(extractPrice).mockResolvedValue({
        price: 10, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
      });

      await checkTrackerUrl(sellerId);

      expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
      const seller = getTrackerUrlById(sellerId);
      expect(seller!.pending_confirmation_at).toBeNull();
    } finally {
      config.plausibilityGuardDropThreshold = original;
    }
  });
});
