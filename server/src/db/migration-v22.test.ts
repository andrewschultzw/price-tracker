import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Migration v22 — notification read-state.
 *
 *   ALTER TABLE notifications ADD COLUMN read_at TEXT
 *   UPDATE notifications SET read_at = datetime('now')   -- backfill
 *
 * Pre-migration rows are backfilled as READ so the unread badge doesn't
 * light up with a user's entire alert history on upgrade. New rows insert
 * with read_at NULL (unread) — the badge counts those.
 */

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
});

function seedUserAndTracker(): number {
  const userId = Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('u@example.com', 'h', 'U', 'user', 1)`,
  ).run().lastInsertRowid);
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes)
     VALUES ('T', 'https://example.com/x', ?, 'active', 60)`,
  ).run(userId).lastInsertRowid);
}

describe('migration v22 — notification read-state', () => {
  it('adds read_at to notifications', () => {
    initializeSchema();
    const cols = (getDb()
      .prepare('PRAGMA table_info(notifications)')
      .all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('read_at');
  });

  it('new notification rows default to unread (read_at NULL)', () => {
    initializeSchema();
    const trackerId = seedUserAndTracker();
    getDb().prepare(
      `INSERT INTO notifications (tracker_id, price, threshold_price) VALUES (?, 40, 50)`,
    ).run(trackerId);
    const row = getDb().prepare('SELECT read_at FROM notifications').get() as { read_at: string | null };
    expect(row.read_at).toBeNull();
  });

  it('backfills pre-migration rows as read on upgrade', () => {
    // Start from the fully-migrated schema, then rewind JUST v22: drop the
    // column and forget the migration ran. Re-running initializeSchema() then
    // replays v22 against realistic pre-v22 rows.
    initializeSchema();
    const trackerId = seedUserAndTracker();
    const db = getDb();
    db.exec('ALTER TABLE notifications DROP COLUMN read_at');
    db.prepare('DELETE FROM schema_migrations WHERE version = 22').run();
    db.prepare(
      `INSERT INTO notifications (tracker_id, price, threshold_price) VALUES (?, 40, 50)`,
    ).run(trackerId);
    db.prepare(
      `INSERT INTO notifications (tracker_id, price, threshold_price) VALUES (?, 45, 50)`,
    ).run(trackerId);

    initializeSchema(); // replays v22

    const rows = getDb().prepare('SELECT read_at FROM notifications').all() as { read_at: string | null }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.read_at).not.toBeNull();
  });
});
