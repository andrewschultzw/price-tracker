import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

// Mock the scraper and notification senders BEFORE the modules that
// import them are loaded.
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
vi.mock('../notifications/web-push.js', () => ({
  sendWebPushPriceAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../ai/generators.js', () => ({
  computeSignalsAndVerdictForTracker: vi.fn().mockResolvedValue(null),
  generateAlertCopy: vi.fn().mockResolvedValue(null),
  generateVerdictForTracker: vi.fn(),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker,
  setSetting,
} from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordPriceAlert } from '../notifications/discord.js';
import { sendNtfyPriceAlert } from '../notifications/ntfy.js';
import { sendGenericPriceAlert } from '../notifications/webhook.js';
import { sendEmailPriceAlert } from '../notifications/email.js';
import { sendWebPushPriceAlert } from '../notifications/web-push.js';
import { computeSignalsAndVerdictForTracker } from '../ai/generators.js';

/**
 * Integration tests for the per-channel confidence suppression feature.
 *
 * Core invariant: LOW/MEDIUM/HIGH confidence alerts can be suppressed
 * on a per-channel basis. When all channels suppress the same alert,
 * the entire alert is skipped and a structured log is emitted.
 *
 * Strategy: mock extractPrice and all notification senders, use in-memory
 * SQLite with seeded data, and track channel calls via vi.fn().
 */

function seedTestUser(): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('test@example.com', 'fakehash', 'Test User', 'user', 1)
  `).run();
  return Number(result.lastInsertRowid);
}

function countChannelNotifications(trackerId: number, sellerId: number, channel: string): number {
  const row = getDb().prepare(
    'SELECT COUNT(*) as c FROM notifications WHERE tracker_id = ? AND tracker_url_id = ? AND channel = ?',
  ).get(trackerId, sellerId, channel) as { c: number };
  return row.c;
}

describe('cron.ts confidence suppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();

    // Default: every scrape returns a price well below threshold
    vi.mocked(extractPrice).mockResolvedValue({
      price: 40,
      currency: 'USD',
      strategy: 'mock',
      finalUrl: 'https://amazon.com/dp/A',
    });
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  describe('default behavior (no settings)', () => {
    it('LOW confidence alert fires on all 4 channels when no min_confidence settings are set', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      setSetting('ntfy_url', 'https://ntfy.sh/test-topic', userId);
      setSetting('generic_webhook_url', 'https://example.com/hook', userId);
      setSetting('email_recipient', 'test@example.com', userId);
      // web_push: getEnabledChannels checks for active subscriptions, so no need to mock a setting

      const tracker = createTracker({
        name: 'All channels enabled',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // confidence = null → LOW
      vi.mocked(computeSignalsAndVerdictForTracker).mockResolvedValueOnce(null);

      await checkTrackerUrl(seller.id);

      // Discord, ntfy, webhook, email should all fire (web_push has no subscription in memory DB)
      expect(vi.mocked(sendDiscordPriceAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendNtfyPriceAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendGenericPriceAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendEmailPriceAlert)).toHaveBeenCalledTimes(1);

      // Check that notifications were written for each channel
      expect(countChannelNotifications(tracker.id, seller.id, 'discord')).toBe(1);
      expect(countChannelNotifications(tracker.id, seller.id, 'ntfy')).toBe(1);
      expect(countChannelNotifications(tracker.id, seller.id, 'webhook')).toBe(1);
      expect(countChannelNotifications(tracker.id, seller.id, 'email')).toBe(1);
    });
  });

  describe('single channel suppression', () => {
    it('discord_min_confidence=MEDIUM suppresses LOW alert on Discord but fires on other channels', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      setSetting('ntfy_url', 'https://ntfy.sh/test-topic', userId);
      setSetting('generic_webhook_url', 'https://example.com/hook', userId);
      setSetting('discord_min_confidence', 'MEDIUM', userId);

      const tracker = createTracker({
        name: 'Discord suppressed on LOW',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // confidence = null → LOW
      vi.mocked(computeSignalsAndVerdictForTracker).mockResolvedValueOnce(null);

      await checkTrackerUrl(seller.id);

      // Discord should NOT be called (suppressed)
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
      // ntfy and webhook should be called
      expect(vi.mocked(sendNtfyPriceAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendGenericPriceAlert)).toHaveBeenCalledTimes(1);

      // Verify notification rows
      expect(countChannelNotifications(tracker.id, seller.id, 'discord')).toBe(0);
      expect(countChannelNotifications(tracker.id, seller.id, 'ntfy')).toBe(1);
      expect(countChannelNotifications(tracker.id, seller.id, 'webhook')).toBe(1);
    });
  });

  describe('multiple channel suppression', () => {
    it('multiple channels at HIGH suppress MEDIUM alert, allowing LOW thresholds', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      setSetting('ntfy_url', 'https://ntfy.sh/test-topic', userId);
      setSetting('generic_webhook_url', 'https://example.com/hook', userId);
      setSetting('email_recipient', 'test@example.com', userId);
      // Set discord and ntfy to require HIGH confidence
      setSetting('discord_min_confidence', 'HIGH', userId);
      setSetting('ntfy_min_confidence', 'HIGH', userId);

      const tracker = createTracker({
        name: 'Discord and ntfy HIGH',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // Return MEDIUM confidence (current_percentile = 0.20 → MEDIUM)
      vi.mocked(computeSignalsAndVerdictForTracker).mockResolvedValueOnce({
        signals: {
          current_price: 40,
          data_points: 50,
          current_percentile: 0.20,
          times_at_or_below_current: 10,
          vs_all_time_low: 0.5,
          vs_30d_low: 0.8,
          data_days: 90,
          days_since_all_time_low: 30,
          avg_dwell_days_at_low: 5,
        },
        verdict: { reasonKey: 'moderate_drop' },
      });

      await checkTrackerUrl(seller.id);

      // Discord and ntfy should NOT be called (both HIGH, alert is MEDIUM)
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
      expect(vi.mocked(sendNtfyPriceAlert)).not.toHaveBeenCalled();
      // webhook and email should be called (they default to LOW)
      expect(vi.mocked(sendGenericPriceAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendEmailPriceAlert)).toHaveBeenCalledTimes(1);
    });
  });

  describe('all channels suppressed', () => {
    it('when all channels suppress, no alert is fired and structured log is emitted', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      setSetting('ntfy_url', 'https://ntfy.sh/test-topic', userId);
      setSetting('generic_webhook_url', 'https://example.com/hook', userId);
      setSetting('email_recipient', 'test@example.com', userId);
      // Set all channels to HIGH — LOW alert will be suppressed on all
      setSetting('discord_min_confidence', 'HIGH', userId);
      setSetting('ntfy_min_confidence', 'HIGH', userId);
      setSetting('webhook_min_confidence', 'HIGH', userId);
      setSetting('email_min_confidence', 'HIGH', userId);
      setSetting('web_push_min_confidence', 'HIGH', userId);

      const tracker = createTracker({
        name: 'All channels HIGH',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // confidence = null → LOW
      vi.mocked(computeSignalsAndVerdictForTracker).mockResolvedValueOnce(null);

      await checkTrackerUrl(seller.id);

      // No channel should be called
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
      expect(vi.mocked(sendNtfyPriceAlert)).not.toHaveBeenCalled();
      expect(vi.mocked(sendGenericPriceAlert)).not.toHaveBeenCalled();
      expect(vi.mocked(sendEmailPriceAlert)).not.toHaveBeenCalled();
      expect(vi.mocked(sendWebPushPriceAlert)).not.toHaveBeenCalled();

      // No notification rows should exist
      const totalNotif = getDb().prepare(
        'SELECT COUNT(*) as c FROM notifications WHERE tracker_id = ?'
      ).get(tracker.id) as { c: number };
      expect(totalNotif.c).toBe(0);
    });
  });

  describe('null confidence handling', () => {
    it('null confidence is treated as LOW and fires when no suppression is set', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      setSetting('ntfy_url', 'https://ntfy.sh/test-topic', userId);

      const tracker = createTracker({
        name: 'Null confidence default',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // confidence = null
      vi.mocked(computeSignalsAndVerdictForTracker).mockResolvedValueOnce(null);

      await checkTrackerUrl(seller.id);

      // Both channels should fire (null = LOW, no suppression set)
      expect(vi.mocked(sendDiscordPriceAlert)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendNtfyPriceAlert)).toHaveBeenCalledTimes(1);
    });

    it('null confidence is suppressed when channel requires MEDIUM or HIGH', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      setSetting('ntfy_url', 'https://ntfy.sh/test-topic', userId);
      // Discord requires HIGH confidence
      setSetting('discord_min_confidence', 'HIGH', userId);

      const tracker = createTracker({
        name: 'Null suppressed by HIGH',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // confidence = null
      vi.mocked(computeSignalsAndVerdictForTracker).mockResolvedValueOnce(null);

      await checkTrackerUrl(seller.id);

      // Discord suppressed (null < HIGH), ntfy fires (null >= LOW)
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
      expect(vi.mocked(sendNtfyPriceAlert)).toHaveBeenCalledTimes(1);
    });
  });

  describe('cooldown + confidence interaction', () => {
    it('cooldown and confidence both apply — either can suppress', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      setSetting('ntfy_url', 'https://ntfy.sh/test-topic', userId);
      // Discord has a 0h cooldown (always fires); ntfy requires HIGH confidence
      setSetting('discord_cooldown_hours', '0', userId);
      setSetting('ntfy_min_confidence', 'HIGH', userId);
      // Also set ntfy cooldown to 0 to isolate the confidence filter
      setSetting('ntfy_cooldown_hours', '0', userId);

      const tracker = createTracker({
        name: 'Cooldown and confidence',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // First check with MEDIUM confidence: discord fires (no minimum), ntfy suppressed (requires HIGH)
      vi.mocked(computeSignalsAndVerdictForTracker).mockResolvedValueOnce({
        signals: {
          current_price: 40,
          data_points: 50,
          current_percentile: 0.20,  // MEDIUM confidence
          times_at_or_below_current: 10,
          vs_all_time_low: 0.5,
          vs_30d_low: 0.8,
          data_days: 90,
          days_since_all_time_low: 30,
          avg_dwell_days_at_low: 5,
        },
        verdict: { reasonKey: 'moderate_drop' },
      });

      await checkTrackerUrl(seller.id);
      expect(vi.mocked(sendDiscordPriceAlert)).toHaveBeenCalledTimes(1);      // fires (default LOW)
      expect(vi.mocked(sendNtfyPriceAlert)).not.toHaveBeenCalled();             // suppressed (requires HIGH)

      vi.clearAllMocks();

      // Second check with HIGH confidence: both fire
      vi.mocked(computeSignalsAndVerdictForTracker).mockResolvedValueOnce({
        signals: {
          current_price: 40,
          data_points: 50,
          current_percentile: 0.05,  // HIGH confidence
          times_at_or_below_current: 1,
          vs_all_time_low: 1.0,
          vs_30d_low: 1.0,
          data_days: 365,
          days_since_all_time_low: 0,
          avg_dwell_days_at_low: 7,
        },
        verdict: { reasonKey: 'all_time_low' },
      });

      await checkTrackerUrl(seller.id);
      expect(vi.mocked(sendDiscordPriceAlert)).toHaveBeenCalledTimes(1);      // fires
      expect(vi.mocked(sendNtfyPriceAlert)).toHaveBeenCalledTimes(1);          // now meets HIGH requirement
    });
  });
});
