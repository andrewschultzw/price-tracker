import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { authMiddleware } from '../auth/middleware.js';
import {
  createTracker,
  getUserByWishlistToken,
  setTrackerWishlistFlag,
  generateOrGetWishlistShareToken,
} from '../db/queries.js';
import wishlistRoutes from './wishlist.js';
import { signAccessToken } from '../auth/tokens.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/wishlist', authMiddleware, wishlistRoutes);
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
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('owner-side wishlist routes — auth required', () => {
  it('returns 401 on POST /share-token when unauthenticated', async () => {
    const res = await request(makeApp()).post('/api/wishlist/share-token').send({});
    expect(res.status).toBe(401);
  });

  it('returns 401 on GET /me when unauthenticated', async () => {
    const res = await request(makeApp()).get('/api/wishlist/me');
    expect(res.status).toBe(401);
  });

  it('returns 401 on PATCH /items/:id when unauthenticated', async () => {
    const res = await request(makeApp())
      .patch('/api/wishlist/items/1')
      .send({ is_wishlisted: true });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/wishlist/share-token', () => {
  it('returns a token + share_url; second call without rotate returns the same token', async () => {
    const u = seedUser('a@x.com');
    const r1 = await request(makeApp())
      .post('/api/wishlist/share-token')
      .set('Cookie', authCookie(u))
      .send({});
    expect(r1.status).toBe(200);
    expect(r1.body.token).toMatch(/^wl_[A-Za-z0-9_-]{32}$/);
    expect(r1.body.share_url).toMatch(/\/wishlist\/wl_[A-Za-z0-9_-]{32}$/);

    const r2 = await request(makeApp())
      .post('/api/wishlist/share-token')
      .set('Cookie', authCookie(u))
      .send({});
    expect(r2.body.token).toBe(r1.body.token);
  });

  it('with rotate=true returns a new token and the old token no longer resolves', async () => {
    const u = seedUser('a@x.com');
    const r1 = await request(makeApp())
      .post('/api/wishlist/share-token')
      .set('Cookie', authCookie(u))
      .send({});
    const oldToken = r1.body.token as string;

    const r2 = await request(makeApp())
      .post('/api/wishlist/share-token')
      .set('Cookie', authCookie(u))
      .send({ rotate: true });
    expect(r2.body.token).not.toBe(oldToken);
    expect(getUserByWishlistToken(oldToken)).toBeNull();
    expect(getUserByWishlistToken(r2.body.token)?.id).toBe(u);
  });
});

describe('GET /api/wishlist/me', () => {
  it('returns only wishlisted items with NO claim fields in response', async () => {
    const u = seedUser('a@x.com');
    const t1 = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    const t2 = createTracker({ name: 'B', url: 'https://x/2', user_id: u });
    setTrackerWishlistFlag(t1.id, u, true);
    // t2 NOT wishlisted; should not appear

    const res = await request(makeApp())
      .get('/api/wishlist/me')
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(t1.id);
    // Surprise-blind: NO claim columns
    expect(res.body.items[0]).not.toHaveProperty('is_claimed');
    expect(res.body.items[0]).not.toHaveProperty('claim_token');
    expect(res.body.items[0]).not.toHaveProperty('claimed_at');
    // (referenced for clarity)
    expect(t2.id).not.toBe(t1.id);
  });

  it('does not leak other users\' wishlisted items', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u2 });
    setTrackerWishlistFlag(t.id, u2, true);

    const res = await request(makeApp())
      .get('/api/wishlist/me')
      .set('Cookie', authCookie(u1));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
  });
});

describe('PATCH /api/wishlist/items/:tracker_id', () => {
  it('flips the flag on owned tracker (204)', async () => {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    const res = await request(makeApp())
      .patch(`/api/wishlist/items/${t.id}`)
      .set('Cookie', authCookie(u))
      .send({ is_wishlisted: true });
    expect(res.status).toBe(204);
    const row = getDb().prepare('SELECT is_wishlisted FROM trackers WHERE id = ?').get(t.id) as { is_wishlisted: number };
    expect(row.is_wishlisted).toBe(1);
  });

  it('cross-user PATCH returns 404 (no existence leak) and does not flip the flag', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u1 });
    const res = await request(makeApp())
      .patch(`/api/wishlist/items/${t.id}`)
      .set('Cookie', authCookie(u2))
      .send({ is_wishlisted: true });
    expect(res.status).toBe(404);
    const row = getDb().prepare('SELECT is_wishlisted FROM trackers WHERE id = ?').get(t.id) as { is_wishlisted: number };
    expect(row.is_wishlisted).toBe(0);
  });

  it('returns 400 when is_wishlisted is not a boolean', async () => {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    const res = await request(makeApp())
      .patch(`/api/wishlist/items/${t.id}`)
      .set('Cookie', authCookie(u))
      .send({ is_wishlisted: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for non-numeric tracker id', async () => {
    const u = seedUser('a@x.com');
    const res = await request(makeApp())
      .patch('/api/wishlist/items/abc')
      .set('Cookie', authCookie(u))
      .send({ is_wishlisted: true });
    expect(res.status).toBe(404);
  });

  it('referenced helper getOwnerToken works (smoke)', () => {
    // Sanity check that generateOrGetWishlistShareToken returns a stable
    // wl_-prefixed value when called outside a request context too.
    const u = seedUser('a@x.com');
    expect(generateOrGetWishlistShareToken(u)).toMatch(/^wl_/);
  });
});
