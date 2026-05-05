import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Integration test for migration v10 — creates web_push_subscriptions table.
 * Builds a pre-v10 DB shape by hand to force the migration to run against
 * "upgrading from v9" state.
 */

const PRE_V10_DDL = [
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
    normalized_url TEXT,
    pending_confirmation_price REAL,
    pending_confirmation_at TEXT,
    ai_verdict_tier TEXT,
    ai_verdict_reason TEXT,
    ai_verdict_reason_key TEXT,
    ai_verdict_updated_at INTEGER,
    ai_summary TEXT,
    ai_summary_updated_at INTEGER,
    ai_signals_json TEXT,
    ai_failure_count INTEGER NOT NULL DEFAULT 0
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
  `CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_total REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE project_trackers (
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    per_item_ceiling REAL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, tracker_id)
  )`,
  `CREATE TABLE project_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('discord', 'ntfy', 'webhook', 'email')),
    basket_total REAL NOT NULL,
    target_total REAL NOT NULL,
    ai_commentary TEXT,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
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
  `INSERT INTO schema_migrations (version) VALUES (8)`,
  `INSERT INTO schema_migrations (version) VALUES (9)`,
];

function buildPreV10Schema(db: Database.Database): void {
  for (const stmt of PRE_V10_DDL) {
    db.prepare(stmt).run();
  }
}

describe('migration v10 — web_push_subscriptions', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    buildPreV10Schema(db);
  });

  it('creates web_push_subscriptions table with expected columns', () => {
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(web_push_subscriptions)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    for (const expected of ['id', 'user_id', 'endpoint', 'p256dh_key', 'auth_key', 'device_label', 'user_agent', 'created_at', 'last_used_at']) {
      expect(names).toContain(expected);
    }
  });

  it('endpoint has UNIQUE constraint', () => {
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(`INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (?, 'E', 'P', 'A')`).run(userId);
    expect(() =>
      db.prepare(`INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (?, 'E', 'P', 'A')`).run(userId)
    ).toThrow();
  });

  it('user_id index is created', () => {
    runMigrations();
    const indexes = getDb().prepare("PRAGMA index_list(web_push_subscriptions)").all() as { name: string }[];
    expect(indexes.map(i => i.name)).toContain('idx_web_push_subscriptions_user_id');
  });

  it('migration v10 is idempotent', () => {
    runMigrations();
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(web_push_subscriptions)").all();
    expect(cols).toHaveLength(9);
  });

  it('CASCADE deletes web_push_subscriptions when the user is deleted', () => {
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(`INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (?, 'E', 'P', 'A')`).run(userId);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    const count = (db.prepare('SELECT COUNT(*) as c FROM web_push_subscriptions WHERE user_id=?').get(userId) as { c: number }).c;
    expect(count).toBe(0);
  });
});
