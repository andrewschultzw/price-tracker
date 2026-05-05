import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import webPushRoutes from './web-push.js';

function makeApp(userId: number, userAgent = 'Mozilla/5.0 (Macintosh; ...) Chrome/120.0') {
  const app = express();
  app.use(express.json());
  app.use('/api/web-push', (req, _res, next) => {
    (req as { user?: { userId: number; role: string } }).user = { userId, role: 'user' };
    if (userAgent) req.headers['user-agent'] = userAgent;
    next();
  }, webPushRoutes);
  return app;
}

function seedUser(email = 't@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'T', 'user', 1)`
  ).run(email).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('web push routes', () => {
  const validBody = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: { p256dh: 'P', auth: 'A' },
  };

  it('POST /subscribe creates a subscription with device_label from UA', async () => {
    const u = seedUser();
    const res = await request(makeApp(u, 'Mozilla/5.0 (Macintosh) Chrome/120.0'))
      .post('/api/web-push/subscribe').send(validBody);
    expect(res.status).toBe(201);
    expect(res.body.device_label).toBe('Mac · Chrome');
  });

  it('POST /subscribe accepts an explicit device_label override', async () => {
    const u = seedUser();
    const res = await request(makeApp(u))
      .post('/api/web-push/subscribe').send({ ...validBody, device_label: 'My Phone' });
    expect(res.status).toBe(201);
    expect(res.body.device_label).toBe('My Phone');
  });

  it('POST /subscribe rejects malformed body', async () => {
    const u = seedUser();
    const res = await request(makeApp(u))
      .post('/api/web-push/subscribe').send({ endpoint: 'not-a-url' });
    expect(res.status).toBe(400);
  });

  it('POST /subscribe is UPSERT — same endpoint returns same id', async () => {
    const u = seedUser();
    const r1 = await request(makeApp(u)).post('/api/web-push/subscribe').send(validBody);
    const r2 = await request(makeApp(u)).post('/api/web-push/subscribe').send(validBody);
    expect(r1.body.id).toBe(r2.body.id);
  });

  it('GET /devices lists user subscriptions with keys redacted', async () => {
    const u = seedUser();
    await request(makeApp(u)).post('/api/web-push/subscribe').send(validBody);
    const res = await request(makeApp(u)).get('/api/web-push/devices');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveProperty('device_label');
    expect(res.body[0]).not.toHaveProperty('p256dh_key');
    expect(res.body[0]).not.toHaveProperty('auth_key');
    expect(res.body[0]).not.toHaveProperty('endpoint');
  });

  it('GET /devices is user-scoped (cross-user isolation)', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    await request(makeApp(u1)).post('/api/web-push/subscribe').send(validBody);
    const res = await request(makeApp(u2)).get('/api/web-push/devices');
    expect(res.body).toEqual([]);
  });

  it('DELETE /subscriptions/:id removes the row', async () => {
    const u = seedUser();
    const create = await request(makeApp(u)).post('/api/web-push/subscribe').send(validBody);
    const del = await request(makeApp(u)).delete(`/api/web-push/subscriptions/${create.body.id}`);
    expect(del.status).toBe(204);
    const list = await request(makeApp(u)).get('/api/web-push/devices');
    expect(list.body).toEqual([]);
  });

  it('DELETE /subscriptions/:id of another user returns 404 (no existence leak)', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const create = await request(makeApp(u1)).post('/api/web-push/subscribe').send(validBody);
    const del = await request(makeApp(u2)).delete(`/api/web-push/subscriptions/${create.body.id}`);
    expect(del.status).toBe(404);
  });
});
