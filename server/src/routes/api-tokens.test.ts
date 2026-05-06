import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { authMiddleware } from '../auth/middleware.js';
import { createUserApiToken } from '../db/queries.js';
import apiTokenRoutes from './api-tokens.js';
import { signAccessToken } from '../auth/tokens.js';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/settings/api-tokens', authMiddleware, apiTokenRoutes);
  return app;
}

function seedUser(email: string): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function authCookie(userId: number, role: 'user' | 'admin' = 'user'): string {
  const token = signAccessToken({ userId, email: 'x@x.com', role });
  return `access_token=${token}`;
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('POST /api/settings/api-tokens', () => {
  it('creates a token and returns plaintext exactly once', async () => {
    const u = seedUser('a@x.com');
    const res = await request(makeApp())
      .post('/api/settings/api-tokens')
      .set('Cookie', authCookie(u))
      .send({ name: 'My Mac' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Mac');
    expect(res.body.token).toMatch(/^pt_[A-Za-z0-9_-]{43}$/);
    expect(res.body.prefix).toBe(res.body.token.slice(0, 8));
  });

  it('rejects empty name with 400', async () => {
    const u = seedUser('a@x.com');
    const res = await request(makeApp())
      .post('/api/settings/api-tokens')
      .set('Cookie', authCookie(u))
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(makeApp())
      .post('/api/settings/api-tokens')
      .send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/settings/api-tokens', () => {
  it('returns this user\'s tokens (no plaintext, no hash)', async () => {
    const u = seedUser('a@x.com');
    createUserApiToken(u, 'one');
    createUserApiToken(u, 'two');
    const res = await request(makeApp())
      .get('/api/settings/api-tokens')
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].token).toBeUndefined();
    expect(res.body[0].token_hash).toBeUndefined();
    expect(res.body[0].prefix).toMatch(/^pt_/);
  });

  it('does not leak other users\' tokens', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    createUserApiToken(u1, 'mine');
    createUserApiToken(u2, 'theirs');
    const res = await request(makeApp())
      .get('/api/settings/api-tokens')
      .set('Cookie', authCookie(u1));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('mine');
  });
});

describe('DELETE /api/settings/api-tokens/:id', () => {
  it('revokes the user\'s own token', async () => {
    const u = seedUser('a@x.com');
    const t = createUserApiToken(u, 'M');
    const res = await request(makeApp())
      .delete(`/api/settings/api-tokens/${t.id}`)
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(204);
  });

  it('returns 404 when revoking another user\'s token (no existence leak)', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = createUserApiToken(u1, 'M');
    const res = await request(makeApp())
      .delete(`/api/settings/api-tokens/${t.id}`)
      .set('Cookie', authCookie(u2));
    expect(res.status).toBe(404);
  });
});
