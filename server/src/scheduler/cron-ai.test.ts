import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', () => ({ extractPrice: vi.fn() }));
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
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { _setClientForTesting } from '../ai/generators.js';
import type { ClaudeResponse } from '../ai/client.js';

const mockClient = vi.fn<[unknown], Promise<ClaudeResponse>>();

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function seedTrackerWith30dHistory(userId: number, sellerLastPrice: number): { trackerId: number; trackerUrlId: number } {
  const db = getDb();
  const trackerInsert = db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES ('Test', 'https://amazon.com/dp/A', ?, 100, 'active', 60, 0, ?)`
  ).run(userId, sellerLastPrice);
  const trackerId = Number(trackerInsert.lastInsertRowid);
  const urlInsert = db.prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position, last_price, status)
     VALUES (?, 'https://amazon.com/dp/A', 0, ?, 'active')`
  ).run(trackerId, sellerLastPrice);
  const trackerUrlId = Number(urlInsert.lastInsertRowid);
  const now = Date.now();
  for (let i = 30; i >= 1; i--) {
    db.prepare(`INSERT INTO price_history (tracker_id, tracker_url_id, price, scraped_at) VALUES (?, ?, ?, ?)`)
      .run(trackerId, trackerUrlId, 100 - i * 0.5, new Date(now - i * 86_400_000).toISOString());
  }
  return { trackerId, trackerUrlId };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  mockClient.mockReset();
  _setClientForTesting(mockClient);
  process.env.AI_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test';
});

describe('cron AI hook', () => {
  it('fires verdict generation after a price-change scrape', async () => {
    const userId = seedUser();
    const { trackerId, trackerUrlId } = seedTrackerWith30dHistory(userId, 95);
    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    mockClient.mockResolvedValueOnce({
      text: 'At the all-time low.',
      inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50,
    });

    await checkTrackerUrl(trackerUrlId);
    // Wait a tick for the fire-and-forget verdict generator to settle.
    await new Promise(r => setTimeout(r, 100));

    expect(mockClient).toHaveBeenCalledTimes(1);
    const t = getDb().prepare('SELECT * FROM trackers WHERE id=?').get(trackerId) as Record<string, unknown>;
    expect(t.ai_verdict_tier).toBeTruthy();
    expect(t.ai_verdict_reason).toBe('At the all-time low.');
  });

  it('scrape pipeline completes even if AI generator throws', async () => {
    const userId = seedUser();
    const { trackerId, trackerUrlId } = seedTrackerWith30dHistory(userId, 95);
    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    mockClient.mockRejectedValue(new Error('claude down'));

    await expect(checkTrackerUrl(trackerUrlId)).resolves.not.toThrow();
    await new Promise(r => setTimeout(r, 100));

    const t = getDb().prepare('SELECT * FROM trackers WHERE id=?').get(trackerId) as Record<string, unknown>;
    expect(t.ai_failure_count).toBe(1);
    const ph = getDb().prepare('SELECT COUNT(*) as c FROM price_history WHERE tracker_id=?').get(trackerId) as { c: number };
    // Original 30 history rows + the new scrape = 31. (The old plan said >30 which still holds.)
    expect(ph.c).toBeGreaterThan(30);
  });

  it('does NOT fire verdict generation when price did not change', async () => {
    const userId = seedUser();
    const { trackerUrlId } = seedTrackerWith30dHistory(userId, 80);
    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(trackerUrlId);
    await new Promise(r => setTimeout(r, 100));

    expect(mockClient).not.toHaveBeenCalled();
  });
});
