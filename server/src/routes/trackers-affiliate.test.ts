import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import { config } from '../config.js';

/**
 * Integration coverage for the Amazon affiliate rewrite applied at
 * route-response time. The unit tests in `lib/affiliate.test.ts`
 * already lock down the helper's URL-mangling semantics; this file
 * asserts the helper is actually reached on the wire from each
 * tracker-shaped endpoint that the dashboard / public surfaces hit.
 */

vi.mock('../scheduler/cron.js', () => ({
  checkTracker: vi.fn().mockResolvedValue(undefined),
  checkTrackerUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../scraper/extractor.js', () => ({
  extractPrice: vi.fn().mockResolvedValue({ price: 0, currency: 'USD', strategy: 'stub', finalUrl: '' }),
}));

async function makeApp(): Promise<express.Express> {
  const trackerRoutes = (await import('./trackers.js')).default;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/trackers', authMiddleware, trackerRoutes);
  return app;
}

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('a@x.com', 'h', 'A', 'user', 1)`,
  ).run().lastInsertRowid);
}

function seedAmazonTracker(userId: number): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
     VALUES ('T', 'https://www.amazon.com/dp/B01', ?, 'active', 60, 0)`,
  ).run(userId).lastInsertRowid);
}

function authCookie(userId: number): string {
  const token = signAccessToken({ userId, email: 'a@x.com', role: 'user' });
  return `access_token=${token}`;
}

const ORIGINAL_TAG = config.amazonAffiliateTag;

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  config.amazonAffiliateTag = 'mytag-20';
});

afterEach(() => {
  config.amazonAffiliateTag = ORIGINAL_TAG;
});

describe('Amazon affiliate tag — route serialization', () => {
  it('GET /api/trackers — list response has tag on every Amazon URL', async () => {
    const u = seedUser();
    seedAmazonTracker(u);
    // Insert the position=0 seller row by hand (createTracker would
    // also work, but we want to avoid invoking it just to seed state).
    getDb().prepare(
      `INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, 'https://www.amazon.com/dp/B01', 0)`,
    ).run(1);

    const app = await makeApp();
    const res = await request(app)
      .get('/api/trackers')
      .set('Cookie', authCookie(u));

    expect(res.status).toBe(200);
    const trackers = res.body as Array<{ url: string; best_seller_url: string | null }>;
    expect(trackers).toHaveLength(1);
    expect(trackers[0].url).toBe('https://www.amazon.com/dp/B01?tag=mytag-20');
  });

  it('GET /api/trackers/:id — detail response has tag on tracker.url', async () => {
    const u = seedUser();
    const t = seedAmazonTracker(u);
    const app = await makeApp();
    const res = await request(app)
      .get(`/api/trackers/${t}`)
      .set('Cookie', authCookie(u));

    expect(res.status).toBe(200);
    expect((res.body as { url: string }).url).toBe('https://www.amazon.com/dp/B01?tag=mytag-20');
  });

  it('GET /api/trackers/:id/urls — seller list response has tag on each seller URL', async () => {
    const u = seedUser();
    const t = seedAmazonTracker(u);
    getDb().prepare(
      `INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, 'https://www.amazon.com/dp/B01', 0)`,
    ).run(t);
    getDb().prepare(
      `INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, 'https://newegg.com/p/X', 1)`,
    ).run(t);

    const app = await makeApp();
    const res = await request(app)
      .get(`/api/trackers/${t}/urls`)
      .set('Cookie', authCookie(u));

    expect(res.status).toBe(200);
    const urls = res.body as Array<{ url: string }>;
    const amazonSeller = urls.find(s => s.url.includes('amazon.com'));
    const neweggSeller = urls.find(s => s.url.includes('newegg.com'));
    expect(amazonSeller?.url).toBe('https://www.amazon.com/dp/B01?tag=mytag-20');
    // Non-Amazon URLs pass through untouched.
    expect(neweggSeller?.url).toBe('https://newegg.com/p/X');
  });

  it('feature off (empty tag) — Amazon URLs come through as-is', async () => {
    config.amazonAffiliateTag = '';
    const u = seedUser();
    seedAmazonTracker(u);
    const app = await makeApp();
    const res = await request(app)
      .get('/api/trackers')
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(200);
    const trackers = res.body as Array<{ url: string }>;
    // No `?tag=` appended when the feature is off.
    expect(trackers[0].url).toBe('https://www.amazon.com/dp/B01');
  });
});
