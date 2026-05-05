import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Integration test for migration v9 — creates projects, project_trackers,
 * and project_notifications tables. Builds a pre-v9 DB shape by hand to
 * force the migration to run against "upgrading from v8" state.
 */

const PRE_V9_DDL = [
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
];

function buildPreV9Schema(db: Database.Database): void {
  for (const stmt of PRE_V9_DDL) {
    db.prepare(stmt).run();
  }
}

describe('migration v9 — projects, project_trackers, project_notifications', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    buildPreV9Schema(db);
  });

  it('creates projects table with expected columns', () => {
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    for (const expected of ['id', 'user_id', 'name', 'target_total', 'status', 'created_at', 'updated_at']) {
      expect(names).toContain(expected);
    }
  });

  it('creates project_trackers join table with composite primary key', () => {
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(project_trackers)").all() as { name: string; pk: number }[];
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pkCols).toEqual(['project_id', 'tracker_id']);
  });

  it('creates project_notifications table with expected columns', () => {
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(project_notifications)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    for (const expected of ['id', 'project_id', 'channel', 'basket_total', 'target_total', 'ai_commentary', 'sent_at']) {
      expect(names).toContain(expected);
    }
  });

  it('creates the reverse-direction index on project_trackers(tracker_id)', () => {
    runMigrations();
    const indexes = getDb().prepare("PRAGMA index_list(project_trackers)").all() as { name: string }[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_project_trackers_tracker_id');
  });

  it('creates the per-channel cooldown lookup index on project_notifications', () => {
    runMigrations();
    const indexes = getDb().prepare("PRAGMA index_list(project_notifications)").all() as { name: string }[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_project_notifications_project_channel');
  });

  it('migration v9 is idempotent', () => {
    runMigrations();
    runMigrations();
    const projectsCols = getDb().prepare("PRAGMA table_info(projects)").all();
    expect(projectsCols).toHaveLength(7);
  });

  it('cascades delete: deleting a project removes its project_trackers + project_notifications', () => {
    runMigrations();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(`INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes) VALUES ('T','https://x',?,100,'active',60,0)`).run(userId);
    const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get('T') as { id: number }).id;
    db.prepare(`INSERT INTO projects (user_id, name, target_total) VALUES (?, 'P', 100)`).run(userId);
    const projectId = (db.prepare('SELECT id FROM projects WHERE name=?').get('P') as { id: number }).id;
    db.prepare(`INSERT INTO project_trackers (project_id, tracker_id) VALUES (?, ?)`).run(projectId, trackerId);
    db.prepare(`INSERT INTO project_notifications (project_id, channel, basket_total, target_total) VALUES (?, 'discord', 80, 100)`).run(projectId);

    db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);

    expect((db.prepare('SELECT COUNT(*) as c FROM project_trackers WHERE project_id=?').get(projectId) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as c FROM project_notifications WHERE project_id=?').get(projectId) as { c: number }).c).toBe(0);
  });
});
