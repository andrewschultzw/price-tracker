import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Integration tests for migration v4 — the multi-seller backfill.
 * This migration is the one most likely to cause pain on a real
 * upgrade because it:
 *
 *   1. Creates a new tracker_urls table
 *   2. Adds nullable tracker_url_id FKs to price_history and notifications
 *   3. Backfills a primary seller row for every existing tracker, copying
 *      scrape state from the tracker row itself
 *   4. Points existing price_history and notifications rows at their
 *      newly created primary seller
 *
 * The idempotency contract: re-running the migration must be a no-op.
 * If anything loops or double-inserts, the second run should still
 * leave the DB in a consistent state (which is tested here by running
 * runMigrations() twice and asserting no changes on the second pass).
 *
 * Test strategy: build a pre-v4 DB schema by hand (so the in-memory
 * DB starts without tracker_urls), insert legacy-shaped data, run the
 * migrations forward, then assert the backfill did exactly what we
 * expect.
 */

function buildPreV4Schema(db: Database.Database): void {
  // The schema as it existed before migration v4 was introduced. Only
  // the tables migration v4 touches are created here; we skip the
  // regular initializeSchema path entirely to force migration v4 to
  // run against a realistic "upgrading from v3" state.
  const ddl = `
    CREATE TABLE trackers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      threshold_price REAL,
      check_interval_minutes INTEGER NOT NULL DEFAULT 360,
      css_selector TEXT,
      last_price REAL,
      last_checked_at TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'error')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER
    );

    CREATE TABLE price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
      price REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
      price REAL NOT NULL,
      threshold_price REAL NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now')),
      channel TEXT
    );

    CREATE TABLE settings (
      user_id INTEGER,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );

    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_migrations (version) VALUES (1), (2), (3);
  `;
  db.exec(ddl);
}

function seedLegacyData(db: Database.Database): { trackerId: number; priceId: number; notifId: number } {
  db.prepare(`
    INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'x', 'A')
  `).run();

  // Create a pre-v4 tracker with a few fields populated so the backfill
  // has something meaningful to copy over.
  const trackerResult = db.prepare(`
    INSERT INTO trackers (name, url, threshold_price, last_price, last_checked_at,
                          last_error, consecutive_failures, status, user_id)
    VALUES ('Legacy Tracker', 'https://amazon.com/dp/LEGACY', 100, 85,
            '2026-04-05 10:00:00', NULL, 0, 'active', 1)
  `).run();
  const trackerId = Number(trackerResult.lastInsertRowid);

  // A few pre-v4 price history rows (no tracker_url_id column yet)
  const priceResult = db.prepare(`
    INSERT INTO price_history (tracker_id, price, currency) VALUES (?, 85, 'USD')
  `).run(trackerId);
  const priceId = Number(priceResult.lastInsertRowid);
  db.prepare(`INSERT INTO price_history (tracker_id, price) VALUES (?, 90)`).run(trackerId);
  db.prepare(`INSERT INTO price_history (tracker_id, price) VALUES (?, 88)`).run(trackerId);

  // A pre-v4 notification row
  const notifResult = db.prepare(`
    INSERT INTO notifications (tracker_id, price, threshold_price, channel)
    VALUES (?, 85, 100, 'discord')
  `).run(trackerId);
  const notifId = Number(notifResult.lastInsertRowid);

  return { trackerId, priceId, notifId };
}

describe('migration v4 — multi-seller backfill', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  it('creates the tracker_urls table and adds tracker_url_id to child tables', () => {
    const db = getDb();
    buildPreV4Schema(db);

    const preCols = db.prepare("PRAGMA table_info(price_history)").all() as { name: string }[];
    expect(preCols.some(c => c.name === 'tracker_url_id')).toBe(false);

    runMigrations();

    const tuCols = db.prepare("PRAGMA table_info(tracker_urls)").all() as { name: string }[];
    const tuColNames = tuCols.map(c => c.name);
    for (const expected of ['id', 'tracker_id', 'url', 'position', 'last_price',
                             'last_checked_at', 'last_error', 'consecutive_failures',
                             'status', 'created_at', 'updated_at']) {
      expect(tuColNames).toContain(expected);
    }

    const phCols = db.prepare("PRAGMA table_info(price_history)").all() as { name: string }[];
    expect(phCols.some(c => c.name === 'tracker_url_id')).toBe(true);
    const nCols = db.prepare("PRAGMA table_info(notifications)").all() as { name: string }[];
    expect(nCols.some(c => c.name === 'tracker_url_id')).toBe(true);
  });

  it('backfills a primary tracker_urls row for every existing tracker', () => {
    const db = getDb();
    buildPreV4Schema(db);
    const { trackerId } = seedLegacyData(db);

    runMigrations();

    const sellers = db.prepare('SELECT * FROM tracker_urls WHERE tracker_id = ?').all(trackerId) as Array<{
      tracker_id: number; url: string; position: number;
      last_price: number; last_checked_at: string; status: string;
    }>;
    expect(sellers).toHaveLength(1);
    expect(sellers[0].position).toBe(0);
    expect(sellers[0].url).toBe('https://amazon.com/dp/LEGACY');
    expect(sellers[0].last_price).toBe(85);
    expect(sellers[0].last_checked_at).toBe('2026-04-05 10:00:00');
    expect(sellers[0].status).toBe('active');
  });

  it('points existing price_history rows at the newly created primary seller', () => {
    const db = getDb();
    buildPreV4Schema(db);
    const { trackerId } = seedLegacyData(db);

    runMigrations();

    const primary = db.prepare('SELECT id FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(trackerId) as { id: number };
    const rows = db.prepare('SELECT tracker_url_id, price FROM price_history WHERE tracker_id = ? ORDER BY id').all(trackerId) as Array<{ tracker_url_id: number | null; price: number }>;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.tracker_url_id).toBe(primary.id);
    }
  });

  it('points existing notification rows at the newly created primary seller', () => {
    const db = getDb();
    buildPreV4Schema(db);
    const { trackerId } = seedLegacyData(db);

    runMigrations();

    const primary = db.prepare('SELECT id FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(trackerId) as { id: number };
    const rows = db.prepare('SELECT tracker_url_id FROM notifications WHERE tracker_id = ?').all(trackerId) as Array<{ tracker_url_id: number | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].tracker_url_id).toBe(primary.id);
  });

  describe('idempotency', () => {
    it('running the migration twice is a no-op the second time', () => {
      const db = getDb();
      buildPreV4Schema(db);
      const { trackerId } = seedLegacyData(db);

      runMigrations();

      const sellersAfterFirst = db.prepare('SELECT * FROM tracker_urls').all();
      const phAfterFirst = db.prepare('SELECT id, tracker_id, tracker_url_id, price FROM price_history ORDER BY id').all();
      const notifAfterFirst = db.prepare('SELECT id, tracker_id, tracker_url_id, price FROM notifications ORDER BY id').all();

      // Force the migration to be eligible to run again. The LEFT JOIN
      // guard should skip trackers that already have a primary seller.
      db.prepare('DELETE FROM schema_migrations WHERE version = 4').run();

      runMigrations();

      const sellersAfterSecond = db.prepare('SELECT * FROM tracker_urls').all();
      const phAfterSecond = db.prepare('SELECT id, tracker_id, tracker_url_id, price FROM price_history ORDER BY id').all();
      const notifAfterSecond = db.prepare('SELECT id, tracker_id, tracker_url_id, price FROM notifications ORDER BY id').all();

      expect(sellersAfterSecond).toEqual(sellersAfterFirst);
      expect(phAfterSecond).toEqual(phAfterFirst);
      expect(notifAfterSecond).toEqual(notifAfterFirst);

      const primaryCount = db.prepare(
        'SELECT COUNT(*) as c FROM tracker_urls WHERE tracker_id = ? AND position = 0',
      ).get(trackerId) as { c: number };
      expect(primaryCount.c).toBe(1);
    });

    it('running against a tracker that already has a primary seller does not duplicate it', () => {
      // Direct test of the LEFT JOIN guard. Pre-seed a tracker_urls row
      // before running migrations so the backfill INSERT should skip
      // that tracker (mimics a partially-migrated interrupted upgrade).
      const db = getDb();
      buildPreV4Schema(db);
      const { trackerId } = seedLegacyData(db);

      const createTrackerUrls = `
        CREATE TABLE tracker_urls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
          url TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          last_price REAL,
          last_checked_at TEXT,
          last_error TEXT,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `;
      db.exec(createTrackerUrls);
      db.prepare(`
        INSERT INTO tracker_urls (tracker_id, url, position, last_price) VALUES (?, ?, 0, 77)
      `).run(trackerId, 'https://amazon.com/dp/LEGACY');

      runMigrations();

      // Exactly ONE primary for this tracker, and it should be the
      // pre-existing one (last_price=77), not a fresh backfill (which
      // would have copied last_price=85 from the tracker row).
      const primaries = db.prepare(
        'SELECT * FROM tracker_urls WHERE tracker_id = ? AND position = 0',
      ).all(trackerId) as Array<{ last_price: number }>;
      expect(primaries).toHaveLength(1);
      expect(primaries[0].last_price).toBe(77);
    });
  });

  describe('child table backfill guard', () => {
    it('only backfills rows where tracker_url_id IS NULL', () => {
      // Simulates a partially-migrated state where some rows already
      // have tracker_url_id set. Running the migration shouldn't
      // clobber those.
      const db = getDb();
      buildPreV4Schema(db);
      const { trackerId, priceId } = seedLegacyData(db);

      runMigrations();
      const primary = db.prepare('SELECT id FROM tracker_urls WHERE tracker_id = ? AND position = 0').get(trackerId) as { id: number };

      // Add a second seller so we have a second tracker_url to point at,
      // then manually aim one price_history row at it to simulate a row
      // that was backfilled in a previous run.
      const secondSellerResult = db.prepare(`
        INSERT INTO tracker_urls (tracker_id, url, position, last_price) VALUES (?, ?, 1, 77)
      `).run(trackerId, 'https://b.com/x');
      const secondSellerId = Number(secondSellerResult.lastInsertRowid);
      db.prepare('UPDATE price_history SET tracker_url_id = ? WHERE id = ?').run(secondSellerId, priceId);

      // Force migration v4 to run again
      db.prepare('DELETE FROM schema_migrations WHERE version = 4').run();
      runMigrations();

      // The row we manually pointed at secondSellerId should still be
      // pointed there — the WHERE tracker_url_id IS NULL guard should
      // have skipped it.
      const row = db.prepare('SELECT tracker_url_id FROM price_history WHERE id = ?').get(priceId) as { tracker_url_id: number };
      expect(row.tracker_url_id).toBe(secondSellerId);

      // And the other price_history rows that were NULL should still
      // point at the primary
      const others = db.prepare('SELECT tracker_url_id FROM price_history WHERE tracker_id = ? AND id != ?').all(trackerId, priceId) as Array<{ tracker_url_id: number }>;
      for (const r of others) expect(r.tracker_url_id).toBe(primary.id);
    });
  });
});
