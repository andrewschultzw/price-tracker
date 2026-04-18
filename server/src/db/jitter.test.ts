import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { computeJitterMinutes, createTracker, getDueTrackerUrls } from './queries.js';
import { getDb } from './connection.js';

/**
 * Jitter sanity tests. The scheduler uses `check_interval_minutes +
 * jitter_minutes` in its "is this tracker due?" calc; a fixed per-tracker
 * jitter prevents N trackers with the same interval from all firing in
 * the same minute. Formula is defined by computeJitterMinutes and
 * duplicated in migration v5's backfill — these tests lock down the
 * invariants both rely on.
 */

function freshDb() {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'x', 'A')`).run();
  return db;
}

describe('computeJitterMinutes', () => {
  it('returns 0 when interval is too small to bother jittering', () => {
    expect(computeJitterMinutes(0)).toBe(0);
    expect(computeJitterMinutes(1)).toBe(0);
    expect(computeJitterMinutes(5)).toBe(0);
  });

  it('returns a value in [0, floor(interval/6)] for small-to-medium intervals', () => {
    // 60-min interval → cap = 10 → jitter in [0, 10]
    for (let i = 0; i < 50; i++) {
      const j = computeJitterMinutes(60);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(10);
    }
  });

  it('caps at 30 min for long intervals', () => {
    // 24h interval would otherwise give 240-min jitter; capped at 30.
    for (let i = 0; i < 50; i++) {
      const j = computeJitterMinutes(1440);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(30);
    }
  });

  it('produces some variability across calls (not stuck at 0)', () => {
    // 30 samples from a uniform [0, 30] distribution almost certainly
    // include at least two distinct values. If this ever fails the RNG
    // is wedged or the formula got stuck.
    const samples = new Set<number>();
    for (let i = 0; i < 30; i++) samples.add(computeJitterMinutes(360));
    expect(samples.size).toBeGreaterThan(1);
  });
});

describe('createTracker', () => {
  beforeEach(() => freshDb());

  it('stores a jitter_minutes value in the expected range', () => {
    const t = createTracker({ name: 'X', url: 'https://a.example/x', check_interval_minutes: 60, user_id: 1 });
    expect(t.jitter_minutes).toBeGreaterThanOrEqual(0);
    expect(t.jitter_minutes).toBeLessThanOrEqual(10);
  });

  it('defaults check_interval_minutes to 360 and jitter in the 0-30 range', () => {
    const t = createTracker({ name: 'Y', url: 'https://a.example/y', user_id: 1 });
    expect(t.check_interval_minutes).toBe(360);
    expect(t.jitter_minutes).toBeGreaterThanOrEqual(0);
    expect(t.jitter_minutes).toBeLessThanOrEqual(30);
  });
});

describe('getDueTrackerUrls factors jitter into the interval', () => {
  beforeEach(() => freshDb());

  it('skips a seller whose last_checked_at + interval is past but +jitter pushes past now', () => {
    // Interval=60, jitter=30, last_checked 70 min ago. Effective next-check
    // lands 20 min in the future → must NOT appear in due set.
    const t = createTracker({ name: 'Z', url: 'https://a.example/z', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 30 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE tracker_urls SET last_checked_at = datetime('now', '-70 minutes') WHERE tracker_id = ?`).run(t.id);

    const due = getDueTrackerUrls();
    expect(due.find(d => d.tracker_id === t.id)).toBeUndefined();
  });

  it('includes a seller once last_checked_at + interval + jitter is past', () => {
    // Interval=60, jitter=30, last_checked 100 min ago. Effective next-check
    // was 10 min ago → must appear in due set.
    const t = createTracker({ name: 'W', url: 'https://a.example/w', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 30 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE tracker_urls SET last_checked_at = datetime('now', '-100 minutes') WHERE tracker_id = ?`).run(t.id);

    const due = getDueTrackerUrls();
    expect(due.find(d => d.tracker_id === t.id)).toBeDefined();
  });

  it('includes a seller that has never been checked regardless of jitter', () => {
    const t = createTracker({ name: 'V', url: 'https://a.example/v', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 30 WHERE id = ?').run(t.id);
    // last_checked_at remains NULL (never scraped) → always due.
    const due = getDueTrackerUrls();
    expect(due.find(d => d.tracker_id === t.id)).toBeDefined();
  });
});
