import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

// Mock the scraper and notification senders BEFORE the modules that
// import them are loaded. vi.mock is hoisted by vitest so this runs
// before the imports below. Each mock returns controlled values so the
// test doesn't touch real network or Playwright.
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

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker,
  addTrackerUrl,
  setSetting,
} from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordPriceAlert } from '../notifications/discord.js';

/**
 * Integration tests for the per-seller cooldown invariant — the fourth
 * and most critical of the multi-seller test debt items.
 *
 * Core invariant: one seller hitting its cooldown does NOT silence a
 * later alert from a DIFFERENT seller on the same tracker. The whole
 * point of multi-seller is that Amazon dropping below threshold
 * shouldn't prevent Newegg's later drop from notifying the user.
 *
 * Strategy: mock extractPrice to return controlled prices and mock all
 * notification senders to return success (tracked via vi.fn calls).
 * Use an in-memory sqlite db with a real seeded tracker+sellers so the
 * notification DB side-effects (addNotification rows) are real and
 * the cooldown query runs against real data.
 */

function seedTestUser(): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('test@example.com', 'fakehash', 'Test User', 'user', 1)
  `).run();
  return Number(result.lastInsertRowid);
}

// Helper: snapshot how many notifications are in the table, scoped to
// a specific tracker/seller pair. Lets tests assert "a new row was
// (or wasn't) written" regardless of cron.ts' internal plumbing.
function countNotifications(trackerId: number, trackerUrlId: number): number {
  const row = getDb().prepare(
    'SELECT COUNT(*) as c FROM notifications WHERE tracker_id = ? AND tracker_url_id = ?',
  ).get(trackerId, trackerUrlId) as { c: number };
  return row.c;
}

describe('cron.ts per-seller cooldown', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();

    // Default: every scrape returns a price comfortably below threshold
    // so the alert path always fires unless cooldown suppresses it.
    vi.mocked(extractPrice).mockResolvedValue({
      price: 40,
      currency: 'USD',
      strategy: 'mock',
    });
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  describe('the core invariant: sellers do not share cooldown', () => {
    it('Amazon alerting does NOT silence a later Newegg alert on the same tracker', async () => {
      const userId = seedTestUser();
      // User has a Discord webhook configured so alerts fire
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);

      const tracker = createTracker({
        name: 'Multi-seller product',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });

      // Primary seller (Amazon) — the createTracker call already made this
      const db = getDb();
      const amazonSeller = db.prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // Secondary seller (Newegg)
      const neweggSeller = addTrackerUrl(tracker.id, 'https://newegg.com/p/B');

      // --- Step 1: Amazon scrape fires an alert ---
      await checkTrackerUrl(amazonSeller.id);
      expect(countNotifications(tracker.id, amazonSeller.id)).toBe(1);
      expect(vi.mocked(sendDiscordPriceAlert)).toHaveBeenCalledTimes(1);

      // --- Step 2: Immediate second Amazon scrape is cooldown-suppressed ---
      vi.mocked(sendDiscordPriceAlert).mockClear();
      await checkTrackerUrl(amazonSeller.id);
      // No new notification row written for Amazon
      expect(countNotifications(tracker.id, amazonSeller.id)).toBe(1);
      // And no Discord call happened
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();

      // --- Step 3: Newegg scrape fires an alert (the invariant) ---
      // Amazon's cooldown row must NOT suppress the Newegg alert.
      vi.mocked(sendDiscordPriceAlert).mockClear();
      await checkTrackerUrl(neweggSeller.id);
      expect(countNotifications(tracker.id, neweggSeller.id)).toBe(1);
      expect(vi.mocked(sendDiscordPriceAlert)).toHaveBeenCalledTimes(1);

      // --- Step 4: Total notification rows is 2 (one per seller) ---
      const total = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE tracker_id = ?').get(tracker.id) as { c: number };
      expect(total.c).toBe(2);
    });
  });

  describe('same-seller cooldown', () => {
    it('a recent notification for the same seller suppresses the next alert', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      const tracker = createTracker({
        name: 'Single seller',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      await checkTrackerUrl(seller.id);
      expect(countNotifications(tracker.id, seller.id)).toBe(1);

      // Second check within cooldown window → suppressed
      vi.mocked(sendDiscordPriceAlert).mockClear();
      await checkTrackerUrl(seller.id);
      expect(countNotifications(tracker.id, seller.id)).toBe(1);
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
    });

    it('a notification older than the cooldown window is NOT in cooldown', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      const tracker = createTracker({
        name: 'Expired cooldown',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // Manually insert a notification from 12 hours ago (well past
      // the 6h default cooldown)
      const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);
      getDb().prepare(`
        INSERT INTO notifications (tracker_id, tracker_url_id, price, threshold_price, channel, sent_at)
        VALUES (?, ?, 40, 50, 'discord', ?)
      `).run(tracker.id, seller.id, twelveHoursAgo);

      // Now check — cooldown should NOT apply
      await checkTrackerUrl(seller.id);

      // A new notification row should have been written
      expect(countNotifications(tracker.id, seller.id)).toBe(2);
      expect(vi.mocked(sendDiscordPriceAlert)).toHaveBeenCalledTimes(1);
    });
  });

  describe('bypassCooldown flag', () => {
    it('bypassCooldown=true fires an alert even when cooldown is active', async () => {
      // This is the "Check Now" button path. Manual user actions
      // should never be silently suppressed.
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      const tracker = createTracker({
        name: 'Manual check bypass',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // First check fires an alert naturally
      await checkTrackerUrl(seller.id);
      expect(countNotifications(tracker.id, seller.id)).toBe(1);

      vi.mocked(sendDiscordPriceAlert).mockClear();

      // Second check WITH bypass → fires again despite cooldown
      await checkTrackerUrl(seller.id, true);
      expect(countNotifications(tracker.id, seller.id)).toBe(2);
      expect(vi.mocked(sendDiscordPriceAlert)).toHaveBeenCalledTimes(1);
    });

    it('bypassCooldown=false (the default) respects cooldown', async () => {
      // Sanity check: explicitly passing false = default behavior.
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      const tracker = createTracker({
        name: 'Default bypass false',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      await checkTrackerUrl(seller.id);
      vi.mocked(sendDiscordPriceAlert).mockClear();
      await checkTrackerUrl(seller.id, false);
      // Still in cooldown, no new alert
      expect(countNotifications(tracker.id, seller.id)).toBe(1);
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
    });
  });

  describe('threshold gating', () => {
    it('does not fire when price is above threshold', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      const tracker = createTracker({
        name: 'Above threshold',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      // Scrape returns $75, above the $50 threshold
      vi.mocked(extractPrice).mockResolvedValueOnce({
        price: 75, currency: 'USD', strategy: 'mock',
      });

      await checkTrackerUrl(seller.id);
      expect(countNotifications(tracker.id, seller.id)).toBe(0);
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
    });

    it('does not fire when the tracker has no threshold set', async () => {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/fake', userId);
      const tracker = createTracker({
        name: 'No threshold',
        url: 'https://amazon.com/dp/A',
        // no threshold_price
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      await checkTrackerUrl(seller.id);
      expect(countNotifications(tracker.id, seller.id)).toBe(0);
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
    });
  });

  describe('missing channels', () => {
    it('does not write a notification row when no channels are configured', async () => {
      const userId = seedTestUser();
      // No setSetting calls — no channels at all
      const tracker = createTracker({
        name: 'No channels',
        url: 'https://amazon.com/dp/A',
        threshold_price: 50,
        user_id: userId,
      });
      const seller = getDb().prepare('SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(tracker.id) as { id: number };

      await checkTrackerUrl(seller.id);
      // Threshold WAS crossed but no channels → no-op
      expect(countNotifications(tracker.id, seller.id)).toBe(0);
      expect(vi.mocked(sendDiscordPriceAlert)).not.toHaveBeenCalled();
    });
  });
});
