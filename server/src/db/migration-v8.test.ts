import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Integration test for migration v8 — adds eight AI-related columns to trackers.
 * Builds a pre-v8 DB shape by hand to force the migration to run against
 * "upgrading from v7" state.
 */

const PRE_V8_DDL = [
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
    user_id INTEGER,
    normalized_url TEXT
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
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    pending_confirmation_price REAL,
    pending_confirmation_at TEXT
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
  `INSERT INTO schema_migrations (version) VALUES (6)`,
  `INSERT INTO schema_migrations (version) VALUES (7)`,
];

function buildPreV8Schema(db: Database.Database): void {
  for (const stmt of PRE_V8_DDL) {
    db.prepare(stmt).run();
  }
}

describe('migration v8 — AI columns on trackers', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    buildPreV8Schema(db);
  });

  it('adds all eight AI columns', () => {
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    for (const expected of [
      'ai_verdict_tier',
      'ai_verdict_reason',
      'ai_verdict_reason_key',
      'ai_verdict_updated_at',
      'ai_summary',
      'ai_summary_updated_at',
      'ai_signals_json',
      'ai_failure_count',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('adds ai_verdict_tier column with NULL default', () => {
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string; dflt_value: string | null }[];
    const tier = cols.find(c => c.name === 'ai_verdict_tier');
    expect(tier).toBeDefined();
    expect(tier!.dflt_value).toBeNull();
  });

  it('ai_failure_count defaults to 0', () => {
    runMigrations();
    const col = (getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string; dflt_value: string | null }[])
      .find(c => c.name === 'ai_failure_count');
    expect(col!.dflt_value).toBe('0');
  });

  it('migration v8 is idempotent', () => {
    runMigrations();
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
    const aiCols = cols.filter(c => c.name.startsWith('ai_'));
    expect(aiCols).toHaveLength(8);
  });
});
