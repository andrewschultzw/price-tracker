import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Migration v14 — adds three nullable doorbuster columns to `trackers`:
 *   doorbuster_start_at TEXT
 *   doorbuster_end_at TEXT
 *   doorbuster_interval_minutes INTEGER CHECK (>= 1 OR NULL)
 *
 * Every existing tracker keeps doorbuster OFF (NULL). The CHECK constraint
 * on doorbuster_interval_minutes only fires when the value is non-NULL.
 */

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
});

describe('migration v14 — doorbuster columns on trackers', () => {
  it('adds the three doorbuster columns to trackers', () => {
    initializeSchema();
    const cols = (getDb()
      .prepare("PRAGMA table_info(trackers)")
      .all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('doorbuster_start_at');
    expect(cols).toContain('doorbuster_end_at');
    expect(cols).toContain('doorbuster_interval_minutes');
  });

  it('defaults all three columns to NULL on a fresh tracker', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'h', 'A')`).run();
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
       VALUES ('T','https://x', 1, 'active', 60, 0)`,
    ).run();
    const row = db.prepare(
      'SELECT doorbuster_start_at, doorbuster_end_at, doorbuster_interval_minutes FROM trackers WHERE name = ?',
    ).get('T') as {
      doorbuster_start_at: string | null;
      doorbuster_end_at: string | null;
      doorbuster_interval_minutes: number | null;
    };
    expect(row.doorbuster_start_at).toBeNull();
    expect(row.doorbuster_end_at).toBeNull();
    expect(row.doorbuster_interval_minutes).toBeNull();
  });

  it('enforces doorbuster_interval_minutes >= 1 when set (CHECK constraint)', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'h', 'A')`).run();
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
       VALUES ('T','https://x', 1, 'active', 60, 0)`,
    ).run();
    expect(() =>
      db.prepare(
        `UPDATE trackers SET doorbuster_interval_minutes = 0 WHERE name = ?`,
      ).run('T'),
    ).toThrow(/CHECK constraint/);
    expect(() =>
      db.prepare(
        `UPDATE trackers SET doorbuster_interval_minutes = -3 WHERE name = ?`,
      ).run('T'),
    ).toThrow(/CHECK constraint/);
  });

  it('allows valid doorbuster values (interval 3, ISO timestamps)', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'h', 'A')`).run();
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
       VALUES ('T','https://x', 1, 'active', 60, 0)`,
    ).run();
    db.prepare(
      `UPDATE trackers
       SET doorbuster_start_at = '2026-11-28T00:00:00Z',
           doorbuster_end_at   = '2026-11-28T20:00:00Z',
           doorbuster_interval_minutes = 3
       WHERE name = ?`,
    ).run('T');
    const row = db.prepare('SELECT * FROM trackers WHERE name = ?').get('T') as {
      doorbuster_start_at: string;
      doorbuster_end_at: string;
      doorbuster_interval_minutes: number;
    };
    expect(row.doorbuster_start_at).toBe('2026-11-28T00:00:00Z');
    expect(row.doorbuster_end_at).toBe('2026-11-28T20:00:00Z');
    expect(row.doorbuster_interval_minutes).toBe(3);
  });

  it('migration is idempotent — running again does not duplicate columns or throw', () => {
    initializeSchema();
    runMigrations();
    runMigrations();
    const cols = (getDb()
      .prepare("PRAGMA table_info(trackers)")
      .all() as { name: string }[]).map(c => c.name);
    const matches = cols.filter(c => c.startsWith('doorbuster_'));
    expect(matches).toHaveLength(3);
  });
});
