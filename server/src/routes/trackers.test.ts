import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { getTrackerById } from '../db/queries.js';
import trackersRoutes from './trackers.js';

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

// --- Doorbuster route tests ---

function makeApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use('/api/trackers', (req, _res, next) => {
    (req as { user?: { userId: number; role: string } }).user = { userId, role: 'user' };
    next();
  }, trackersRoutes);
  return app;
}

function seedUserAndTracker(): { userId: number; trackerId: number } {
  const db = getDb();
  const userId = Number(db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active) VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
  const trackerId = Number(db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes)
     VALUES ('T','https://x.example/p',?,100,'active',60,0)`
  ).run(userId).lastInsertRowid);
  // Backing tracker_urls row keeps the seller list non-empty for any later call.
  db.prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, 'https://x.example/p', 0)`
  ).run(trackerId);
  return { userId, trackerId };
}

describe('Doorbuster — PUT /api/trackers/:id', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
  });

  it('accepts all three doorbuster fields and persists them', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    const start = '2026-11-28T05:00:00.000Z';
    const end = '2026-11-29T01:00:00.000Z';
    const res = await request(makeApp(userId))
      .put(`/api/trackers/${trackerId}`)
      .send({
        doorbuster_start_at: start,
        doorbuster_end_at: end,
        doorbuster_interval_minutes: 3,
      });
    expect(res.status).toBe(200);
    expect(res.body.doorbuster_start_at).toBe(start);
    expect(res.body.doorbuster_end_at).toBe(end);
    expect(res.body.doorbuster_interval_minutes).toBe(3);

    // Round-trip: GET also returns them.
    const get = await request(makeApp(userId)).get(`/api/trackers/${trackerId}`);
    expect(get.status).toBe(200);
    expect(get.body.doorbuster_start_at).toBe(start);
    expect(get.body.doorbuster_end_at).toBe(end);
    expect(get.body.doorbuster_interval_minutes).toBe(3);
  });

  it('rejects mixed state — only doorbuster_start_at set → 400', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    const res = await request(makeApp(userId))
      .put(`/api/trackers/${trackerId}`)
      .send({ doorbuster_start_at: '2026-11-28T00:00:00Z' });
    expect(res.status).toBe(400);
  });

  it('rejects mixed state — start + end set, interval missing → 400', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    const res = await request(makeApp(userId))
      .put(`/api/trackers/${trackerId}`)
      .send({
        doorbuster_start_at: '2026-11-28T00:00:00Z',
        doorbuster_end_at: '2026-11-28T20:00:00Z',
      });
    expect(res.status).toBe(400);
  });

  it('all three set to null → 200, clears them (round-trip null check)', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    // First, set them.
    await request(makeApp(userId))
      .put(`/api/trackers/${trackerId}`)
      .send({
        doorbuster_start_at: '2026-11-28T00:00:00Z',
        doorbuster_end_at: '2026-11-28T20:00:00Z',
        doorbuster_interval_minutes: 3,
      });
    // Then clear them by passing all three as null.
    const res = await request(makeApp(userId))
      .put(`/api/trackers/${trackerId}`)
      .send({
        doorbuster_start_at: null,
        doorbuster_end_at: null,
        doorbuster_interval_minutes: null,
      });
    expect(res.status).toBe(200);
    expect(res.body.doorbuster_start_at).toBeNull();
    expect(res.body.doorbuster_end_at).toBeNull();
    expect(res.body.doorbuster_interval_minutes).toBeNull();
  });

  it('rejects doorbuster_interval_minutes < 1', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    const res = await request(makeApp(userId))
      .put(`/api/trackers/${trackerId}`)
      .send({
        doorbuster_start_at: '2026-11-28T00:00:00Z',
        doorbuster_end_at: '2026-11-28T20:00:00Z',
        doorbuster_interval_minutes: 0,
      });
    expect(res.status).toBe(400);
  });
});
