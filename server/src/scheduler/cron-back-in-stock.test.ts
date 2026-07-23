import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../scraper/extractor.js')>();
  return { ...orig, extractPrice: vi.fn() };
});
vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createTracker, setSetting, getTrackerUrlById } from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordPriceAlert } from '../notifications/discord.js';

/**
 * Back-in-stock transition matrix (phase 4):
 *   - OOS scrape is HEALTHY: no price row, failures reset, status active
 *     (the defect fix — previously Amazon-unavailable walked the failure
 *     path to auto-pause)
 *   - unknown -> in_stock / out_of_stock adopt silently
 *   - out_of_stock -> priced fires ONE back_in_stock alert
 *   - restock replaces the threshold alert on the same tick
 */

function seedUser(): number {
  return Number(getDb().prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('t@x.com', 'h', 'T', 'user', 1)
  `).run().lastInsertRowid);
}

describe('back-in-stock transitions', () => {
  let userId: number;
  let trackerId: number;
  let sellerId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
    userId = seedUser();
    setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
    const t = createTracker({ name: 'Widget', url: 'https://amazon.com/dp/W', threshold_price: null, user_id: userId });
    trackerId = t.id;
    sellerId = (getDb().prepare('SELECT id FROM tracker_urls WHERE tracker_id = ?').get(trackerId) as { id: number }).id;
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  const mockOos = () =>
    vi.mocked(extractPrice).mockResolvedValue({ outOfStock: true, finalUrl: 'https://amazon.com/dp/W', title: 'Widget' });
  const mockPrice = (price: number) =>
    vi.mocked(extractPrice).mockResolvedValue({ price, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/W', title: null });

  function priceRows(): number {
    return (getDb().prepare('SELECT COUNT(*) c FROM price_history WHERE tracker_id = ?').get(trackerId) as { c: number }).c;
  }

  it('OOS scrape is healthy: no price row, failures reset, status active, badge state set', async () => {
    getDb().prepare('UPDATE tracker_urls SET consecutive_failures = 2 WHERE id = ?').run(sellerId);
    mockOos();
    await checkTrackerUrl(sellerId);

    const seller = getTrackerUrlById(sellerId)!;
    expect(seller.availability).toBe('out_of_stock');
    expect(seller.availability_changed_at).toBeTruthy();
    expect(seller.consecutive_failures).toBe(0);
    expect(seller.status).toBe('active');
    expect(priceRows()).toBe(0);
    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();
  });

  it('repeated OOS does not re-stamp availability_changed_at', async () => {
    mockOos();
    await checkTrackerUrl(sellerId);
    const first = getTrackerUrlById(sellerId)!.availability_changed_at;
    await new Promise(r => setTimeout(r, 1100));
    await checkTrackerUrl(sellerId);
    expect(getTrackerUrlById(sellerId)!.availability_changed_at).toBe(first);
  });

  it('unknown -> in_stock adopts silently (no restock alert on first-ever scrape)', async () => {
    mockPrice(49.99);
    await checkTrackerUrl(sellerId);
    expect(getTrackerUrlById(sellerId)!.availability).toBe('in_stock');
    expect(sendDiscordPriceAlert).not.toHaveBeenCalled(); // no threshold, no low, no restock
  });

  it('out_of_stock -> priced fires ONE back_in_stock alert with the restock context', async () => {
    mockOos();
    await checkTrackerUrl(sellerId);

    mockPrice(49.99);
    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
    const low = vi.mocked(sendDiscordPriceAlert).mock.calls[0][6];
    expect(low).toMatchObject({ tier: 'back_in_stock' });
    expect((low as { context: string }).context).toContain('Back in stock at $49.99');
    const note = getDb().prepare(
      'SELECT alert_type FROM notifications WHERE tracker_id = ? ORDER BY id DESC LIMIT 1',
    ).get(trackerId) as { alert_type: string };
    expect(note.alert_type).toBe('back_in_stock');
    expect(getTrackerUrlById(sellerId)!.availability).toBe('in_stock');
  });

  it('restock replaces the threshold alert on the same tick and notes the target', async () => {
    getDb().prepare('UPDATE trackers SET threshold_price = 60 WHERE id = ?').run(trackerId);
    mockOos();
    await checkTrackerUrl(sellerId);

    mockPrice(49.99); // below threshold AND a restock
    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
    const low = vi.mocked(sendDiscordPriceAlert).mock.calls[0][6];
    expect(low).toMatchObject({ tier: 'back_in_stock' });
    expect((low as { context: string }).context).toContain('at/below your target');
    const note = getDb().prepare(
      'SELECT alert_type FROM notifications WHERE tracker_id = ? ORDER BY id DESC LIMIT 1',
    ).get(trackerId) as { alert_type: string };
    expect(note.alert_type).toBe('back_in_stock');
  });

  it('a scrape FAILURE never touches availability', async () => {
    mockOos();
    await checkTrackerUrl(sellerId); // establish out_of_stock
    vi.mocked(extractPrice).mockRejectedValue(new Error('network flake'));
    await checkTrackerUrl(sellerId);
    expect(getTrackerUrlById(sellerId)!.availability).toBe('out_of_stock');
  });
});
