import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import {
  createSlugForUrl,
  createTracker,
  addPriceRecord,
  addNotification,
  setSetting,
} from '../db/queries.js';
import publicProductRoutes, { sitemapHandler } from './public-products.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

function seedUser(email: string): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  // No auth middleware — public routes are mounted bare on purpose.
  app.use('/api/public', publicProductRoutes);
  app.get('/sitemap.xml', sitemapHandler);
  return app;
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('GET /api/public/products/:slug', () => {
  it('returns 404 for unknown slug', async () => {
    const res = await request(makeApp()).get('/api/public/products/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Product not found');
  });

  it('returns the expected shape on a known slug', async () => {
    const userId = seedUser('a@x.com');
    const t = createTracker({
      name: 'Sample Product',
      url: 'https://amazon.com/dp/B0SAMPLE',
      user_id: userId,
    });
    getDb().prepare(`UPDATE trackers SET last_price = 99 WHERE id = ?`).run(t.id);
    addPriceRecord(t.id, 100);
    addPriceRecord(t.id, 99);

    const created = createSlugForUrl(t.normalized_url, t.name);
    const res = await request(makeApp()).get(`/api/public/products/${created!.slug}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slug: created!.slug,
      display_name: 'Sample Product',
      normalized_url: 'amazon.com/dp/b0sample',
      lowest_current_price: 99,
      lowest_ever_price: 99,
      sample_count: 2,
    });
    expect(typeof res.body.first_observed).toBe('string');
    expect(Array.isArray(res.body.price_history)).toBe(true);
    // Each history row has shape { date, price }
    if (res.body.price_history.length > 0) {
      expect(res.body.price_history[0]).toHaveProperty('date');
      expect(res.body.price_history[0]).toHaveProperty('price');
    }
  });

  it('does NOT require auth — no Cookie / no Authorization / no X-API-Key still works', async () => {
    const userId = seedUser('a@x.com');
    const t = createTracker({
      name: 'Anon Test',
      url: 'https://amazon.com/dp/B0ANON',
      user_id: userId,
    });
    const created = createSlugForUrl(t.normalized_url, t.name);
    // Note: NO `.set('Cookie')`, NO `.set('Authorization')`, NO `.set('X-API-Key')`.
    const res = await request(makeApp())
      .get(`/api/public/products/${created!.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.slug).toBe(created!.slug);
  });

  it('sets a 15-minute Cache-Control header for SEO/CDN smoothing', async () => {
    const userId = seedUser('a@x.com');
    const t = createTracker({
      name: 'Cached',
      url: 'https://amazon.com/dp/B0CACHE',
      user_id: userId,
    });
    const created = createSlugForUrl(t.normalized_url, t.name);
    const res = await request(makeApp()).get(`/api/public/products/${created!.slug}`);
    expect(res.headers['cache-control']).toMatch(/max-age=900/);
    expect(res.headers['cache-control']).toMatch(/s-maxage=900/);
    expect(res.headers['cache-control']).toMatch(/public/);
  });
});

describe('GET /api/public/deals', () => {
  it('returns 200 with empty entries when no users are opted in', async () => {
    const res = await request(makeApp()).get('/api/public/deals');
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(typeof res.body.generated_at).toBe('string');
    expect(() => new Date(res.body.generated_at).toISOString()).not.toThrow();
  });

  it('returns the expected shape when an opted-in user has a recent threshold-beating notification', async () => {
    const userId = seedUser('a@x.com');
    setSetting('share_in_deal_feed', 'true', userId);
    const t = createTracker({
      name: 'Deal Sample',
      url: 'https://amazon.com/dp/B0DEAL',
      user_id: userId,
    });
    addNotification(t.id, 80, 100);

    const res = await request(makeApp()).get('/api/public/deals');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries).toHaveLength(1);
    const e = res.body.entries[0];
    expect(e).toMatchObject({
      display_name: 'Deal Sample',
      current_price: 80,
      threshold_price: 100,
      normalized_url: 'amazon.com/dp/b0deal',
    });
    expect(typeof e.slug).toBe('string');
    expect(e.slug.length).toBeGreaterThan(0);
    expect(typeof e.drop_pct).toBe('number');
    expect(e.drop_pct).toBeCloseTo(0.2, 5);
    expect(typeof e.hours_ago).toBe('number');
  });

  it('sets a 5-minute Cache-Control header', async () => {
    const res = await request(makeApp()).get('/api/public/deals');
    expect(res.headers['cache-control']).toMatch(/max-age=300/);
    expect(res.headers['cache-control']).toMatch(/s-maxage=300/);
    expect(res.headers['cache-control']).toMatch(/public/);
  });

  it('does NOT require auth — no Cookie / no Authorization / no X-API-Key still works', async () => {
    const res = await request(makeApp()).get('/api/public/deals');
    // No `.set('Cookie')`, no `.set('Authorization')`, no `.set('X-API-Key')`.
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  it('does not leak user_id, tracker_id, or any user-identifying fields', async () => {
    const userId = seedUser('a@x.com');
    setSetting('share_in_deal_feed', 'true', userId);
    const t = createTracker({
      name: 'Privacy Sample',
      url: 'https://amazon.com/dp/B0PRIV',
      user_id: userId,
    });
    addNotification(t.id, 50, 100);
    const res = await request(makeApp()).get('/api/public/deals');
    expect(res.status).toBe(200);
    const e = res.body.entries[0];
    expect(e).not.toHaveProperty('user_id');
    expect(e).not.toHaveProperty('tracker_id');
    expect(e).not.toHaveProperty('email');
    expect(e).not.toHaveProperty('display_name_user');
  });
});

describe('GET /sitemap.xml', () => {
  it('returns text/xml with all slugs and a 1-hour cache header', async () => {
    const userId = seedUser('a@x.com');
    const t1 = createTracker({ name: 'P1', url: 'https://amazon.com/dp/B01', user_id: userId });
    const t2 = createTracker({ name: 'P2', url: 'https://amazon.com/dp/B02', user_id: userId });
    expect(t1.normalized_url).not.toBeNull();
    expect(t2.normalized_url).not.toBeNull();

    const res = await request(makeApp()).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
    expect(res.headers['cache-control']).toMatch(/max-age=3600/);
    expect(res.text).toMatch(/<\?xml /);
    expect(res.text).toMatch(/<urlset /);
    // Both slugs should appear as <loc>https://prices.schultzsolutions.tech/p/...</loc>
    expect(res.text).toMatch(/https:\/\/prices\.schultzsolutions\.tech\/p\//);
    // 1 static (/deals) + 2 product slugs = 3
    const locCount = (res.text.match(/<loc>/g) || []).length;
    expect(locCount).toBe(3);
    expect(res.text).toMatch(/https:\/\/prices\.schultzsolutions\.tech\/deals</);
  });

  it('returns a valid sitemap with the static /deals entry when there are no slugs', async () => {
    const res = await request(makeApp()).get('/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<urlset/);
    expect(res.text).toMatch(/<\/urlset>/);
    // Even with zero slugs, /deals is always present.
    expect((res.text.match(/<url>/g) || []).length).toBe(1);
    expect(res.text).toMatch(/https:\/\/prices\.schultzsolutions\.tech\/deals</);
  });
});
