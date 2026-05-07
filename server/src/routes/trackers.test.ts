import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { getTrackerById } from '../db/queries.js';

// Stub the immediate-scrape side effect that POST /:id/urls triggers.
// We're testing the route, not the scraper.
vi.mock('../scheduler/cron.js', () => ({
  checkTracker: vi.fn().mockResolvedValue(undefined),
  checkTrackerUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../scraper/extractor.js', () => ({
  extractPrice: vi.fn().mockResolvedValue({ price: 0, currency: 'USD', strategy: 'stub', finalUrl: '' }),
}));

// Lazy-import the routes after the mocks are in place.
async function makeApp(): Promise<express.Express> {
  const trackerRoutes = (await import('./trackers.js')).default;
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

function seedTracker(userId: number, name = 'T'): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes)
     VALUES (?, 'https://amazon.com/dp/X', ?, 'active', 60, 0)`,
  ).run(name, userId).lastInsertRowid);
}

function seedTrackerUrl(trackerId: number, url = 'https://amazon.com/dp/Y', position = 1): number {
  return Number(getDb().prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, ?, ?)`,
  ).run(trackerId, url, position).lastInsertRowid);
}

function authCookie(userId: number, role: 'user' | 'admin' = 'user'): string {
  const token = signAccessToken({ userId, email: 'x@x.com', role });
  return `access_token=${token}`;
}

describe('Tracker API payload — AI fields', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
  });

  it('exposes ai_verdict_* and ai_summary fields when populated', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
       VALUES ('T','https://x',?,100,'active',60,0,80)`
    ).run(userId);
    const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get('T') as { id: number }).id;

    db.prepare(`UPDATE trackers SET
      ai_verdict_tier='BUY', ai_verdict_reason='At low.', ai_verdict_reason_key='at_all_time_low',
      ai_verdict_updated_at=?, ai_summary='Story.', ai_summary_updated_at=?,
      ai_signals_json='{}', ai_failure_count=0
    WHERE id=?`).run(Date.now(), Date.now(), trackerId);

    const t = getTrackerById(trackerId);
    expect(t).toBeDefined();
    expect(t!.ai_verdict_tier).toBe('BUY');
    expect(t!.ai_verdict_reason).toBe('At low.');
    expect(t!.ai_verdict_reason_key).toBe('at_all_time_low');
    expect(t!.ai_verdict_updated_at).toBeGreaterThan(0);
    expect(t!.ai_summary).toBe('Story.');
    expect(t!.ai_summary_updated_at).toBeGreaterThan(0);
    expect(t!.ai_signals_json).toBe('{}');
    expect(t!.ai_failure_count).toBe(0);
  });

  it('AI fields are null on a fresh tracker', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes)
       VALUES ('T','https://x',?,100,'active',60,0)`
    ).run(userId);
    const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get('T') as { id: number }).id;

    const t = getTrackerById(trackerId);
    expect(t).toBeDefined();
    expect(t!.ai_verdict_tier).toBeNull();
    expect(t!.ai_verdict_reason).toBeNull();
    expect(t!.ai_verdict_reason_key).toBeNull();
    expect(t!.ai_verdict_updated_at).toBeNull();
    expect(t!.ai_summary).toBeNull();
    expect(t!.ai_summary_updated_at).toBeNull();
    expect(t!.ai_signals_json).toBeNull();
    expect(t!.ai_failure_count).toBe(0); // default 0 from migration v8
  });
});

describe('POST /api/trackers/:id/urls — condition handling', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
  });

  it("defaults to 'new' when condition is omitted", async () => {
    const u = seedUser('a@x.com');
    const t = seedTracker(u);
    const app = await makeApp();
    const res = await request(app)
      .post(`/api/trackers/${t}/urls`)
      .set('Cookie', authCookie(u))
      .send({ url: 'https://newegg.com/p/Y' });
    expect(res.status).toBe(201);
    const sellers = res.body as Array<{ url: string; condition: string }>;
    const newSeller = sellers.find(s => s.url === 'https://newegg.com/p/Y');
    expect(newSeller).toBeDefined();
    expect(newSeller!.condition).toBe('new');
  });

  it("persists condition='warehouse' when supplied", async () => {
    const u = seedUser('a@x.com');
    const t = seedTracker(u);
    const app = await makeApp();
    const res = await request(app)
      .post(`/api/trackers/${t}/urls`)
      .set('Cookie', authCookie(u))
      .send({ url: 'https://amazon.com/warehouse/X', condition: 'warehouse' });
    expect(res.status).toBe(201);
    const sellers = res.body as Array<{ url: string; condition: string }>;
    const newSeller = sellers.find(s => s.url === 'https://amazon.com/warehouse/X');
    expect(newSeller!.condition).toBe('warehouse');
  });

  it('returns 400 when condition value is not in the allowed enum', async () => {
    const u = seedUser('a@x.com');
    const t = seedTracker(u);
    const app = await makeApp();
    const res = await request(app)
      .post(`/api/trackers/${t}/urls`)
      .set('Cookie', authCookie(u))
      .send({ url: 'https://newegg.com/p/Y', condition: 'used' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/trackers/:id/urls/:urlId — condition update', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
  });

  it("updates the condition and returns 204", async () => {
    const u = seedUser('a@x.com');
    const t = seedTracker(u);
    const urlId = seedTrackerUrl(t);
    const app = await makeApp();
    const res = await request(app)
      .patch(`/api/trackers/${t}/urls/${urlId}`)
      .set('Cookie', authCookie(u))
      .send({ condition: 'refurb' });
    expect(res.status).toBe(204);
    const row = getDb().prepare(`SELECT condition FROM tracker_urls WHERE id = ?`)
      .get(urlId) as { condition: string };
    expect(row.condition).toBe('refurb');
  });

  it('returns 400 on invalid condition value', async () => {
    const u = seedUser('a@x.com');
    const t = seedTracker(u);
    const urlId = seedTrackerUrl(t);
    const app = await makeApp();
    const res = await request(app)
      .patch(`/api/trackers/${t}/urls/${urlId}`)
      .set('Cookie', authCookie(u))
      .send({ condition: 'used' });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the URL belongs to another user's tracker (no cross-user updates)", async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t1 = seedTracker(u1, 'mine');
    const urlId = seedTrackerUrl(t1);
    const app = await makeApp();
    const res = await request(app)
      .patch(`/api/trackers/${t1}/urls/${urlId}`)
      .set('Cookie', authCookie(u2))
      .send({ condition: 'warehouse' });
    expect(res.status).toBe(404);
    // Ensure DB unchanged.
    const row = getDb().prepare(`SELECT condition FROM tracker_urls WHERE id = ?`)
      .get(urlId) as { condition: string };
    expect(row.condition).toBe('new');
  });

  it('returns 404 when the URL does not exist', async () => {
    const u = seedUser('a@x.com');
    const t = seedTracker(u);
    const app = await makeApp();
    const res = await request(app)
      .patch(`/api/trackers/${t}/urls/999999`)
      .set('Cookie', authCookie(u))
      .send({ condition: 'warehouse' });
    expect(res.status).toBe(404);
  });
});
