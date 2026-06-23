import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

// Mock scraper + notification senders before the modules that import them load.
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
import { createTracker, setSetting, getTrackerUrlById } from '../db/queries.js';
import { config } from '../config.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordErrorAlert } from '../notifications/discord.js';

function seedTestUser(): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO users (email, password_hash, display_name, role, is_active)
         VALUES ('t@example.com', 'h', 'T', 'user', 1)`,
      )
      .run().lastInsertRowid,
  );
}

function seedFlakySeller(): number {
  const userId = seedTestUser();
  // A configured channel so error alerts would fire if they were going to.
  setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
  const tracker = createTracker({
    name: 'Flaky',
    url: 'https://example.com/item',
    threshold_price: 100,
    user_id: userId,
  });
  const seller = getDb()
    .prepare('SELECT id FROM tracker_urls WHERE tracker_id = ?')
    .get(tracker.id) as { id: number };
  return seller.id;
}

describe('auto-pause on repeated scrape failures', () => {
  beforeEach(() => {
    initSettingsCrypto(randomBytes(32).toString('hex'));
    _setDbForTesting(new Database(':memory:'));
    initializeSchema();
    vi.clearAllMocks();
    // Every scrape attempt fails (plain error, not a retailer-block).
    vi.mocked(extractPrice).mockRejectedValue(new Error('no recognizable price block'));
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  it('pauses the seller at maxConsecutiveFailures and alerts exactly once', async () => {
    const sellerId = seedFlakySeller();

    for (let i = 0; i < config.maxConsecutiveFailures; i++) {
      await checkTrackerUrl(sellerId);
    }

    const after = getTrackerUrlById(sellerId)!;
    expect(after.status).toBe('paused');
    expect(after.consecutive_failures).toBe(config.maxConsecutiveFailures);
    // One actionable notice on the transition — not one per failed check.
    expect(vi.mocked(sendDiscordErrorAlert)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendDiscordErrorAlert).mock.calls[0][1]).toContain('auto-paused');
  });

  it('does not pause or alert before the threshold', async () => {
    const sellerId = seedFlakySeller();

    for (let i = 0; i < config.maxConsecutiveFailures - 1; i++) {
      await checkTrackerUrl(sellerId);
    }

    expect(getTrackerUrlById(sellerId)!.status).not.toBe('paused');
    expect(vi.mocked(sendDiscordErrorAlert)).not.toHaveBeenCalled();
  });

  it('stays silent on further failures once paused (no re-alert until unpaused)', async () => {
    const sellerId = seedFlakySeller();

    for (let i = 0; i < config.maxConsecutiveFailures; i++) {
      await checkTrackerUrl(sellerId);
    }
    expect(vi.mocked(sendDiscordErrorAlert)).toHaveBeenCalledTimes(1);

    // Further failed checks (e.g. a manual "Check Now") must not re-alert.
    await checkTrackerUrl(sellerId);
    await checkTrackerUrl(sellerId);

    expect(getTrackerUrlById(sellerId)!.status).toBe('paused');
    expect(vi.mocked(sendDiscordErrorAlert)).toHaveBeenCalledTimes(1);
  });
});
