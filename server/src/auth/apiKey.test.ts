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
