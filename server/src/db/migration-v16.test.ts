import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Migration v16 — wishlist / gift mode.
 *
 *   ALTER TABLE users   ADD COLUMN wishlist_share_token TEXT (+ unique partial index)
 *   ALTER TABLE trackers ADD COLUMN is_wishlisted INTEGER NOT NULL DEFAULT 0
 *   CREATE TABLE wishlist_claims (id, tracker_id, claim_token UNIQUE, claimed_at)
 *
 * Defaults preserve existing behavior — every user starts with a NULL share
 * token (no wishlist link), every tracker starts with is_wishlisted=0.
 */

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
});

describe('migration v16 — wishlist / gift mode', () => {
  it('adds wishlist_share_token to users and is_wishlisted to trackers', () => {
    initializeSchema();
    const userCols = (getDb()
      .prepare("PRAGMA table_info(users)")
      .all() as { name: string }[]).map(c => c.name);
    expect(userCols).toContain('wishlist_share_token');

    const trackerCols = (getDb()
      .prepare("PRAGMA table_info(trackers)")
      .all() as { name: string }[]).map(c => c.name);
    expect(trackerCols).toContain('is_wishlisted');
  });

  it('creates the wishlist_claims table with the expected columns', () => {
    initializeSchema();
    const cols = (getDb()
      .prepare("PRAGMA table_info(wishlist_claims)")
      .all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(
      expect.arrayContaining(['id', 'tracker_id', 'claim_token', 'claimed_at']),
    );
  });

  it('creates the unique partial index on users.wishlist_share_token', () => {
    initializeSchema();
    const indexes = getDb()
      .prepare("PRAGMA index_list(users)")
      .all() as { name: string; unique: number }[];
    const ours = indexes.find(i => i.name === 'idx_users_wishlist_share_token');
    expect(ours).toBeDefined();
    expect(ours!.unique).toBe(1);
  });

  it('defaults is_wishlisted to 0 on a fresh tracker', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'h', 'A')`).run();
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
       VALUES ('T','https://x', 1, 'active', 60, 0)`,
    ).run();
    const row = db.prepare('SELECT is_wishlisted FROM trackers WHERE name = ?').get('T') as { is_wishlisted: number };
    expect(row.is_wishlisted).toBe(0);
  });

  it('partial unique index allows multiple NULL share tokens but blocks duplicates', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@x.com', 'h', 'A')`).run();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('b@x.com', 'h', 'B')`).run();
    // Both default to NULL — should not violate unique constraint
    expect(() =>
      db.prepare(`UPDATE users SET wishlist_share_token = ? WHERE email = ?`).run('wl_dup', 'a@x.com'),
    ).not.toThrow();
    expect(() =>
      db.prepare(`UPDATE users SET wishlist_share_token = ? WHERE email = ?`).run('wl_dup', 'b@x.com'),
    ).toThrow(/UNIQUE/);
  });

  it('wishlist_claims.claim_token is UNIQUE', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'h', 'A')`).run();
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
       VALUES ('T','https://x', 1, 'active', 60, 0)`,
    ).run();
    const trackerId = (db.prepare('SELECT id FROM trackers WHERE name = ?').get('T') as { id: number }).id;
    db.prepare(
      `INSERT INTO wishlist_claims (tracker_id, claim_token, claimed_at) VALUES (?, ?, ?)`,
    ).run(trackerId, 'wc_unique', Date.now());
    expect(() =>
      db.prepare(
        `INSERT INTO wishlist_claims (tracker_id, claim_token, claimed_at) VALUES (?, ?, ?)`,
      ).run(trackerId, 'wc_unique', Date.now()),
    ).toThrow(/UNIQUE/);
  });

  it('wishlist_claims rows cascade-delete when their tracker is deleted', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'h', 'A')`).run();
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
       VALUES ('T','https://x', 1, 'active', 60, 0)`,
    ).run();
    const trackerId = (db.prepare('SELECT id FROM trackers WHERE name = ?').get('T') as { id: number }).id;
    db.prepare(
      `INSERT INTO wishlist_claims (tracker_id, claim_token, claimed_at) VALUES (?, ?, ?)`,
    ).run(trackerId, 'wc_x', Date.now());
    db.prepare(`DELETE FROM trackers WHERE id = ?`).run(trackerId);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM wishlist_claims').get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('migration is idempotent — running again does not duplicate columns or throw', () => {
    initializeSchema();
    runMigrations();
    runMigrations();
    const trackerCols = (getDb()
      .prepare("PRAGMA table_info(trackers)")
      .all() as { name: string }[]).map(c => c.name);
    const matches = trackerCols.filter(c => c === 'is_wishlisted');
    expect(matches).toHaveLength(1);
  });
});
