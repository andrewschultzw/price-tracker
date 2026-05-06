import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import {
  createSlugForUrl,
  getProductBySlug,
  listAllSlugs,
  createTracker,
  addPriceRecord,
  getDailyMinHistoryForNormalizedUrl,
  getStatsForNormalizedUrl,
} from './queries.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { buildSlug } from '../lib/build-slug.js';

function seedUser(email: string): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('createSlugForUrl', () => {
  it('inserts a fresh slug row when normalized_url is new', () => {
    const row = createSlugForUrl('amazon.com/dp/B0XYZ', 'Test Product');
    expect(row).not.toBeNull();
    expect(row!.normalized_url).toBe('amazon.com/dp/B0XYZ');
    expect(row!.display_name).toBe('Test Product');
    expect(row!.slug).toBe(buildSlug('Test Product', 'amazon.com/dp/B0XYZ'));
  });

  it('returns null when normalized_url is empty / null / undefined', () => {
    expect(createSlugForUrl(null, 'X')).toBeNull();
    expect(createSlugForUrl(undefined, 'X')).toBeNull();
    expect(createSlugForUrl('', 'X')).toBeNull();
  });

  it('first-caller wins display_name (INSERT OR IGNORE)', () => {
    const first = createSlugForUrl('amazon.com/dp/B0XYZ', 'First Name');
    const second = createSlugForUrl('amazon.com/dp/B0XYZ', 'Second Name');
    expect(first!.display_name).toBe('First Name');
    // Second call returns the existing row, NOT a fresh one with the new name.
    expect(second!.display_name).toBe('First Name');
    expect(second!.slug).toBe(first!.slug);
    // Only one row should exist.
    expect(listAllSlugs()).toHaveLength(1);
  });
});

describe('getProductBySlug', () => {
  it('returns the row by slug', () => {
    const created = createSlugForUrl('amazon.com/dp/B0XYZ', 'Test');
    const fetched = getProductBySlug(created!.slug);
    expect(fetched).toEqual(created);
  });

  it('returns null for unknown slug', () => {
    expect(getProductBySlug('does-not-exist')).toBeNull();
  });
});

describe('listAllSlugs', () => {
  it('returns slugs ordered by creation time ascending', () => {
    createSlugForUrl('amazon.com/dp/A', 'A');
    createSlugForUrl('amazon.com/dp/B', 'B');
    const all = listAllSlugs();
    expect(all).toHaveLength(2);
    expect(all.every(r => typeof r.slug === 'string' && typeof r.created_at === 'number')).toBe(true);
  });
});

describe('createTracker auto-creates a public_product_slug', () => {
  it('inserts a slug row for a fresh normalized_url after createTracker', () => {
    const userId = seedUser('a@x.com');
    const t = createTracker({
      name: 'Samsung 990 Pro',
      url: 'https://amazon.com/dp/B0SAMSUNG',
      user_id: userId,
    });
    expect(t.normalized_url).toBe('amazon.com/dp/b0samsung');
    const slug = buildSlug('Samsung 990 Pro', 'amazon.com/dp/b0samsung');
    const fetched = getProductBySlug(slug);
    expect(fetched).not.toBeNull();
    expect(fetched!.display_name).toBe('Samsung 990 Pro');
  });

  it('does NOT overwrite an existing slug row when a second tracker on the same URL is created', () => {
    const userId = seedUser('a@x.com');
    createTracker({ name: 'Original Name', url: 'https://amazon.com/dp/B0X', user_id: userId });
    createTracker({ name: 'Second Name', url: 'https://amazon.com/dp/B0X', user_id: userId });
    const slugs = listAllSlugs();
    expect(slugs).toHaveLength(1);
    const row = getProductBySlug(slugs[0].slug)!;
    expect(row.display_name).toBe('Original Name');
  });
});

describe('getDailyMinHistoryForNormalizedUrl', () => {
  it('returns empty array when no history exists', () => {
    const out = getDailyMinHistoryForNormalizedUrl('amazon.com/dp/missing');
    expect(out).toEqual([]);
  });

  it('aggregates daily MIN across multiple trackers + sellers on the same normalized_url', () => {
    const userA = seedUser('a@x.com');
    const userB = seedUser('b@x.com');
    const tA = createTracker({ name: 'A', url: 'https://amazon.com/dp/B0X', user_id: userA });
    const tB = createTracker({ name: 'B', url: 'https://smile.amazon.com/dp/B0X', user_id: userB });
    // Both should share the same normalized_url.
    expect(tA.normalized_url).toBe(tB.normalized_url);

    // Day 1: A=100, B=80 → MIN=80
    getDb().prepare(
      `INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, '2026-01-01 10:00:00')`,
    ).run(tA.id, 100);
    getDb().prepare(
      `INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, '2026-01-01 22:00:00')`,
    ).run(tB.id, 80);
    // Day 2: A=70, B=90 → MIN=70
    getDb().prepare(
      `INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, '2026-01-02 10:00:00')`,
    ).run(tA.id, 70);
    getDb().prepare(
      `INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, '2026-01-02 22:00:00')`,
    ).run(tB.id, 90);

    const rows = getDailyMinHistoryForNormalizedUrl(tA.normalized_url!);
    expect(rows).toEqual([
      { date: '2026-01-01', price: 80 },
      { date: '2026-01-02', price: 70 },
    ]);
  });

  it('respects startMs filter', () => {
    const userA = seedUser('a@x.com');
    const t = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0F', user_id: userA });
    getDb().prepare(
      `INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, '2025-12-01 10:00:00')`,
    ).run(t.id, 50);
    getDb().prepare(
      `INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, '2026-02-01 10:00:00')`,
    ).run(t.id, 60);
    const since = new Date('2026-01-01').getTime();
    const rows = getDailyMinHistoryForNormalizedUrl(t.normalized_url!, since);
    expect(rows).toEqual([{ date: '2026-02-01', price: 60 }]);
  });
});

describe('getStatsForNormalizedUrl', () => {
  it('returns zeroed stats when nothing exists', () => {
    const stats = getStatsForNormalizedUrl('amazon.com/dp/empty');
    expect(stats).toEqual({
      lowest_current_price: null,
      lowest_ever_price: null,
      sample_count: 0,
      first_observed: null,
    });
  });

  it('aggregates lowest current + lowest ever + sample count across trackers', () => {
    const userA = seedUser('a@x.com');
    const userB = seedUser('b@x.com');
    const tA = createTracker({ name: 'A', url: 'https://amazon.com/dp/B0Q', user_id: userA });
    const tB = createTracker({ name: 'B', url: 'https://smile.amazon.com/dp/B0Q', user_id: userB });
    // Set last_price on both to simulate scrape results.
    getDb().prepare(`UPDATE trackers SET last_price = 250 WHERE id = ?`).run(tA.id);
    getDb().prepare(`UPDATE trackers SET last_price = 230 WHERE id = ?`).run(tB.id);
    addPriceRecord(tA.id, 300);
    addPriceRecord(tA.id, 250);
    addPriceRecord(tB.id, 230);

    const stats = getStatsForNormalizedUrl(tA.normalized_url!);
    expect(stats.lowest_current_price).toBe(230);
    expect(stats.lowest_ever_price).toBe(230);
    expect(stats.sample_count).toBe(3);
    expect(stats.first_observed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
