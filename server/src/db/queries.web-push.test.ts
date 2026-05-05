import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  upsertWebPushSubscription,
  getActiveWebPushSubscriptionsForUser,
  getWebPushSubscriptionById,
  deleteWebPushSubscription,
  deleteWebPushSubscriptionByEndpoint,
  updateWebPushLastUsedAt,
} from './queries.js';

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

describe('web push subscription queries', () => {
  it('upsert inserts a new row', () => {
    const u = seedUser();
    const id = upsertWebPushSubscription({
      user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A',
      device_label: 'Mac · Chrome', user_agent: 'Mozilla/5.0',
    });
    expect(id).toBeGreaterThan(0);
    const sub = getWebPushSubscriptionById(id);
    expect(sub?.endpoint).toBe('E');
    expect(sub?.device_label).toBe('Mac · Chrome');
  });

  it('upsert with same endpoint UPDATEs in place (no duplicate row)', () => {
    const u = seedUser();
    const id1 = upsertWebPushSubscription({
      user_id: u, endpoint: 'E', p256dh_key: 'P1', auth_key: 'A1',
      device_label: 'Old', user_agent: null,
    });
    const id2 = upsertWebPushSubscription({
      user_id: u, endpoint: 'E', p256dh_key: 'P2', auth_key: 'A2',
      device_label: 'New', user_agent: null,
    });
    expect(id1).toBe(id2);
    const all = getActiveWebPushSubscriptionsForUser(u);
    expect(all).toHaveLength(1);
    expect(all[0].p256dh_key).toBe('P2');
    expect(all[0].device_label).toBe('New');
  });

  it('getActiveWebPushSubscriptionsForUser returns user-scoped rows in created_at order', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'A', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    await new Promise(r => setTimeout(r, 1100));  // distinct created_at (datetime('now') has 1s resolution)
    upsertWebPushSubscription({ user_id: u, endpoint: 'B', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    const rows = getActiveWebPushSubscriptionsForUser(u);
    expect(rows.map(r => r.endpoint)).toEqual(['A', 'B']);
  });

  it('cross-user isolation in getActiveWebPushSubscriptionsForUser', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    upsertWebPushSubscription({ user_id: u1, endpoint: 'E1', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    upsertWebPushSubscription({ user_id: u2, endpoint: 'E2', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    expect(getActiveWebPushSubscriptionsForUser(u1).map(r => r.endpoint)).toEqual(['E1']);
    expect(getActiveWebPushSubscriptionsForUser(u2).map(r => r.endpoint)).toEqual(['E2']);
  });

  it('deleteWebPushSubscription removes by id', () => {
    const u = seedUser();
    const id = upsertWebPushSubscription({ user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    deleteWebPushSubscription(id);
    expect(getWebPushSubscriptionById(id)).toBeUndefined();
  });

  it('deleteWebPushSubscriptionByEndpoint removes by endpoint (used by 410 cleanup)', () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'STALE', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    upsertWebPushSubscription({ user_id: u, endpoint: 'OK', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    deleteWebPushSubscriptionByEndpoint('STALE');
    expect(getActiveWebPushSubscriptionsForUser(u).map(r => r.endpoint)).toEqual(['OK']);
  });

  it('updateWebPushLastUsedAt sets the timestamp', () => {
    const u = seedUser();
    const id = upsertWebPushSubscription({ user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    expect(getWebPushSubscriptionById(id)?.last_used_at).toBeNull();
    updateWebPushLastUsedAt(id);
    const sub = getWebPushSubscriptionById(id);
    expect(sub?.last_used_at).toBeTruthy();
  });

  it('UPSERT does not transfer ownership when a different user uses the same endpoint', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    upsertWebPushSubscription({ user_id: u1, endpoint: 'SAME', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    // ON CONFLICT only updates keys + label + UA, NOT user_id.
    upsertWebPushSubscription({ user_id: u2, endpoint: 'SAME', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    expect(getActiveWebPushSubscriptionsForUser(u1)).toHaveLength(1);
    expect(getActiveWebPushSubscriptionsForUser(u2)).toHaveLength(0);
  });
});
