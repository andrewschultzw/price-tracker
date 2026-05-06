import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import {
  createTracker,
  setSetting,
  addNotification,
  getCommunityDealFeed,
} from './queries.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Insert a user and (optionally) opt them into the deal feed.
 * Returns the new user id.
 */
function seedUser(email: string, optIn: boolean): number {
  const id = Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
  if (optIn) {
    setSetting('share_in_deal_feed', 'true', id);
  }
  return id;
}

/**
 * Create a tracker and let createTracker stamp the public_product_slug for
 * its normalized URL — same path used by the production tracker-creation
 * flow. Returns the resulting tracker (which carries the normalized_url).
 */
function seedTrackerWithSlug(userId: number, url: string, displayName: string) {
  return createTracker({ name: displayName, url, user_id: userId });
}

/**
 * Insert a notification with a custom sent_at (so we can construct
 * recency edge cases). Uses raw SQL because addNotification()'s default
 * sent_at is `now`.
 */
function seedNotification(
  trackerId: number,
  price: number,
  threshold: number,
  sentAt: string,
): void {
  getDb().prepare(`
    INSERT INTO notifications (tracker_id, tracker_url_id, price, threshold_price, sent_at)
    VALUES (?, NULL, ?, ?, ?)
  `).run(trackerId, price, threshold, sentAt);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('getCommunityDealFeed', () => {
  it('returns [] when no users are opted in', () => {
    const u = seedUser('a@x.com', false);
    const t = seedTrackerWithSlug(u, 'https://amazon.com/dp/B0OPT0', 'Widget');
    addNotification(t.id, 50, 100);
    expect(getCommunityDealFeed()).toEqual([]);
  });

  it('returns one entry when an opted-in user has a recent threshold-beating notification', () => {
    const u = seedUser('a@x.com', true);
    const t = seedTrackerWithSlug(u, 'https://amazon.com/dp/B0OPT1', 'Sample Product');
    addNotification(t.id, 80, 100);
    const feed = getCommunityDealFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].display_name).toBe('Sample Product');
    expect(feed[0].current_price).toBe(80);
    expect(feed[0].threshold_price).toBe(100);
    expect(feed[0].drop_pct).toBeCloseTo(0.2, 5);
    expect(feed[0].normalized_url).toBe('amazon.com/dp/b0opt1');
    // Just-now notification rounds to 0 hours ago.
    expect(feed[0].hours_ago).toBeGreaterThanOrEqual(0);
    expect(feed[0].hours_ago).toBeLessThan(2);
    // Slug is built off the display name + normalized URL.
    expect(typeof feed[0].slug).toBe('string');
    expect(feed[0].slug.length).toBeGreaterThan(0);
  });

  it('excludes notifications belonging to opted-out users', () => {
    const a = seedUser('a@x.com', true);
    const b = seedUser('b@x.com', false);
    const tA = seedTrackerWithSlug(a, 'https://amazon.com/dp/B0AAA', 'Product A');
    const tB = seedTrackerWithSlug(b, 'https://amazon.com/dp/B0BBB', 'Product B');
    addNotification(tA.id, 70, 100);
    addNotification(tB.id, 60, 100);
    const feed = getCommunityDealFeed();
    expect(feed).toHaveLength(1);
    expect(feed[0].display_name).toBe('Product A');
  });

  it('excludes notifications older than 7 days', () => {
    const u = seedUser('a@x.com', true);
    const t = seedTrackerWithSlug(u, 'https://amazon.com/dp/B0OLD', 'Old Deal');
    seedNotification(t.id, 50, 100, '2024-01-01 12:00:00');
    expect(getCommunityDealFeed()).toEqual([]);
  });

  it('excludes notifications for trackers without a normalized_url', () => {
    const u = seedUser('a@x.com', true);
    // A non-URL "tracker name" produces normalized_url = null in createTracker.
    const t = seedTrackerWithSlug(u, 'not-a-url', 'Orphan');
    expect(t.normalized_url).toBeNull();
    addNotification(t.id, 10, 50);
    expect(getCommunityDealFeed()).toEqual([]);
  });

  it('excludes products without a public_product_slug entry', () => {
    const u = seedUser('a@x.com', true);
    const t = seedTrackerWithSlug(u, 'https://amazon.com/dp/B0SLUG', 'Slugless');
    // Drop the auto-created slug — simulates an orphan tracker that bypassed
    // createSlugForUrl (legacy data).
    getDb().prepare(`DELETE FROM public_product_slugs WHERE normalized_url = ?`).run(t.normalized_url);
    addNotification(t.id, 50, 100);
    expect(getCommunityDealFeed()).toEqual([]);
  });

  it('sorts by drop_pct descending — biggest deal first', () => {
    const u = seedUser('a@x.com', true);
    const tSmall = seedTrackerWithSlug(u, 'https://amazon.com/dp/B0SMALL', 'Small Drop');
    const tBig = seedTrackerWithSlug(u, 'https://amazon.com/dp/B0BIG', 'Big Drop');
    addNotification(tSmall.id, 90, 100); // 10% drop
    addNotification(tBig.id, 70, 100);   // 30% drop
    const feed = getCommunityDealFeed();
    expect(feed.map(e => e.display_name)).toEqual(['Big Drop', 'Small Drop']);
  });

  it('collapses duplicate-product notifications to the most recent one', () => {
    const u = seedUser('a@x.com', true);
    const t = seedTrackerWithSlug(u, 'https://amazon.com/dp/B0DUP', 'Dup Product');
    // Older notification: 12 hours ago. Newer: now.
    getDb().prepare(`
      INSERT INTO notifications (tracker_id, tracker_url_id, price, threshold_price, sent_at)
      VALUES (?, NULL, ?, ?, datetime('now', '-12 hours'))
    `).run(t.id, 80, 100);
    addNotification(t.id, 80, 100); // most recent (sent_at defaults to now)

    const feed = getCommunityDealFeed();
    expect(feed).toHaveLength(1);
    // hours_ago should reflect the most-recent notification (≈ 0), not the
    // 12-hour-old one.
    expect(feed[0].hours_ago).toBeLessThan(2);
  });

  it('honors the limit parameter', () => {
    const u = seedUser('a@x.com', true);
    for (let i = 0; i < 5; i++) {
      const t = seedTrackerWithSlug(u, `https://amazon.com/dp/B0LIM${i}`, `Product ${i}`);
      // Vary the price so drop_pct differs and the sort order is well-defined.
      addNotification(t.id, 100 - i * 5, 100);
    }
    expect(getCommunityDealFeed(2)).toHaveLength(2);
    expect(getCommunityDealFeed(5)).toHaveLength(5);
  });
});
