import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { authMiddleware } from '../auth/middleware.js';
import { createTracker } from '../db/queries.js';
import trackerRoutes from './trackers.js';
import { signAccessToken } from '../auth/tokens.js';

/**
 * GET /api/trackers/match — the share-target dedup lookup (phase 2).
 * The interesting behavior is normalization equivalence (tracking params,
 * case, trailing slash) and per-user scoping.
 */

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/trackers', authMiddleware, trackerRoutes);
  return app;
}

function seedUser(email: string): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function authCookie(userId: number): string {
  const token = signAccessToken({ userId, email: 'x@x.com', role: 'user' });
  return `access_token=${token}`;
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('GET /api/trackers/match', () => {
  it('matches a URL variant of an existing tracker (tracking params stripped)', async () => {
    const u = seedUser('a@x.com');
    const t = createTracker({
      name: 'Widget',
      url: 'https://www.amazon.com/dp/B0TEST123',
      threshold_price: null,
      user_id: u,
    });

    const res = await request(makeApp())
      .get('/api/trackers/match')
      .query({ url: 'https://amazon.com/dp/B0TEST123/?tag=aff-20&utm_source=share' })
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(200);
    expect(res.body.tracker_id).toBe(t.id);
  });

  it('returns null for an untracked product and for unparseable input', async () => {
    const u = seedUser('a@x.com');
    const app = makeApp();

    const miss = await request(app)
      .get('/api/trackers/match')
      .query({ url: 'https://newegg.com/p/NOPE' })
      .set('Cookie', authCookie(u));
    expect(miss.body.tracker_id).toBeNull();

    const garbage = await request(app)
      .get('/api/trackers/match')
      .query({ url: 'not a url' })
      .set('Cookie', authCookie(u));
    expect(garbage.status).toBe(200);
    expect(garbage.body.tracker_id).toBeNull();
  });

  it("never matches another user's tracker", async () => {
    const owner = seedUser('owner@x.com');
    const other = seedUser('other@x.com');
    createTracker({
      name: 'Widget',
      url: 'https://amazon.com/dp/B0TEST123',
      threshold_price: null,
      user_id: owner,
    });

    const res = await request(makeApp())
      .get('/api/trackers/match')
      .query({ url: 'https://amazon.com/dp/B0TEST123' })
      .set('Cookie', authCookie(other));
    expect(res.body.tracker_id).toBeNull();
  });

  it('400s without a url param', async () => {
    const u = seedUser('a@x.com');
    const res = await request(makeApp())
      .get('/api/trackers/match')
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(400);
  });
});
