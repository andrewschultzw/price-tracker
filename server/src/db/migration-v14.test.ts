import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
});

describe('migration v14 - condition column on tracker_urls', () => {
  it('adds the condition column with the expected CHECK and default', () => {
    initializeSchema();
    const cols = (getDb()
      .prepare(`PRAGMA table_info(tracker_urls)`)
      .all() as Array<{ name: string; type: string; dflt_value: string | null; notnull: number }>)
      .filter(c => c.name === 'condition');
    expect(cols).toHaveLength(1);
    expect(cols[0].type.toUpperCase()).toBe('TEXT');
    expect(cols[0].notnull).toBe(1);
    expect(cols[0].dflt_value).toBe("'new'");
  });

  it("backfills existing tracker_urls rows with default 'new'", () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
                VALUES ('T','https://amazon.com/dp/X', 1, 'active', 60, 0)`).run();
    db.prepare(`INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, ?, 0)`)
      .run(1, 'https://amazon.com/dp/X');
    const row = db.prepare(`SELECT condition FROM tracker_urls WHERE tracker_id = 1`)
      .get() as { condition: string };
    expect(row.condition).toBe('new');
  });

  it('CHECK constraint rejects invalid values', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
                VALUES ('T','https://amazon.com/dp/X', 1, 'active', 60, 0)`).run();
    expect(() =>
      db.prepare(
        `INSERT INTO tracker_urls (tracker_id, url, position, condition) VALUES (?, ?, 0, ?)`,
      ).run(1, 'https://amazon.com/dp/X', 'used'),
    ).toThrow(/CHECK/);
  });

  it('accepts each of the four allowed values', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
                VALUES ('T','https://amazon.com/dp/X', 1, 'active', 60, 0)`).run();
    const insert = db.prepare(
      `INSERT INTO tracker_urls (tracker_id, url, position, condition) VALUES (?, ?, ?, ?)`,
    );
    insert.run(1, 'https://amazon.com/dp/A', 0, 'new');
    insert.run(1, 'https://amazon.com/dp/B', 1, 'warehouse');
    insert.run(1, 'https://amazon.com/dp/C', 2, 'refurb');
    insert.run(1, 'https://amazon.com/dp/D', 3, 'open_box');
    const conditions = (db.prepare(
      `SELECT condition FROM tracker_urls WHERE tracker_id = 1 ORDER BY position`,
    ).all() as Array<{ condition: string }>).map(r => r.condition);
    expect(conditions).toEqual(['new', 'warehouse', 'refurb', 'open_box']);
  });

  it('migration is idempotent - running schema init twice does not throw', () => {
    initializeSchema();
    expect(() => initializeSchema()).not.toThrow();

    const db = getDb();
    db.prepare(`DELETE FROM schema_migrations WHERE version = 14`).run();
    expect(() => initializeSchema()).not.toThrow();
    const cols = (db.prepare(`PRAGMA table_info(tracker_urls)`).all() as Array<{ name: string }>)
      .filter(c => c.name === 'condition');
    expect(cols).toHaveLength(1);
  });

  it('runs successfully against a pre-v14 DB shape (no condition column)', () => {
    const db = getDb();
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
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
      CREATE TABLE trackers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, url TEXT NOT NULL,
        normalized_url TEXT,
        threshold_price REAL,
        check_interval_minutes INTEGER NOT NULL DEFAULT 360,
        jitter_minutes INTEGER NOT NULL DEFAULT 0,
        css_selector TEXT,
        last_price REAL, last_checked_at TEXT, last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        user_id INTEGER
      );
      CREATE TABLE tracker_urls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        last_price REAL, last_checked_at TEXT, last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        pending_confirmation_price REAL,
        pending_confirmation_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    for (let v = 1; v <= 13; v++) {
      db.prepare(`INSERT INTO schema_migrations (version) VALUES (?)`).run(v);
    }
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@x.com','h','A')`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id) VALUES ('T','https://x', 1)`).run();
    db.prepare(`INSERT INTO tracker_urls (tracker_id, url) VALUES (1, 'https://x')`).run();

    initializeSchema();
    const row = db.prepare(`SELECT condition FROM tracker_urls WHERE tracker_id = 1`)
      .get() as { condition: string };
    expect(row.condition).toBe('new');

    const cols = (db.prepare(`PRAGMA table_info(tracker_urls)`).all() as Array<{ name: string }>)
      .map(c => c.name);
    expect(cols).toContain('condition');
  });
});
