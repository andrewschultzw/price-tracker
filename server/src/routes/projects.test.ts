import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import projectsRoutes from './projects.js';

// Simple test middleware that pretends a user is authenticated.
function makeApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', (req, _res, next) => {
    (req as { user?: { userId: number; role: string } }).user = { userId, role: 'user' };
    next();
  }, projectsRoutes);
  return app;
}

function seedUser(email = 't@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'T', 'user', 1)`
  ).run(email).lastInsertRowid);
}

function seedTracker(userId: number, name = 'X', lastPrice: number | null = 50): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 100, 'active', 60, 0, ?)`
  ).run(name, `https://example/${name}`, userId, lastPrice).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('projects routes', () => {
  it('GET / returns empty list for new user', async () => {
    const u = seedUser();
    const res = await request(makeApp(u)).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST / creates a project and returns 201 + body', async () => {
    const u = seedUser();
    const res = await request(makeApp(u))
      .post('/api/projects')
      .send({ name: 'NAS', target_total: 1200 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('NAS');
    expect(res.body.target_total).toBe(1200);
    expect(res.body.status).toBe('active');
  });

  it('POST / rejects missing name', async () => {
    const u = seedUser();
    const res = await request(makeApp(u))
      .post('/api/projects')
      .send({ target_total: 1200 });
    expect(res.status).toBe(400);
  });

  it('POST / rejects negative target_total', async () => {
    const u = seedUser();
    const res = await request(makeApp(u))
      .post('/api/projects')
      .send({ name: 'NAS', target_total: -5 });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns 404 for other-user project (cross-user isolation)', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const create = await request(makeApp(u1))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const projectId = create.body.id;

    const res = await request(makeApp(u2)).get(`/api/projects/${projectId}`);
    expect(res.status).toBe(404);
  });

  it('GET /:id returns project + members + recent_notifications', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`)
      .send({ tracker_id: t });

    const res = await request(makeApp(u)).get(`/api/projects/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('P');
    expect(res.body.members).toHaveLength(1);
    expect(res.body.recent_notifications).toEqual([]);
  });

  it('PATCH /:id partial update (status only)', async () => {
    const u = seedUser();
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    const res = await request(makeApp(u))
      .patch(`/api/projects/${id}`)
      .send({ status: 'archived' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('archived');
    expect(res.body.name).toBe('P');               // unchanged
    expect(res.body.target_total).toBe(100);        // unchanged
  });

  it('DELETE /:id returns 204 and the project is gone', async () => {
    const u = seedUser();
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    const del = await request(makeApp(u)).delete(`/api/projects/${id}`);
    expect(del.status).toBe(204);
    const get = await request(makeApp(u)).get(`/api/projects/${id}`);
    expect(get.status).toBe(404);
  });

  it('POST /:id/trackers — duplicate add returns 409', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t });
    const dup = await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t });
    expect(dup.status).toBe(409);
  });

  it('POST /:id/trackers — cross-user tracker returns 404', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = seedTracker(u2);                      // tracker owned by u2
    const create = await request(makeApp(u1))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    const res = await request(makeApp(u1))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t });
    expect(res.status).toBe(404);                   // don't leak existence
  });

  it('POST /:id/trackers — stores per_item_ceiling', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    const res = await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`)
      .send({ tracker_id: t, per_item_ceiling: 30 });
    expect(res.status).toBe(201);
    expect(res.body[0].per_item_ceiling).toBe(30);
  });

  it('DELETE /:id/trackers/:trackerId removes the membership', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t });
    const del = await request(makeApp(u))
      .delete(`/api/projects/${id}/trackers/${t}`);
    expect(del.status).toBe(204);
    const get = await request(makeApp(u)).get(`/api/projects/${id}`);
    expect(get.body.members).toHaveLength(0);
  });

  it('PATCH /:id/trackers/:trackerId updates ceiling', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t, per_item_ceiling: 30 });
    const patch = await request(makeApp(u))
      .patch(`/api/projects/${id}/trackers/${t}`).send({ per_item_ceiling: 25 });
    expect(patch.status).toBe(200);
    expect(patch.body[0].per_item_ceiling).toBe(25);
  });
});
