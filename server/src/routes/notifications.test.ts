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
import notificationsRouter from './notifications.js';

function seedUser(email: string): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function seedTracker(userId: number): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, status, check_interval_minutes)
     VALUES ('T', 'https://example.com/x', ?, 'active', 60)`,
  ).run(userId).lastInsertRowid);
}

function seedNotification(trackerId: number, readAt: string | null = null): number {
  return Number(getDb().prepare(
    `INSERT INTO notifications (tracker_id, price, threshold_price, read_at)
     VALUES (?, 40, 50, ?)`,
  ).run(trackerId, readAt).lastInsertRowid);
}

function authCookie(userId: number): string {
  const token = signAccessToken({ userId, email: 'x@x.com', role: 'user' });
  return `access_token=${token}`;
}

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/notifications', authMiddleware, notificationsRouter);
  return app;
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('GET /api/notifications/unread-count', () => {
  it('counts only the requesting user’s unread rows', async () => {
    const me = seedUser('me@example.com');
    const other = seedUser('other@example.com');
    const myTracker = seedTracker(me);
    const otherTracker = seedTracker(other);
    seedNotification(myTracker);                       // mine, unread
    seedNotification(myTracker, '2026-07-01 00:00:00'); // mine, read
    seedNotification(otherTracker);                     // someone else's, unread

    const res = await request(makeApp())
      .get('/api/notifications/unread-count')
      .set('Cookie', authCookie(me));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 1 });
  });

  it('requires auth', async () => {
    const res = await request(makeApp()).get('/api/notifications/unread-count');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/notifications/mark-read', () => {
  it('flips only the requesting user’s unread rows and is idempotent', async () => {
    const me = seedUser('me@example.com');
    const other = seedUser('other@example.com');
    const myTracker = seedTracker(me);
    const otherTracker = seedTracker(other);
    seedNotification(myTracker);
    seedNotification(myTracker);
    const otherId = seedNotification(otherTracker);

    const app = makeApp();
    const first = await request(app)
      .post('/api/notifications/mark-read')
      .set('Cookie', authCookie(me));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ marked: 2 });

    // Idempotent: nothing left to flip.
    const second = await request(app)
      .post('/api/notifications/mark-read')
      .set('Cookie', authCookie(me));
    expect(second.body).toEqual({ marked: 0 });

    // The other user's row is untouched.
    const otherRow = getDb().prepare('SELECT read_at FROM notifications WHERE id = ?')
      .get(otherId) as { read_at: string | null };
    expect(otherRow.read_at).toBeNull();

    // And their badge count still shows it.
    const otherCount = await request(app)
      .get('/api/notifications/unread-count')
      .set('Cookie', authCookie(other));
    expect(otherCount.body).toEqual({ count: 1 });
  });
});
