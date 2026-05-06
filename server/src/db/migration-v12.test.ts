import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
});

describe('migration v12 — user_api_tokens', () => {
  it('creates the table with expected columns', () => {
    initializeSchema();
    const cols = getDb().prepare(`PRAGMA table_info(user_api_tokens)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      'created_at', 'id', 'last_used_at', 'name', 'prefix',
      'revoked_at', 'token_hash', 'user_id',
    ]);
  });

  it('enforces token_hash uniqueness', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO user_api_tokens (user_id, name, token_hash, prefix, created_at)
                VALUES (1, 'one', 'deadbeef', 'pt_aaaa', ?)`).run(Date.now());
    expect(() => db.prepare(`INSERT INTO user_api_tokens (user_id, name, token_hash, prefix, created_at)
                             VALUES (1, 'two', 'deadbeef', 'pt_bbbb', ?)`).run(Date.now())
    ).toThrow(/UNIQUE/);
  });

  it('cascades delete when the user is removed', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO user_api_tokens (user_id, name, token_hash, prefix, created_at)
                VALUES (1, 'one', 'h1', 'pt_aaaa', ?)`).run(Date.now());
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM users WHERE id = 1').run();
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM user_api_tokens').get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('migration is idempotent (running schema init twice does not throw)', () => {
    initializeSchema();
    expect(() => initializeSchema()).not.toThrow();
  });
});
