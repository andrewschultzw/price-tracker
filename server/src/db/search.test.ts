import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { searchTrackersByName } from './queries.js';

function seedUser(email = 'a@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function seedTracker(userId: number, name: string, opts: {
  status?: string;
  last_price?: number | null;
  ai_verdict_tier?: 'BUY' | 'WAIT' | 'HOLD' | null;
} = {}): number {
  const status = opts.status ?? 'active';
  const last_price = opts.last_price ?? null;
  const tier = opts.ai_verdict_tier ?? null;
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes, last_price, ai_verdict_tier)
     VALUES (?, 'https://example.com/' || ?, ?, ?, 60, 0, ?, ?)`,
  ).run(name, name, userId, status, last_price, tier).lastInsertRowid);
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('searchTrackersByName', () => {
  it('returns [] for an empty query', () => {
    const u = seedUser();
    seedTracker(u, 'Samsung 990 Pro 4TB');
    expect(searchTrackersByName(u, '')).toEqual([]);
  });

  it('returns [] for a whitespace-only query', () => {
    const u = seedUser();
    seedTracker(u, 'Samsung 990 Pro 4TB');
    expect(searchTrackersByName(u, '   ')).toEqual([]);
  });

  it('finds a tracker by case-sensitive substring', () => {
    const u = seedUser();
    seedTracker(u, 'Samsung 990 Pro 4TB');
    seedTracker(u, 'WD Red 10TB');
    const results = searchTrackersByName(u, 'Samsung');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Samsung 990 Pro 4TB');
  });

  it('matches case-insensitively', () => {
    const u = seedUser();
    seedTracker(u, 'Samsung 990 Pro 4TB');
    const results = searchTrackersByName(u, 'samsung');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Samsung 990 Pro 4TB');
  });

  it('ranks shorter matching names first', () => {
    const u = seedUser();
    seedTracker(u, '27-inch LG Monitor with extras');
    seedTracker(u, 'LG Monitor');
    const results = searchTrackersByName(u, 'monitor');
    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('LG Monitor');
    expect(results[1].name).toBe('27-inch LG Monitor with extras');
  });

  it('does not return another user\'s trackers', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    seedTracker(u1, 'Samsung A');
    seedTracker(u2, 'Samsung B');
    const results = searchTrackersByName(u1, 'samsung');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Samsung A');
  });

  it('respects the limit', () => {
    const u = seedUser();
    for (let i = 0; i < 5; i++) seedTracker(u, `Monitor ${i}`);
    const results = searchTrackersByName(u, 'monitor', 2);
    expect(results).toHaveLength(2);
  });

  it('excludes paused trackers', () => {
    const u = seedUser();
    seedTracker(u, 'Active Monitor', { status: 'active' });
    seedTracker(u, 'Paused Monitor', { status: 'paused' });
    const results = searchTrackersByName(u, 'monitor');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('Active Monitor');
  });

  it('returns id, name, last_price, ai_verdict_tier', () => {
    const u = seedUser();
    seedTracker(u, 'Thing', { last_price: 99.99, ai_verdict_tier: 'BUY' });
    const results = searchTrackersByName(u, 'thing');
    expect(results).toHaveLength(1);
    expect(results[0].id).toBeGreaterThan(0);
    expect(results[0].name).toBe('Thing');
    expect(results[0].last_price).toBe(99.99);
    expect(results[0].ai_verdict_tier).toBe('BUY');
  });
});
