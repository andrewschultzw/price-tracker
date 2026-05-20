import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { authMiddleware } from '../auth/middleware.js';
import { signAccessToken } from '../auth/tokens.js';
import { trackerPurchasesRouter, purchasesRouter } from './purchases.js';

function seedUser(email: string): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function seedTracker(userId: number, opts: { name?: string; url?: string; last_price?: number | null } = {}): number {
  const name = opts.name ?? 'T';
  const url = opts.url ?? 'https://amazon.com/dp/X';
  const lastPrice = opts.last_price ?? null;
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 'active', 60, 0, ?)`,
  ).run(name, url, userId, lastPrice).lastInsertRowid);
}

function seedPriceHistory(trackerId: number, entries: Array<{ price: number; at: string }>): void {
  const stmt = getDb().prepare(
    `INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, ?)`,
  );
  for (const e of entries) stmt.run(trackerId, e.price, e.at);
}

function authCookie(userId: number, role: 'user' | 'admin' = 'user'): string {
  const token = signAccessToken({ userId, email: 'x@x.com', role });
  return `access_token=${token}`;
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/trackers', authMiddleware, trackerPurchasesRouter);
  app.use('/api/purchases', authMiddleware, purchasesRouter);
  return app;
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('POST /api/trackers/:id/purchases', () => {
  it('creates a purchase, snapshots first_price, sets status=purchased', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, { last_price: 50 });
    seedPriceHistory(trackerId, [
      { price: 100, at: '2026-01-01T00:00:00Z' },
      { price: 80, at: '2026-02-01T00:00:00Z' },
    ]);

    const res = await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .set('Cookie', authCookie(userId))
      .send({ purchase_price: 40, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.purchase.first_price).toBe(100);
    expect(res.body.purchase.purchase_price).toBe(40);
    expect(res.body.purchase.quantity).toBe(2);
    expect(res.body.tracker.status).toBe('purchased');
  });

  it('keep_watching=true leaves tracker active', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, { last_price: 50 });
    const res = await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .set('Cookie', authCookie(userId))
      .send({ purchase_price: 40, keep_watching: true });
    expect(res.status).toBe(201);
    expect(res.body.tracker.status).toBe('active');
  });

  it('defaults purchase_price to tracker.last_price', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, { last_price: 73 });
    const res = await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .set('Cookie', authCookie(userId))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.purchase.purchase_price).toBe(73);
  });

  it('rejects 404 when tracker does not belong to the user', async () => {
    const ownerId = seedUser('owner@b.com');
    const intruderId = seedUser('evil@b.com');
    const trackerId = seedTracker(ownerId);
    const res = await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .set('Cookie', authCookie(intruderId))
      .send({ purchase_price: 10 });
    expect(res.status).toBe(404);
  });

  it('rejects 400 for negative purchase_price', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const res = await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .set('Cookie', authCookie(userId))
      .send({ purchase_price: -5 });
    expect(res.status).toBe(400);
  });

  it('rejects 400 when no purchase_price and tracker has no last_price', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, { last_price: null });
    const res = await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .set('Cookie', authCookie(userId))
      .send({});
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, { last_price: 50 });
    const res = await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .send({ purchase_price: 40 });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/purchases', () => {
  it('returns purchases for the authed user, newest first', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, { last_price: 50 });
    await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .set('Cookie', authCookie(userId))
      .send({ purchase_price: 45, purchased_at: '2026-01-01T00:00:00Z' });
    await request(makeApp())
      .post(`/api/trackers/${trackerId}/purchases`)
      .set('Cookie', authCookie(userId))
      .send({ purchase_price: 40, purchased_at: '2026-02-01T00:00:00Z' });

    const res = await request(makeApp())
      .get('/api/purchases')
      .set('Cookie', authCookie(userId));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.purchases).toHaveLength(2);
    expect(res.body.purchases[0].purchase_price).toBe(40);
    expect(res.body.purchases[1].purchase_price).toBe(45);
  });

  it("does not return another user's purchases", async () => {
    const aId = seedUser('a@b.com');
    const bId = seedUser('b@b.com');
    const trackerA = seedTracker(aId, { last_price: 50 });
    await request(makeApp())
      .post(`/api/trackers/${trackerA}/purchases`)
      .set('Cookie', authCookie(aId))
      .send({ purchase_price: 40 });
    const res = await request(makeApp())
      .get('/api/purchases')
      .set('Cookie', authCookie(bId));
    expect(res.status).toBe(200);
    expect(res.body.purchases).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  it('honors limit and offset query params', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, { last_price: 50 });
    for (let i = 0; i < 3; i++) {
      await request(makeApp())
        .post(`/api/trackers/${trackerId}/purchases`)
        .set('Cookie', authCookie(userId))
        .send({ purchase_price: 10 + i, purchased_at: `2026-0${i + 1}-01T00:00:00Z` });
    }
    const res = await request(makeApp())
      .get('/api/purchases?limit=1&offset=1')
      .set('Cookie', authCookie(userId));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.purchases).toHaveLength(1);
  });

  it('requires auth', async () => {
    const res = await request(makeApp()).get('/api/purchases');
    expect(res.status).toBe(401);
  });
});
