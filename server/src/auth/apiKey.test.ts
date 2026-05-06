import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { apiKeyMiddleware } from './apiKey.js';
import { createUserApiToken } from '../db/queries.js';

function seedUser(email = 'a@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function makeApp(): express.Express {
  const app = express();
  app.use(apiKeyMiddleware, (req, res) => {
    res.json({ userId: req.user?.userId ?? null });
  });
  return app;
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
  delete process.env.PRICE_TRACKER_API_KEY;
  delete process.env.PRICE_TRACKER_API_KEY_USER_ID;
});

describe('apiKeyMiddleware — user tokens', () => {
  it('valid user token → req.user set', async () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    const res = await request(makeApp()).get('/').set('X-API-Key', t.token);
    expect(res.body.userId).toBe(u);
  });

  it('updates last_used_at on success', async () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    await request(makeApp()).get('/').set('X-API-Key', t.token);
    const row = getDb().prepare('SELECT last_used_at FROM user_api_tokens WHERE id = ?').get(t.id) as { last_used_at: number | null };
    expect(row.last_used_at).not.toBeNull();
    expect(row.last_used_at!).toBeGreaterThan(Date.now() - 5000);
  });

  it('revoked token → 401', async () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    getDb().prepare('UPDATE user_api_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), t.id);
    const res = await request(makeApp()).get('/').set('X-API-Key', t.token);
    expect(res.status).toBe(401);
  });

  it('unknown token → 401', async () => {
    const res = await request(makeApp()).get('/').set('X-API-Key', 'pt_unknown' + 'x'.repeat(40));
    expect(res.status).toBe(401);
  });

  it('missing header → next() (delegates to JWT layer)', async () => {
    const res = await request(makeApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeNull();
  });
});

describe('apiKeyMiddleware — global PRICE_TRACKER_API_KEY', () => {
  beforeEach(() => {
    process.env.PRICE_TRACKER_API_KEY = 'test-api-key-123456';
    process.env.PRICE_TRACKER_API_KEY_USER_ID = String(seedUser('admin@x.com'));
  });

  it('matching global key → req.user set from PRICE_TRACKER_API_KEY_USER_ID', async () => {
    const expectedUserId = Number(process.env.PRICE_TRACKER_API_KEY_USER_ID);
    const res = await request(makeApp()).get('/').set('X-API-Key', 'test-api-key-123456');
    expect(res.body.userId).toBe(expectedUserId);
  });

  it('wrong global key → 401', async () => {
    const res = await request(makeApp()).get('/').set('X-API-Key', 'wrong-key-same-length');
    expect(res.status).toBe(401);
  });

  it('mismatched-length key → 401 without crashing', async () => {
    const res = await request(makeApp()).get('/').set('X-API-Key', 'short');
    expect(res.status).toBe(401);
  });

  it('global key matches but mapped user does not exist → 401', async () => {
    process.env.PRICE_TRACKER_API_KEY_USER_ID = '99999';
    const res = await request(makeApp()).get('/').set('X-API-Key', 'test-api-key-123456');
    expect(res.status).toBe(401);
  });

  it('empty header → next() without req.user (treated as absent)', async () => {
    const res = await request(makeApp()).get('/').set('X-API-Key', '');
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeNull();
  });
});

describe('apiKeyMiddleware when API key auth is not configured', () => {
  beforeEach(() => {
    delete process.env.PRICE_TRACKER_API_KEY;
    delete process.env.PRICE_TRACKER_API_KEY_USER_ID;
  });

  it('header set but no global key configured → still tries user-token branch (404 on miss)', async () => {
    // When PRICE_TRACKER_API_KEY is unset, isApiKeyConfigured() returns false,
    // so branch 1 is skipped. Branch 2 (user-token lookup) runs. Random header
    // value won't match any token → 401.
    const res = await request(makeApp()).get('/').set('X-API-Key', 'random-no-token-matches-this');
    expect(res.status).toBe(401);
  });
});
