import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
});

function seedTracker(): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
  ).run();
  return Number(db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes)
     VALUES ('T', 'https://amazon.com/dp/B000000000', 1, 100, 60, 0)`,
  ).run().lastInsertRowid);
}

describe('migration v19 — buy-arm columns + purchase_intents', () => {
  it('adds buy_armed and buy_quantity with safe defaults', () => {
    initializeSchema();
    const tId = seedTracker();
    const row = getDb().prepare(
      'SELECT buy_armed, buy_quantity FROM trackers WHERE id = ?',
    ).get(tId) as { buy_armed: number; buy_quantity: number };
    expect(row).toEqual({ buy_armed: 0, buy_quantity: 1 });
  });

  it('creates purchase_intents and accepts a valid armed row', () => {
    initializeSchema();
    const tId = seedTracker();
    expect(() => {
      getDb().prepare(
        `INSERT INTO purchase_intents
           (tracker_id, asin, price_at_arm, threshold_at_arm, quantity, token, status, expires_at)
         VALUES (?, 'B000000000', 79.99, 100, 1, 'tok123', 'armed', '2026-06-01 00:00:00')`,
      ).run(tId);
    }).not.toThrow();
    const intent = getDb().prepare(
      `SELECT status, asin FROM purchase_intents WHERE tracker_id = ?`,
    ).get(tId) as { status: string; asin: string };
    expect(intent).toEqual({ status: 'armed', asin: 'B000000000' });
  });

  it('rejects an unknown intent status via the CHECK', () => {
    initializeSchema();
    const tId = seedTracker();
    expect(() => {
      getDb().prepare(
        `INSERT INTO purchase_intents
           (tracker_id, asin, price_at_arm, threshold_at_arm, quantity, token, status, expires_at)
         VALUES (?, 'B000000000', 79.99, 100, 1, 'tok456', 'bogus', '2026-06-01 00:00:00')`,
      ).run(tId);
    }).toThrow();
  });

  it('enforces a unique token', () => {
    initializeSchema();
    const tId = seedTracker();
    const ins = (tok: string) => getDb().prepare(
      `INSERT INTO purchase_intents
         (tracker_id, asin, price_at_arm, threshold_at_arm, quantity, token, status, expires_at)
       VALUES (?, 'B000000000', 79.99, 100, 1, ?, 'armed', '2026-06-01 00:00:00')`,
    ).run(tId, tok);
    ins('dup');
    expect(() => ins('dup')).toThrow();
  });
});
