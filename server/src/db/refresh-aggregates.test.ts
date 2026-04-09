import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker,
  addTrackerUrl,
  updateTrackerUrl,
  refreshTrackerAggregates,
  getTrackerById,
  getTrackerUrlsForTracker,
} from './queries.js';

/**
 * Integration tests for refreshTrackerAggregates — the function that
 * recomputes the tracker-level denormalized fields (last_price, status,
 * last_error, last_checked_at, consecutive_failures) from the child
 * tracker_urls rows after every scrape.
 *
 * These rules are easy to mis-remember and would silently show wrong
 * data on the dashboard if broken. An in-memory sqlite fixture gives
 * us real SQL without touching the production database.
 */

function seedTestUser(): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('test@example.com', 'fakehash', 'Test User', 'user', 1)
  `).run();
  return Number(result.lastInsertRowid);
}

describe('refreshTrackerAggregates', () => {
  beforeEach(() => {
    // Each test gets a clean in-memory DB so state from one test can't
    // leak into another. :memory: databases are cheap to create.
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema(); // creates tables and runs every migration
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  describe('last_price aggregation', () => {
    it('uses the min across all sellers with a price', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Multi-seller product',
        url: 'https://amazon.com/dp/A',
        threshold_price: 100,
        user_id: userId,
      });
      // Primary seller at $80 (from createTracker)
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { last_price: 80, status: 'active' });

      // Second seller at $75
      const secondary = addTrackerUrl(tracker.id, 'https://newegg.com/p/B');
      updateTrackerUrl(secondary.id, { last_price: 75, status: 'active' });

      // Third seller at $90
      const tertiary = addTrackerUrl(tracker.id, 'https://bhphotovideo.com/c/C');
      updateTrackerUrl(tertiary.id, { last_price: 90, status: 'active' });

      refreshTrackerAggregates(tracker.id);

      const refreshed = getTrackerById(tracker.id)!;
      expect(refreshed.last_price).toBe(75); // min across sellers
    });

    it('ignores sellers without a price when computing min', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Partial prices',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { last_price: 50, status: 'active' });

      // Add a seller that has never been scraped (last_price null)
      addTrackerUrl(tracker.id, 'https://b.com/2');

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.last_price).toBe(50);
    });

    it('sets last_price to null when no sellers have a price yet', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Unscraped',
        url: 'https://a.com/1',
        user_id: userId,
      });
      // The primary seller was just created with no scrape data

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.last_price).toBeNull();
    });
  });

  describe('status aggregation', () => {
    it("sets status='error' only when ALL sellers are errored", () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'All errored',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { status: 'error', last_error: 'oops' });

      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2');
      updateTrackerUrl(s2.id, { status: 'error', last_error: 'also oops' });

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.status).toBe('error');
    });

    it("does NOT set status='error' when only SOME sellers are errored", () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Mixed errors',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { status: 'error', last_error: 'only this one' });

      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2');
      updateTrackerUrl(s2.id, { status: 'active', last_price: 42 });

      refreshTrackerAggregates(tracker.id);
      const refreshed = getTrackerById(tracker.id)!;
      expect(refreshed.status).toBe('active');
      // Aggregate last_price still comes from the healthy seller
      expect(refreshed.last_price).toBe(42);
    });

    it("sets status='paused' only when ALL sellers are paused", () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'All paused',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { status: 'paused' });

      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2');
      updateTrackerUrl(s2.id, { status: 'paused' });

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.status).toBe('paused');
    });

    it("mixed paused + active → status='active'", () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Mixed pause',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { status: 'paused' });

      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2');
      updateTrackerUrl(s2.id, { status: 'active', last_price: 30 });

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.status).toBe('active');
    });

    it("mixed paused + errored → status='active' (defensive fallthrough)", () => {
      // Not a realistic state but the function should not crash and
      // should fall through to 'active' rather than picking one of them.
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Mixed weird',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { status: 'paused' });

      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2');
      updateTrackerUrl(s2.id, { status: 'error', last_error: 'uh' });

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.status).toBe('active');
    });
  });

  describe('last_error aggregation', () => {
    it('uses the first non-null last_error', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'One errored',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { last_error: 'scrape failed', consecutive_failures: 1 });

      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2');
      updateTrackerUrl(s2.id, { last_price: 42, status: 'active' });

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.last_error).toBe('scrape failed');
    });

    it('sets last_error to null when no sellers have an error', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'No errors',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { last_price: 42, status: 'active' });

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.last_error).toBeNull();
    });
  });

  describe('last_checked_at aggregation', () => {
    it('uses the max across sellers', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Checked at different times',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { last_checked_at: '2026-04-08 10:00:00', last_price: 50 });

      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2');
      updateTrackerUrl(s2.id, { last_checked_at: '2026-04-09 12:00:00', last_price: 55 });

      const s3 = addTrackerUrl(tracker.id, 'https://c.com/3');
      updateTrackerUrl(s3.id, { last_checked_at: '2026-04-08 15:00:00', last_price: 60 });

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.last_checked_at).toBe('2026-04-09 12:00:00');
    });
  });

  describe('consecutive_failures aggregation', () => {
    it('uses the max across sellers', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Varying failures',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, { consecutive_failures: 0 });

      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2');
      updateTrackerUrl(s2.id, { consecutive_failures: 5 });

      const s3 = addTrackerUrl(tracker.id, 'https://c.com/3');
      updateTrackerUrl(s3.id, { consecutive_failures: 2 });

      refreshTrackerAggregates(tracker.id);
      expect(getTrackerById(tracker.id)!.consecutive_failures).toBe(5);
    });
  });

  describe('edge cases', () => {
    it('is a no-op when the tracker has no sellers', () => {
      // Can't happen via normal API (createTracker always inserts a
      // primary seller) but defensive — shouldn't crash.
      const userId = seedTestUser();
      const db = getDb();
      const result = db.prepare(`
        INSERT INTO trackers (name, url, user_id, last_price)
        VALUES ('Orphan', 'https://nowhere.com/x', ?, 99)
      `).run(userId);
      const orphanId = Number(result.lastInsertRowid);
      expect(() => refreshTrackerAggregates(orphanId)).not.toThrow();
      // No sellers means nothing to aggregate, so the existing last_price
      // is left alone — the function short-circuits.
      expect(getTrackerById(orphanId)!.last_price).toBe(99);
    });

    it('single-seller tracker: aggregates match that one seller exactly', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Single seller',
        url: 'https://a.com/1',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      updateTrackerUrl(primary.id, {
        last_price: 42.5,
        last_checked_at: '2026-04-09 10:00:00',
        last_error: null,
        consecutive_failures: 0,
        status: 'active',
      });

      refreshTrackerAggregates(tracker.id);
      const refreshed = getTrackerById(tracker.id)!;
      expect(refreshed.last_price).toBe(42.5);
      expect(refreshed.last_checked_at).toBe('2026-04-09 10:00:00');
      expect(refreshed.last_error).toBeNull();
      expect(refreshed.consecutive_failures).toBe(0);
      expect(refreshed.status).toBe('active');
    });
  });
});
