import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { createInviteCode, getUserById } from '../db/user-queries.js';
import { setSetting } from '../db/queries.js';
import authRoutes from './auth.js';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', authRoutes);
  return app;
}

function seedUser(email: string, displayName: string = 'Test User'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', ?, 'user', 1)`,
  ).run(email, displayName).lastInsertRowid);
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('GET /api/auth/invite-info/:code', () => {
  it('returns 404 for unknown code', async () => {
    const res = await request(makeApp())
      .get('/api/auth/invite-info/unknown-code');
    expect(res.status).toBe(404);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBe('not_found');
  });

  it('returns 409 for already-used code', async () => {
    const inviter = seedUser('inviter@example.com', 'Alice');
    const invite = createInviteCode(inviter);
    // Mark it as used
    const redeemer = seedUser('redeemer@example.com', 'Bob');
    getDb().prepare('UPDATE invite_codes SET used_by = ? WHERE code = ?')
      .run(redeemer, invite.code);

    const res = await request(makeApp())
      .get(`/api/auth/invite-info/${invite.code}`);
    expect(res.status).toBe(409);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBe('already_used');
  });

  it('returns 410 for expired code', async () => {
    const inviter = seedUser('inviter@example.com', 'Alice');
    // Create an expired invite (expiresAt in the past, without the Z suffix for DB storage)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('Z', '');
    const invite = createInviteCode(inviter, yesterday);

    const res = await request(makeApp())
      .get(`/api/auth/invite-info/${invite.code}`);
    expect(res.status).toBe(410);
    expect(res.body.valid).toBe(false);
    expect(res.body.reason).toBe('expired');
  });

  it('returns valid=true with inviter_name when share_display_name is true', async () => {
    const inviter = seedUser('inviter@example.com', 'Alice');
    setSetting('share_display_name', 'true', inviter);
    const invite = createInviteCode(inviter);

    const res = await request(makeApp())
      .get(`/api/auth/invite-info/${invite.code}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.inviter_name).toBe('Alice');
  });

  it('returns valid=true with inviter_name=null when share_display_name is not true', async () => {
    const inviter = seedUser('inviter@example.com', 'Alice');
    setSetting('share_display_name', 'false', inviter);
    const invite = createInviteCode(inviter);

    const res = await request(makeApp())
      .get(`/api/auth/invite-info/${invite.code}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.inviter_name).toBeNull();
  });

  it('returns valid=true with inviter_name=null when share_display_name is not set', async () => {
    const inviter = seedUser('inviter@example.com', 'Alice');
    // Don't set share_display_name
    const invite = createInviteCode(inviter);

    const res = await request(makeApp())
      .get(`/api/auth/invite-info/${invite.code}`);
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.inviter_name).toBeNull();
  });
});
