import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createIntent, getOpenIntentForTracker } from '../db/purchase-intents.js';

// Stub side-effect-heavy dependencies so the route tests stay fast and
// deterministic. We're exercising the HTTP/validation/persistence layer only.
vi.mock('../scheduler/cron.js', () => ({
  checkTracker: vi.fn().mockResolvedValue(undefined),
  checkTrackerUrl: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../scraper/extractor.js', () => ({
  extractPrice: vi.fn().mockResolvedValue({ price: 0, currency: 'USD', strategy: 'stub', finalUrl: '' }),
}));

// Build an express app that injects a hard-coded userId — same pattern as
// makeAppWithUser in trackers.test.ts. Lazy-import after mocks are in place.
async function makeAppWithUser(userId: number): Promise<express.Express> {
  const trackerRoutes = (await import('./trackers.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/api/trackers', (req, _res, next) => {
    (req as { user?: { userId: number; role: string } }).user = { userId, role: 'user' };
    next();
  }, trackerRoutes);
  return app;
}

// Seed a user + tracker + backing tracker_url row (mirrors seedUserAndTracker
// from trackers.test.ts).
function seedUserAndTracker(): { userId: number; trackerId: number } {
  const db = getDb();
  const userId = Number(db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('arm@x.com','h','Arm','user',1)`,
  ).run().lastInsertRowid);
  const trackerId = Number(db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes)
     VALUES ('ArmTracker','https://amazon.com/dp/ARM',?,99,'active',60,0)`,
  ).run(userId).lastInsertRowid);
  db.prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, 'https://amazon.com/dp/ARM', 0)`,
  ).run(trackerId);
  return { userId, trackerId };
}

describe('PUT /api/trackers/:id — buy_armed / buy_quantity', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
  });

  it('arms the tracker and sets buy_quantity — returns 200 and persists the values', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    const res = await request(await makeAppWithUser(userId))
      .put(`/api/trackers/${trackerId}`)
      .send({ buy_armed: true, buy_quantity: 2 });

    expect(res.status).toBe(200);
    expect(res.body.buy_armed).toBe(1);
    expect(res.body.buy_quantity).toBe(2);

    // Verify the values were persisted in the DB.
    const row = getDb()
      .prepare('SELECT buy_armed, buy_quantity FROM trackers WHERE id = ?')
      .get(trackerId) as { buy_armed: number; buy_quantity: number };
    expect(row.buy_armed).toBe(1);
    expect(row.buy_quantity).toBe(2);
  });

  it('rejects buy_quantity=0 with 400 (zod min(1))', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    const res = await request(await makeAppWithUser(userId))
      .put(`/api/trackers/${trackerId}`)
      .send({ buy_quantity: 0 });

    expect(res.status).toBe(400);
  });

  it('disarms an armed tracker — buy_armed goes to 0', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    const app = await makeAppWithUser(userId);

    // Arm first.
    await request(app)
      .put(`/api/trackers/${trackerId}`)
      .send({ buy_armed: true, buy_quantity: 3 });

    // Verify armed.
    const armed = getDb()
      .prepare('SELECT buy_armed FROM trackers WHERE id = ?')
      .get(trackerId) as { buy_armed: number };
    expect(armed.buy_armed).toBe(1);

    // Disarm.
    const res = await request(app)
      .put(`/api/trackers/${trackerId}`)
      .send({ buy_armed: false });

    expect(res.status).toBe(200);
    expect(res.body.buy_armed).toBe(0);

    const disarmed = getDb()
      .prepare('SELECT buy_armed FROM trackers WHERE id = ?')
      .get(trackerId) as { buy_armed: number };
    expect(disarmed.buy_armed).toBe(0);
  });

  it('disarming cancels any open purchase intent — status becomes canceled, getOpenIntentForTracker returns undefined', async () => {
    const { userId, trackerId } = seedUserAndTracker();
    const app = await makeAppWithUser(userId);

    // Arm the tracker.
    await request(app)
      .put(`/api/trackers/${trackerId}`)
      .send({ buy_armed: true });

    // Create an open intent (simulates what firePurchaseArm would do on a cron tick).
    const intent = createIntent({
      tracker_id: trackerId,
      tracker_url_id: null,
      asin: 'B0ARMTEST',
      price_at_arm: 79.99,
      threshold_at_arm: 99,
      quantity: 1,
      expires_at: new Date(Date.now() + 86_400_000).toISOString().replace('T', ' ').slice(0, 19),
    });
    expect(getOpenIntentForTracker(trackerId)?.id).toBe(intent.id);

    // Disarm — should cancel the open intent.
    const res = await request(app)
      .put(`/api/trackers/${trackerId}`)
      .send({ buy_armed: false });

    expect(res.status).toBe(200);

    // Intent should now be canceled and no longer open.
    expect(getOpenIntentForTracker(trackerId)).toBeUndefined();
    const row = getDb()
      .prepare('SELECT status FROM purchase_intents WHERE id = ?')
      .get(intent.id) as { status: string };
    expect(row.status).toBe('canceled');
  });
});
