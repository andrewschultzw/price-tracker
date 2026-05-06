import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import {
  createUserApiToken, listUserApiTokensForUser,
  findActiveTokenByHash, revokeUserApiToken, touchTokenLastUsed,
} from './queries.js';

function seedUser(email = 'a@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function hashFor(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('createUserApiToken', () => {
  it('returns plaintext + persists SHA-256 hash + prefix', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'My Mac');
    expect(t.token).toMatch(/^pt_[A-Za-z0-9_-]{43}$/);
    expect(t.prefix).toBe(t.token.slice(0, 8));
    const row = getDb().prepare('SELECT token_hash FROM user_api_tokens WHERE id = ?').get(t.id) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(t.token);
  });

  it('two tokens for the same user have different plaintext', () => {
    const u = seedUser();
    const a = createUserApiToken(u, 'A');
    const b = createUserApiToken(u, 'B');
    expect(a.token).not.toBe(b.token);
  });
});

describe('findActiveTokenByHash', () => {
  it('returns row when hash matches and not revoked', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    expect(findActiveTokenByHash(hashFor(t.token))?.user_id).toBe(u);
  });

  it('returns null when revoked', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    revokeUserApiToken(t.id, u);
    expect(findActiveTokenByHash(hashFor(t.token))).toBeNull();
  });

  it('returns null when hash does not match', () => {
    expect(findActiveTokenByHash('a'.repeat(64))).toBeNull();
  });
});

describe('listUserApiTokensForUser', () => {
  it('returns only that user\'s tokens, never plaintext or hash', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    createUserApiToken(u1, 'mine');
    createUserApiToken(u2, 'theirs');
    const out = listUserApiTokensForUser(u1);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('mine');
    expect((out[0] as Record<string, unknown>).token_hash).toBeUndefined();
    expect((out[0] as Record<string, unknown>).token).toBeUndefined();
  });
});

describe('revokeUserApiToken', () => {
  it('marks revoked_at on a token belonging to the user', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    expect(revokeUserApiToken(t.id, u)).toBe(true);
    const row = getDb().prepare('SELECT revoked_at FROM user_api_tokens WHERE id = ?').get(t.id) as { revoked_at: number | null };
    expect(row.revoked_at).toBeGreaterThan(0);
  });

  it('returns false when token belongs to another user', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = createUserApiToken(u1, 'M');
    expect(revokeUserApiToken(t.id, u2)).toBe(false);
  });
});

describe('touchTokenLastUsed', () => {
  it('updates last_used_at to now', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    touchTokenLastUsed(t.id);
    const row = getDb().prepare('SELECT last_used_at FROM user_api_tokens WHERE id = ?').get(t.id) as { last_used_at: number };
    expect(row.last_used_at).toBeGreaterThan(0);
  });
});
