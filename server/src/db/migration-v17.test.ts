import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Migration v17 — widen the status CHECK constraint on both
 * trackers and tracker_urls to admit a new 'blocked' value.
 *
 * Asserts:
 *  - Existing rows survive the rebuild with all column values intact.
 *  - 'blocked' is now accepted by INSERT on both tables.
 *  - 'banana' (or any other made-up value) still rejected — the CHECK
 *    is still enforced, just with a wider whitelist.
 */

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
});

describe('migration v17 — add blocked status', () => {
  it("admits 'blocked' as a valid tracker_urls.status", () => {
    initializeSchema();
    const db = getDb();
    // Seed a tracker so we have a valid tracker_id to reference.
    db.prepare(
      `INSERT INTO users (email, password_hash, display_name, role, is_active)
       VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
    ).run();
    const tId = Number(db.prepare(
      `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes)
       VALUES ('T', 'https://x.example/p', 1, 100, 60, 0)`,
    ).run().lastInsertRowid);

    // The position=0 row was auto-created by NULL — actually no,
    // schema.ts doesn't auto-create — so insert manually with the
    // new value.
    expect(() => {
      db.prepare(
        `INSERT INTO tracker_urls (tracker_id, url, position, status, last_error)
         VALUES (?, ?, 0, 'blocked', 'WAF block')`,
      ).run(tId, 'https://homedepot.com/p/x/123');
    }).not.toThrow();

    const row = db.prepare(
      'SELECT status, last_error FROM tracker_urls WHERE tracker_id = ?',
    ).get(tId) as { status: string; last_error: string };
    expect(row.status).toBe('blocked');
    expect(row.last_error).toBe('WAF block');
  });

  it("admits 'blocked' as a valid trackers.status", () => {
    initializeSchema();
    const db = getDb();
    db.prepare(
      `INSERT INTO users (email, password_hash, display_name, role, is_active)
       VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
    ).run();
    expect(() => {
      db.prepare(
        `INSERT INTO trackers (name, url, status, user_id, threshold_price, check_interval_minutes, jitter_minutes)
         VALUES ('T', 'https://x.example/p', 'blocked', 1, 100, 60, 0)`,
      ).run();
    }).not.toThrow();
  });

  it('still rejects unknown status values on both tables', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(
      `INSERT INTO users (email, password_hash, display_name, role, is_active)
       VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
    ).run();
    const tId = Number(db.prepare(
      `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes)
       VALUES ('T', 'https://x.example/p', 1, 100, 60, 0)`,
    ).run().lastInsertRowid);
    expect(() => {
      db.prepare(
        `INSERT INTO tracker_urls (tracker_id, url, position, status)
         VALUES (?, 'https://x.example/p', 0, 'banana')`,
      ).run(tId);
    }).toThrow(/CHECK constraint/i);
    expect(() => {
      db.prepare(
        `INSERT INTO trackers (name, url, status, user_id, threshold_price, check_interval_minutes, jitter_minutes)
         VALUES ('T2', 'https://x.example/p2', 'banana', 1, 100, 60, 0)`,
      ).run();
    }).toThrow(/CHECK constraint/i);
  });

  it('preserves existing rows through the rebuild', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(
      `INSERT INTO users (email, password_hash, display_name, role, is_active)
       VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
    ).run();
    const tId = Number(db.prepare(
      `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes, last_price)
       VALUES ('T', 'https://x.example/p', 1, 50, 30, 5, 42.50)`,
    ).run().lastInsertRowid);
    db.prepare(
      `INSERT INTO tracker_urls (tracker_id, url, position, last_price, status)
       VALUES (?, 'https://x.example/p', 0, 42.50, 'active')`,
    ).run(tId);

    // initializeSchema() already applied the migration at setup. Verify
    // the seeded rows survived intact (regression guard against the
    // table rename + copy dropping data).
    const tracker = db.prepare('SELECT name, threshold_price, last_price FROM trackers WHERE id = ?').get(tId) as { name: string; threshold_price: number; last_price: number };
    expect(tracker).toEqual({ name: 'T', threshold_price: 50, last_price: 42.50 });
    const sellers = db.prepare('SELECT url, status, last_price FROM tracker_urls WHERE tracker_id = ?').all(tId) as Array<{ url: string; status: string; last_price: number }>;
    expect(sellers).toHaveLength(1);
    expect(sellers[0]).toEqual({ url: 'https://x.example/p', status: 'active', last_price: 42.50 });
  });
});
