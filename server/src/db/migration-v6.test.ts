import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Integration test for migration v6 — adds normalized_url column and
 * backfills existing trackers. Builds a pre-v6 DB shape by hand to
 * force the migration to run against "upgrading from v5" state.
 */

const PRE_V6_DDL = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE trackers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    threshold_price REAL,
    check_interval_minutes INTEGER NOT NULL DEFAULT 360,
    jitter_minutes INTEGER NOT NULL DEFAULT 0,
    css_selector TEXT,
    last_price REAL,
    last_checked_at TEXT,
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER
  )`,
  `CREATE TABLE tracker_urls (
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
  )`,
  `CREATE TABLE price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
    price REAL NOT NULL,
    threshold_price REAL NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    channel TEXT
  )`,
  `CREATE TABLE settings (
    user_id INTEGER,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `INSERT INTO schema_migrations (version) VALUES (1)`,
  `INSERT INTO schema_migrations (version) VALUES (2)`,
  `INSERT INTO schema_migrations (version) VALUES (3)`,
  `INSERT INTO schema_migrations (version) VALUES (4)`,
  `INSERT INTO schema_migrations (version) VALUES (5)`,
];

function buildPreV6Schema(db: Database.Database): void {
  for (const stmt of PRE_V6_DDL) {
    db.prepare(stmt).run();
  }
}

describe('migration v6 — normalized_url column + backfill', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    buildPreV6Schema(db);
  });

  it('adds the normalized_url column and the index', () => {
    runMigrations();
    const cols = (getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toContain('normalized_url');
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trackers'")
      .all() as { name: string }[];
    expect(indexes.map(i => i.name)).toContain('idx_trackers_normalized_url');
  });

  it('backfills normalized_url for existing trackers', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'x', 'A')`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id) VALUES ('T1', 'https://smile.amazon.com/dp/B0XYZ?tag=foo', 1)`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id) VALUES ('T2', 'https://newegg.com/p/N82E123?Item=N82E123', 1)`).run();

    runMigrations();

    const rows = db.prepare('SELECT id, url, normalized_url FROM trackers ORDER BY id').all() as { id: number; url: string; normalized_url: string | null }[];
    expect(rows[0].normalized_url).toBe('amazon.com/dp/b0xyz');
    expect(rows[1].normalized_url).toBe('newegg.com/p/n82e123?Item=N82E123');
  });

  it('leaves malformed URLs with null normalized_url and does not crash', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'x', 'A')`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id) VALUES ('bad', 'not-a-url', 1)`).run();

    runMigrations();

    const row = db.prepare('SELECT normalized_url FROM trackers WHERE name = ?').get('bad') as { normalized_url: string | null };
    expect(row.normalized_url).toBeNull();
  });

  it('re-running migrations is a no-op (idempotent)', () => {
    runMigrations();
    runMigrations();
    const cols = (getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string }[])
      .map(c => c.name);
    const normalizedCols = cols.filter(c => c === 'normalized_url');
    expect(normalizedCols).toHaveLength(1);
  });
});
