import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import {
  createTracker,
  generateOrGetWishlistShareToken,
  setTrackerWishlistFlag,
  setSetting,
} from '../db/queries.js';
import publicWishlistRoutes from './public-wishlist.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

function seedUser(email: string, displayName: string = 'Alice'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', ?, 'user', 1)`,
  ).run(email, displayName).lastInsertRowid);
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // No auth middleware — these routes are intentionally public.
  app.use('/api/public/wishlist', publicWishlistRoutes);
  return app;
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('GET /api/public/wishlist/:token', () => {
  it('returns 404 on a bad token', async () => {
    const res = await request(makeApp()).get('/api/public/wishlist/wl_doesnotexist');
    expect(res.status).toBe(404);
  });

  it('returns the expected shape — items[], display_name, is_claimed per item', async () => {
    const u = seedUser('a@x.com', 'Alice');
    setSetting('share_display_name', 'true', u);
    const t1 = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    const t2 = createTracker({ name: 'B', url: 'https://x/2', user_id: u });
    setTrackerWishlistFlag(t1.id, u, true);
    setTrackerWishlistFlag(t2.id, u, true);
    const token = generateOrGetWishlistShareToken(u);

    const res = await request(makeApp()).get(`/api/public/wishlist/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBe('Alice');
    expect(res.body.items).toHaveLength(2);
    for (const item of res.body.items) {
      expect(item).toHaveProperty('tracker_id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('url');
      expect(item).toHaveProperty('is_claimed', false);
      // Privacy: threshold_price MUST NOT appear on public response.
      expect(item).not.toHaveProperty('threshold_price');
    }
  });

  it('hides display_name when share_display_name is false', async () => {
    const u = seedUser('a@x.com', 'Alice');
    // share_display_name not set → defaults to off
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    setTrackerWishlistFlag(t.id, u, true);
    const token = generateOrGetWishlistShareToken(u);

    const res = await request(makeApp()).get(`/api/public/wishlist/${token}`);
    expect(res.status).toBe(200);
    expect(res.body.display_name).toBeNull();
  });

  it('sets a 60-second Cache-Control header', async () => {
    const u = seedUser('a@x.com');
    const token = generateOrGetWishlistShareToken(u);
    const res = await request(makeApp()).get(`/api/public/wishlist/${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=60/);
    expect(res.headers['cache-control']).toMatch(/public/);
  });

  it('does NOT require auth — no Cookie / no Authorization / no X-API-Key still works', async () => {
    const u = seedUser('a@x.com');
    const token = generateOrGetWishlistShareToken(u);
    const res = await request(makeApp())
      .get(`/api/public/wishlist/${token}`);
    expect(res.status).toBe(200);
  });
});

describe('POST /api/public/wishlist/:token/claim/:tracker_id', () => {
  it('returns 201 with claim_token on first claim', async () => {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    setTrackerWishlistFlag(t.id, u, true);
    const token = generateOrGetWishlistShareToken(u);
    const res = await request(makeApp())
      .post(`/api/public/wishlist/${token}/claim/${t.id}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.claim_token).toMatch(/^wc_[A-Za-z0-9_-]{32}$/);
  });

  it('returns 409 when item already claimed', async () => {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    setTrackerWishlistFlag(t.id, u, true);
    const token = generateOrGetWishlistShareToken(u);
    await request(makeApp())
      .post(`/api/public/wishlist/${token}/claim/${t.id}`)
      .send({});
    const res = await request(makeApp())
      .post(`/api/public/wishlist/${token}/claim/${t.id}`)
      .send({});
    expect(res.status).toBe(409);
  });

  it('returns 404 on bad token', async () => {
    const res = await request(makeApp())
      .post('/api/public/wishlist/wl_nope/claim/1')
      .send({});
    expect(res.status).toBe(404);
  });

  it('returns 404 when the tracker is NOT on the owner\'s wishlist (no leak)', async () => {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    // is_wishlisted is intentionally NOT set on this tracker
    const token = generateOrGetWishlistShareToken(u);
    const res = await request(makeApp())
      .post(`/api/public/wishlist/${token}/claim/${t.id}`)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/public/wishlist/:token/claim/:tracker_id', () => {
  async function setupClaim(): Promise<{ token: string; trackerId: number; claimToken: string }> {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    setTrackerWishlistFlag(t.id, u, true);
    const token = generateOrGetWishlistShareToken(u);
    const r = await request(makeApp())
      .post(`/api/public/wishlist/${token}/claim/${t.id}`)
      .send({});
    return { token, trackerId: t.id, claimToken: r.body.claim_token };
  }

  it('returns 204 with right claim_token in body', async () => {
    const { token, trackerId, claimToken } = await setupClaim();
    const res = await request(makeApp())
      .delete(`/api/public/wishlist/${token}/claim/${trackerId}`)
      .send({ claim_token: claimToken });
    expect(res.status).toBe(204);
  });

  it('returns 204 with right claim_token in X-Claim-Token header', async () => {
    const { token, trackerId, claimToken } = await setupClaim();
    const res = await request(makeApp())
      .delete(`/api/public/wishlist/${token}/claim/${trackerId}`)
      .set('X-Claim-Token', claimToken)
      .send({});
    expect(res.status).toBe(204);
  });

  it('returns 404 with wrong claim_token', async () => {
    const { token, trackerId } = await setupClaim();
    const res = await request(makeApp())
      .delete(`/api/public/wishlist/${token}/claim/${trackerId}`)
      .send({ claim_token: 'wc_wrong' });
    expect(res.status).toBe(404);
  });

  it('returns 404 when no claim_token provided in body or header', async () => {
    const { token, trackerId } = await setupClaim();
    const res = await request(makeApp())
      .delete(`/api/public/wishlist/${token}/claim/${trackerId}`)
      .send({});
    expect(res.status).toBe(404);
  });
});
