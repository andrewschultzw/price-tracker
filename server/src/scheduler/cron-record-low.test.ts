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

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createTracker, setSetting, updateTracker } from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordPriceAlert } from '../notifications/discord.js';

/**
 * Integration tests for record-low alerts (deal-intelligence phase 1).
 * Invariants under test:
 *   - a mature no-threshold tracker alerts on a record low (the phase-1
 *     unlock) and the notification row carries the tier in alert_type
 *   - coverage gates keep young trackers silent
 *   - low_alert_mode 'off' disables the class
 *   - non-'new' sellers never fire record lows (history basis is new-only)
 *   - a threshold hit that is ALSO a record low stays alert_type='threshold'
 */

function seedTestUser(): number {
  const result = getDb().prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('test@example.com', 'fakehash', 'Test User', 'user', 1)
  `).run();
  return Number(result.lastInsertRowid);
}

/** Insert one price_history row per day: `days` rows ending yesterday. */
function seedDailyHistory(trackerId: number, trackerUrlId: number, price: number, days: number): void {
  const stmt = getDb().prepare(`
    INSERT INTO price_history (tracker_id, tracker_url_id, price, currency, scraped_at)
    VALUES (?, ?, ?, 'USD', datetime('now', ?))
  `);
  for (let i = 1; i <= days; i++) {
    stmt.run(trackerId, trackerUrlId, price, `-${i} days`);
  }
}

function primarySellerId(trackerId: number): number {
  const row = getDb()
    .prepare('SELECT id FROM tracker_urls WHERE tracker_id = ? AND position = 0')
    .get(trackerId) as { id: number };
  return row.id;
}

function lastNotification(trackerId: number): { alert_type: string; threshold_price: number } | undefined {
  return getDb()
    .prepare('SELECT alert_type, threshold_price FROM notifications WHERE tracker_id = ? ORDER BY id DESC LIMIT 1')
    .get(trackerId) as { alert_type: string; threshold_price: number } | undefined;
}

function mockScrape(price: number, finalUrl = 'https://amazon.com/dp/A'): void {
  vi.mocked(extractPrice).mockResolvedValue({
    price,
    currency: 'USD',
    strategy: 'mock',
    finalUrl,
  });
}

describe('record-low alerts (phase 1)', () => {
  let userId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
    userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  function makeTracker(threshold: number | null): { id: number; sellerId: number } {
    const tracker = createTracker({
      name: 'Record-low product',
      url: 'https://amazon.com/dp/A',
      threshold_price: threshold,
      user_id: userId,
    });
    return { id: tracker.id, sellerId: primarySellerId(tracker.id) };
  }

  it('fires an all-time-low alert on a mature NO-THRESHOLD tracker, tagging alert_type', async () => {
    const { id, sellerId } = makeTracker(null);
    seedDailyHistory(id, sellerId, 50, 100); // span 100d, 100 points

    mockScrape(49.4); // <= 50 * 0.99
    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
    // low context is the last (7th) parameter — index 6
    const low = vi.mocked(sendDiscordPriceAlert).mock.calls[0][6];
    expect(low).toMatchObject({ tier: 'low_all_time' });
    expect(lastNotification(id)).toEqual({ alert_type: 'low_all_time', threshold_price: 0 });
  });

  it('stays silent on a young tracker (coverage gate)', async () => {
    const { id, sellerId } = makeTracker(null);
    seedDailyHistory(id, sellerId, 50, 5);

    mockScrape(30);
    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();
    expect(lastNotification(id)).toBeUndefined();
  });

  it('low_alert_mode=off disables record-low alerts', async () => {
    const { id, sellerId } = makeTracker(null);
    seedDailyHistory(id, sellerId, 50, 100);
    updateTracker(id, { low_alert_mode: 'off' });

    mockScrape(49.4);
    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();
  });

  it('a non-new seller never fires a record low', async () => {
    const { id, sellerId } = makeTracker(null);
    seedDailyHistory(id, sellerId, 50, 100);
    getDb().prepare(`UPDATE tracker_urls SET condition = 'warehouse' WHERE id = ?`).run(sellerId);

    mockScrape(40);
    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();
  });

  it('a threshold hit that is also a record low stays alert_type=threshold with low context attached', async () => {
    const { id, sellerId } = makeTracker(49.5);
    seedDailyHistory(id, sellerId, 50, 100);

    mockScrape(49.4);
    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
    const low = vi.mocked(sendDiscordPriceAlert).mock.calls[0][6];
    expect(low).toMatchObject({ tier: 'low_all_time' });
    const note = lastNotification(id);
    expect(note).toEqual({ alert_type: 'threshold', threshold_price: 49.5 });
  });

  it('fires the 90d tier when all-time is within the penny-noise band', async () => {
    const { id, sellerId } = makeTracker(null);
    seedDailyHistory(id, sellerId, 50, 70); // span 70d: 90d tier eligible, not old enough for stricter tiers to matter

    mockScrape(49.6); // below min but NOT <= 49.5
    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
    expect(lastNotification(id)?.alert_type).toBe('low_90d');
  });

  it('does not re-fire while the price sits at the new low (next scrape equals, not below)', async () => {
    const { id, sellerId } = makeTracker(null);
    seedDailyHistory(id, sellerId, 50, 100);

    mockScrape(49.4);
    await checkTrackerUrl(sellerId); // sets the new record
    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);

    // Same price again: prior history now contains 49.4 (today's daily min),
    // and equal-to-min does not fire.
    await checkTrackerUrl(sellerId);
    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
  });
});
