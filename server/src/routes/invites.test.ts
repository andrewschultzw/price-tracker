import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { authMiddleware } from '../auth/middleware.js';
import { createInviteCode } from '../db/user-queries.js';
import inviteRoutes from './invites.js';
import { signAccessToken } from '../auth/tokens.js';
import { config } from '../config.js';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/invites', authMiddleware, inviteRoutes);
  return app;
}

function seedUser(email: string, role: 'user' | 'admin' = 'user'): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO users (email, password_hash, display_name, role, is_active)
         VALUES (?, 'h', 'A', ?, 1)`,
      )
      .run(email, role).lastInsertRowid,
  );
}

function authCookie(userId: number, role: 'user' | 'admin' = 'user'): string {
  const token = signAccessToken({ userId, email: 'x@x.com', role });
  return `access_token=${token}`;
}

/**
 * Seed an active (unused, non-expired) invite directly into the DB.
 * Bypasses createInviteCode so we can keep tests independent of the
 * default-expiry path under test elsewhere.
 */
function seedActiveInvite(createdBy: number, code: string): number {
  // 7 days from now, naive (no Z) — matches the storage convention.
  const expiresAt = new Date(Date.now() + 7 * 86_400_000)
    .toISOString()
    .replace('Z', '');
  return Number(
    getDb()
      .prepare(
        `INSERT INTO invite_codes (code, created_by, used_by, expires_at)
         VALUES (?, ?, NULL, ?)`,
      )
      .run(code, createdBy, expiresAt).lastInsertRowid,
  );
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('POST /api/invites', () => {
  it('returns 401 when unauthenticated', async () => {
    const res = await request(makeApp()).post('/api/invites').send({});
    expect(res.status).toBe(401);
  });

  it('creates an invite for non-admin under quota (0 active)', async () => {
    const u = seedUser('a@x.com');
    const res = await request(makeApp())
      .post('/api/invites')
      .set('Cookie', authCookie(u))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.created_by).toBe(u);
    expect(typeof res.body.code).toBe('string');
    expect(res.body.used_by).toBeNull();
  });

  it('returns 429 for non-admin AT quota (3 active)', async () => {
    const u = seedUser('a@x.com');
    seedActiveInvite(u, 'c1');
    seedActiveInvite(u, 'c2');
    seedActiveInvite(u, 'c3');
    const res = await request(makeApp())
      .post('/api/invites')
      .set('Cookie', authCookie(u))
      .send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Invite quota reached');
    expect(res.body.used).toBe(3);
    expect(res.body.limit).toBe(config.defaultInviteQuota);
  });

  it('admin bypasses quota (3 active still allowed)', async () => {
    const a = seedUser('admin@x.com', 'admin');
    seedActiveInvite(a, 'c1');
    seedActiveInvite(a, 'c2');
    seedActiveInvite(a, 'c3');
    const res = await request(makeApp())
      .post('/api/invites')
      .set('Cookie', authCookie(a, 'admin'))
      .send({});
    expect(res.status).toBe(201);
  });

  it('defaults expires_at to ~30 days when omitted', async () => {
    const u = seedUser('a@x.com');
    const res = await request(makeApp())
      .post('/api/invites')
      .set('Cookie', authCookie(u))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.expires_at).toBeTruthy();
    const expiresMs = new Date(res.body.expires_at + 'Z').getTime();
    const expected = Date.now() + config.defaultInviteExpiryDays * 86_400_000;
    // Allow a generous 60s skew for test execution time.
    expect(Math.abs(expiresMs - expected)).toBeLessThan(60_000);
  });
});

describe('GET /api/invites', () => {
  it("returns the user's own codes only (no other users')", async () => {
    const a = seedUser('a@x.com');
    const b = seedUser('b@x.com');
    seedActiveInvite(a, 'a1');
    seedActiveInvite(a, 'a2');
    seedActiveInvite(b, 'b1');

    const res = await request(makeApp())
      .get('/api/invites')
      .set('Cookie', authCookie(a));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const codes = res.body.map((r: { code: string }) => r.code).sort();
    expect(codes).toEqual(['a1', 'a2']);
  });
});

describe('GET /api/invites/quota', () => {
  it('returns {used, remaining, default} for non-admin', async () => {
    const u = seedUser('a@x.com');
    seedActiveInvite(u, 'c1');
    const res = await request(makeApp())
      .get('/api/invites/quota')
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      used: 1,
      remaining: config.defaultInviteQuota - 1,
      default: config.defaultInviteQuota,
    });
  });

  it('returns remaining=null for admin (unlimited)', async () => {
    const a = seedUser('admin@x.com', 'admin');
    const res = await request(makeApp())
      .get('/api/invites/quota')
      .set('Cookie', authCookie(a, 'admin'));
    expect(res.status).toBe(200);
    expect(res.body.remaining).toBeNull();
    expect(res.body.default).toBe(config.defaultInviteQuota);
  });
});

describe('DELETE /api/invites/:id', () => {
  it("revokes the user's own unused invite", async () => {
    const u = seedUser('a@x.com');
    const id = seedActiveInvite(u, 'mine');
    const res = await request(makeApp())
      .delete(`/api/invites/${id}`)
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(204);
  });

  it("returns 404 when the invite is already used (idempotent contract)", async () => {
    const u = seedUser('a@x.com');
    const redeemer = seedUser('r@x.com');
    const invite = createInviteCode(u);
    getDb()
      .prepare('UPDATE invite_codes SET used_by = ? WHERE id = ?')
      .run(redeemer, invite.id);
    const res = await request(makeApp())
      .delete(`/api/invites/${invite.id}`)
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting another user's invite (no existence leak)", async () => {
    const a = seedUser('a@x.com');
    const b = seedUser('b@x.com');
    const id = seedActiveInvite(a, 'a1');
    const res = await request(makeApp())
      .delete(`/api/invites/${id}`)
      .set('Cookie', authCookie(b));
    expect(res.status).toBe(404);
    // And it's still there for the real owner.
    const stillThere = getDb()
      .prepare('SELECT id FROM invite_codes WHERE id = ?')
      .get(id) as { id: number } | undefined;
    expect(stillThere?.id).toBe(id);
  });
});
