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
import { createIntent } from '../db/purchase-intents.js';
import { buyRouter } from './buy.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function seedUser(email: string): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO users (email, password_hash, display_name, role, is_active)
         VALUES (?, 'h', 'A', 'user', 1)`,
      )
      .run(email).lastInsertRowid,
  );
}

function seedTracker(userId: number): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes, jitter_minutes, last_price)
         VALUES ('T', 'https://amazon.com/dp/X', ?, 'active', 60, 0, 99.99)`,
      )
      .run(userId).lastInsertRowid,
  );
}

/** Produce a Set-Cookie value accepted by supertest `.set('Cookie', ...)`. */
function authCookie(userId: number, role: 'user' | 'admin' = 'user'): string {
  const token = signAccessToken({ userId, email: 'x@x.com', role });
  return `access_token=${token}`;
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/buy', authMiddleware, buyRouter);
  return app;
}

// ── test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

// ── helpers for a canonical "armed" intent ────────────────────────────────────

function seedArmedIntent(trackerId: number) {
  return createIntent({
    tracker_id: trackerId,
    tracker_url_id: null,
    asin: 'B09TESTTEST',
    price_at_arm: 49.99,
    threshold_at_arm: 55.0,
    quantity: 2,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(), // 24 h from now
  });
}

// ── GET /api/buy/:token ────────────────────────────────────────────────────────

describe('GET /api/buy/:token', () => {
  it('returns the order summary with buyUrl=null for an armed intent', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);

    const res = await request(makeApp())
      .get(`/api/buy/${intent.token}`)
      .set('Cookie', authCookie(userId));

    expect(res.status).toBe(200);
    expect(res.body.intent.status).toBe('armed');
    expect(res.body.intent.asin).toBe('B09TESTTEST');
    expect(res.body.intent.price_at_arm).toBe(49.99);
    expect(res.body.intent.quantity).toBe(2);
    expect(res.body.tracker.id).toBe(trackerId);
    // buy URL is null while the intent is still armed
    expect(res.body.buyUrl).toBeNull();
  });

  it('returns 404 for an unknown token', async () => {
    const userId = seedUser('a@b.com');
    const res = await request(makeApp())
      .get('/api/buy/completely-bogus-token')
      .set('Cookie', authCookie(userId));
    expect(res.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);
    const res = await request(makeApp()).get(`/api/buy/${intent.token}`);
    expect(res.status).toBe(401);
  });

  // ── Security: cross-user 404 ──────────────────────────────────────────────
  // User B is authenticated but the intent belongs to user A's tracker.
  // The server must return 404 — not 403, not the real intent data.
  it('returns 404 (not 403) when a different authenticated user requests the token', async () => {
    const userA = seedUser('a@b.com');
    const userB = seedUser('b@b.com');
    const trackerOfA = seedTracker(userA);
    const intent = seedArmedIntent(trackerOfA);

    // Authenticate as user B, who does NOT own the tracker.
    const res = await request(makeApp())
      .get(`/api/buy/${intent.token}`)
      .set('Cookie', authCookie(userB));

    expect(res.status).toBe(404);
    // Must not leak the intent payload
    expect(res.body.asin).toBeUndefined();
    expect(res.body.intent).toBeUndefined();
  });
});

// ── POST /api/buy/:token/approve ──────────────────────────────────────────────

describe('POST /api/buy/:token/approve', () => {
  it('approves the intent and returns a buyUrl containing the ASIN', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);

    const res = await request(makeApp())
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userId));

    expect(res.status).toBe(200);
    expect(res.body.buyUrl).toMatch(/B09TESTTEST/);
    expect(res.body.buyUrl).toContain('amazon.com');
  });

  it('is idempotent — a second approve on an already-approved intent returns 200', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);

    const app = makeApp();
    await request(app)
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userId));
    const second = await request(app)
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userId));

    expect(second.status).toBe(200);
    expect(second.body.buyUrl).toMatch(/B09TESTTEST/);
  });

  it('returns 404 when a different user tries to approve', async () => {
    const userA = seedUser('a@b.com');
    const userB = seedUser('b@b.com');
    const trackerOfA = seedTracker(userA);
    const intent = seedArmedIntent(trackerOfA);

    const res = await request(makeApp())
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userB));

    expect(res.status).toBe(404);
  });

  it('returns 409 when trying to approve a resolved intent', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);
    const app = makeApp();

    // approve then resolve as not_completed to reach a terminal state
    await request(app)
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userId));
    await request(app)
      .post(`/api/buy/${intent.token}/resolve`)
      .set('Cookie', authCookie(userId))
      .send({ outcome: 'not_completed' });

    const res = await request(app)
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userId));

    expect(res.status).toBe(409);
  });
});

// ── POST /api/buy/:token/resolve ──────────────────────────────────────────────

describe('POST /api/buy/:token/resolve', () => {
  it('happy path: approve then resolve purchased → status=purchased, purchase row exists', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);
    const app = makeApp();

    // Step 1: approve
    const approveRes = await request(app)
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userId));
    expect(approveRes.status).toBe(200);

    // Step 2: resolve as purchased
    const resolveRes = await request(app)
      .post(`/api/buy/${intent.token}/resolve`)
      .set('Cookie', authCookie(userId))
      .send({ outcome: 'purchased' });

    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.intent.status).toBe('purchased');
    expect(resolveRes.body.purchase).toBeDefined();
    expect(resolveRes.body.purchase.tracker_id).toBe(trackerId);

    // Verify a purchases row was actually inserted
    const row = getDb()
      .prepare('SELECT * FROM purchases WHERE tracker_id = ?')
      .get(trackerId);
    expect(row).toBeTruthy();
  });

  it('resolve not_completed → status=not_completed, no purchase row', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);
    const app = makeApp();

    await request(app)
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userId));

    const res = await request(app)
      .post(`/api/buy/${intent.token}/resolve`)
      .set('Cookie', authCookie(userId))
      .send({ outcome: 'not_completed' });

    expect(res.status).toBe(200);
    expect(res.body.intent.status).toBe('not_completed');
    expect(res.body.purchase).toBeUndefined();

    const row = getDb()
      .prepare('SELECT * FROM purchases WHERE tracker_id = ?')
      .get(trackerId);
    expect(row).toBeFalsy();
  });

  it('returns 409 when resolving an intent that is still armed (not approved)', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);

    // Do NOT approve first — intent stays armed.
    const res = await request(makeApp())
      .post(`/api/buy/${intent.token}/resolve`)
      .set('Cookie', authCookie(userId))
      .send({ outcome: 'purchased' });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/armed/);
  });

  it('returns 400 for an invalid outcome value', async () => {
    const userId = seedUser('a@b.com');
    const trackerId = seedTracker(userId);
    const intent = seedArmedIntent(trackerId);
    const app = makeApp();

    await request(app)
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userId));

    const res = await request(app)
      .post(`/api/buy/${intent.token}/resolve`)
      .set('Cookie', authCookie(userId))
      .send({ outcome: 'refunded' }); // not a valid enum value

    expect(res.status).toBe(400);
  });

  it('returns 404 when a different user tries to resolve', async () => {
    const userA = seedUser('a@b.com');
    const userB = seedUser('b@b.com');
    const trackerOfA = seedTracker(userA);
    const intent = seedArmedIntent(trackerOfA);
    const app = makeApp();

    // Approve as owner first so the intent is approvable state
    await request(app)
      .post(`/api/buy/${intent.token}/approve`)
      .set('Cookie', authCookie(userA));

    // Attempt to resolve as different user B
    const res = await request(app)
      .post(`/api/buy/${intent.token}/resolve`)
      .set('Cookie', authCookie(userB))
      .send({ outcome: 'purchased' });

    expect(res.status).toBe(404);
  });
});
