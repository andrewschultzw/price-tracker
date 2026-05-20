import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createPurchase } from '../db/queries.js';
import { publicSavingsRouter } from './public-savings.js';

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

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // No auth middleware on purpose — this endpoint is intentionally public.
  app.use(publicSavingsRouter);
  return app;
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('GET /api/public/savings', () => {
  it('returns aggregate without requiring auth', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, { last_price: 50 });
    seedPriceHistory(trackerId, [{ price: 100, at: '2026-01-01T00:00:00Z' }]);
    createPurchase(
      trackerId,
      { purchase_price: 40, quantity: 2, purchased_at: '2026-02-01T00:00:00Z' },
      { keep_watching: false },
    );

    const res = await request(makeApp()).get('/api/public/savings');
    expect(res.status).toBe(200);
    // (100 - 40) * 2 = 120
    expect(res.body.total_saved).toBe(120);
    expect(res.body.purchase_count).toBe(1);
    expect(res.body.since).toMatch(/^2026-/);
    expect(Array.isArray(res.body.monthly)).toBe(true);
    expect(res.body.monthly).toHaveLength(1);
    expect(res.body.monthly[0]).toEqual({ month: '2026-02', saved: 120 });
  });

  it('payload contains no product or retailer fields', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId, {
      name: 'Secret Widget',
      url: 'https://supersecret.example/abc',
      last_price: 50,
    });
    seedPriceHistory(trackerId, [{ price: 100, at: '2026-01-01T00:00:00Z' }]);
    createPurchase(
      trackerId,
      { purchase_price: 40 },
      { keep_watching: false },
    );

    const res = await request(makeApp()).get('/api/public/savings');
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Secret Widget');
    expect(body).not.toContain('supersecret');
    expect(body).not.toContain('amazon');
    // Top-level keys allow-list — must be exactly these four.
    const keys = Object.keys(res.body).sort();
    expect(keys).toEqual(['monthly', 'purchase_count', 'since', 'total_saved']);
  });

  it('returns zeros when no purchases exist', async () => {
    const res = await request(makeApp()).get('/api/public/savings');
    expect(res.status).toBe(200);
    expect(res.body.total_saved).toBe(0);
    expect(res.body.purchase_count).toBe(0);
    expect(res.body.since).toBeNull();
    expect(res.body.monthly).toEqual([]);
  });

  it('does not require a logged-in user', async () => {
    // No cookies, no headers, no auth — must succeed.
    const res = await request(makeApp())
      .get('/api/public/savings');
    expect(res.status).toBe(200);
  });
});
