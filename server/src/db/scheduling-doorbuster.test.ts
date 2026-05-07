import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker, getDueTrackers, getDueTrackerUrls, isDoorbusterActive,
  type Tracker,
} from './queries.js';

/**
 * Doorbuster scheduling tests. Three rules to lock down:
 *
 *   1. With any of the 3 doorbuster fields NULL, scheduling is identical
 *      to today (regression-test against the existing interval+jitter math).
 *   2. With all 3 set AND `now` inside [start, end], `getDueTrackers` and
 *      `getDueTrackerUrls` use doorbuster_interval_minutes as the cadence.
 *   3. With all 3 set but `now` outside the window (future or past),
 *      scheduling falls back to interval+jitter unchanged.
 *
 * `isDoorbusterActive` mirrors the SQL CASE in TS for use by alert
 * rendering / UI; it must agree with the SQL in all four boundary cases.
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

beforeEach(() => freshDb());

describe('getDueTrackers — doorbuster cadence switching', () => {
  it('1. no doorbuster + last_checked 30m ago + interval=60 → NOT due', () => {
    const t = createTracker({ name: 'A', url: 'https://a.example/a', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 0 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE trackers SET last_checked_at = datetime('now', '-30 minutes') WHERE id = ?`).run(t.id);

    const due = getDueTrackers();
    expect(due.find(d => d.id === t.id)).toBeUndefined();
  });

  it('2. no doorbuster + last_checked 70m ago + interval=60 → due (regression check)', () => {
    const t = createTracker({ name: 'B', url: 'https://a.example/b', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 0 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE trackers SET last_checked_at = datetime('now', '-70 minutes') WHERE id = ?`).run(t.id);

    const due = getDueTrackers();
    expect(due.find(d => d.id === t.id)).toBeDefined();
  });

  it('3. doorbuster_interval=3, window covers now, last_checked 5m ago → due (3 < 5)', () => {
    const t = createTracker({ name: 'C', url: 'https://a.example/c', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 0 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE trackers SET
        last_checked_at = datetime('now', '-5 minutes'),
        doorbuster_start_at = datetime('now', '-1 hour'),
        doorbuster_end_at = datetime('now', '+1 hour'),
        doorbuster_interval_minutes = 3
      WHERE id = ?`).run(t.id);

    const due = getDueTrackers();
    expect(due.find(d => d.id === t.id)).toBeDefined();
  });

  it('4. doorbuster_interval=3, window covers now, last_checked 1m ago → NOT due (1 < 3)', () => {
    const t = createTracker({ name: 'D', url: 'https://a.example/d', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 0 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE trackers SET
        last_checked_at = datetime('now', '-1 minute'),
        doorbuster_start_at = datetime('now', '-1 hour'),
        doorbuster_end_at = datetime('now', '+1 hour'),
        doorbuster_interval_minutes = 3
      WHERE id = ?`).run(t.id);

    const due = getDueTrackers();
    expect(due.find(d => d.id === t.id)).toBeUndefined();
  });

  it('5. doorbuster window in FUTURE → uses normal interval (interval=60, last_checked 30m ago → NOT due)', () => {
    const t = createTracker({ name: 'E', url: 'https://a.example/e', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 0 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE trackers SET
        last_checked_at = datetime('now', '-30 minutes'),
        doorbuster_start_at = datetime('now', '+1 hour'),
        doorbuster_end_at = datetime('now', '+2 hours'),
        doorbuster_interval_minutes = 3
      WHERE id = ?`).run(t.id);

    // 30m elapsed against a 60m normal interval → not due. If the SQL
    // mistakenly took the doorbuster cadence (3min), this would be due.
    const due = getDueTrackers();
    expect(due.find(d => d.id === t.id)).toBeUndefined();
  });

  it('6. doorbuster window in PAST → uses normal interval (interval=60, last_checked 30m ago → NOT due)', () => {
    const t = createTracker({ name: 'F', url: 'https://a.example/f', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 0 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE trackers SET
        last_checked_at = datetime('now', '-30 minutes'),
        doorbuster_start_at = datetime('now', '-2 hours'),
        doorbuster_end_at = datetime('now', '-1 hour'),
        doorbuster_interval_minutes = 3
      WHERE id = ?`).run(t.id);

    const due = getDueTrackers();
    expect(due.find(d => d.id === t.id)).toBeUndefined();
  });
});

describe('getDueTrackerUrls — doorbuster cadence switching (per-seller)', () => {
  it('seller inherits accelerated cadence when parent tracker is in doorbuster window', () => {
    const t = createTracker({ name: 'G', url: 'https://a.example/g', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 0 WHERE id = ?').run(t.id);
    db.prepare(`UPDATE trackers SET
        doorbuster_start_at = datetime('now', '-1 hour'),
        doorbuster_end_at = datetime('now', '+1 hour'),
        doorbuster_interval_minutes = 3
      WHERE id = ?`).run(t.id);
    // Seller checked 5 min ago — past the 3-min doorbuster cadence but not
    // past the normal 60-min interval. Must appear in due set.
    db.prepare(`UPDATE tracker_urls SET last_checked_at = datetime('now', '-5 minutes') WHERE tracker_id = ?`).run(t.id);

    const due = getDueTrackerUrls();
    expect(due.find(d => d.tracker_id === t.id)).toBeDefined();
  });

  it('seller falls back to normal interval when doorbuster fields are NULL on parent', () => {
    const t = createTracker({ name: 'H', url: 'https://a.example/h', check_interval_minutes: 60, user_id: 1 });
    const db = getDb();
    db.prepare('UPDATE trackers SET jitter_minutes = 0 WHERE id = ?').run(t.id);
    // Seller checked 5 min ago — well within the 60-min interval. Must NOT
    // appear in due set.
    db.prepare(`UPDATE tracker_urls SET last_checked_at = datetime('now', '-5 minutes') WHERE tracker_id = ?`).run(t.id);

    const due = getDueTrackerUrls();
    expect(due.find(d => d.tracker_id === t.id)).toBeUndefined();
  });
});

describe('isDoorbusterActive', () => {
  function makeTracker(overrides: Partial<Tracker>): Tracker {
    return {
      id: 1, name: '', url: '', normalized_url: null, threshold_price: null,
      check_interval_minutes: 60, jitter_minutes: 0, css_selector: null,
      last_price: null, last_checked_at: null, last_error: null,
      consecutive_failures: 0, status: 'active',
      created_at: '', updated_at: '', user_id: 1,
      ai_verdict_tier: null, ai_verdict_reason: null, ai_verdict_reason_key: null,
      ai_verdict_updated_at: null, ai_summary: null, ai_summary_updated_at: null,
      ai_signals_json: null, ai_failure_count: 0,
      doorbuster_start_at: null, doorbuster_end_at: null, doorbuster_interval_minutes: null,
      ...overrides,
    };
  }

  it('returns false when any of the 3 fields is null', () => {
    const now = new Date('2026-11-28T10:00:00Z');
    const start = '2026-11-28T00:00:00Z';
    const end = '2026-11-28T23:59:59Z';
    expect(isDoorbusterActive(makeTracker({}), now)).toBe(false);
    expect(isDoorbusterActive(makeTracker({ doorbuster_start_at: start }), now)).toBe(false);
    expect(isDoorbusterActive(makeTracker({ doorbuster_start_at: start, doorbuster_end_at: end }), now)).toBe(false);
    expect(isDoorbusterActive(makeTracker({ doorbuster_start_at: start, doorbuster_interval_minutes: 3 }), now)).toBe(false);
    expect(isDoorbusterActive(makeTracker({ doorbuster_end_at: end, doorbuster_interval_minutes: 3 }), now)).toBe(false);
  });

  it('returns true when now is between start and end with all fields set', () => {
    const tracker = makeTracker({
      doorbuster_start_at: '2026-11-28T00:00:00Z',
      doorbuster_end_at: '2026-11-28T23:59:59Z',
      doorbuster_interval_minutes: 3,
    });
    expect(isDoorbusterActive(tracker, new Date('2026-11-28T10:00:00Z'))).toBe(true);
  });

  it('returns false when now is before start or after end', () => {
    const tracker = makeTracker({
      doorbuster_start_at: '2026-11-28T00:00:00Z',
      doorbuster_end_at: '2026-11-28T23:59:59Z',
      doorbuster_interval_minutes: 3,
    });
    expect(isDoorbusterActive(tracker, new Date('2026-11-27T23:00:00Z'))).toBe(false);
    expect(isDoorbusterActive(tracker, new Date('2026-11-29T00:00:01Z'))).toBe(false);
  });
});
