import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

// Mock the web-push library at the module level so our sender talks to a stub.
// vi.hoisted ensures the mock vars are available when the factory runs (which
// is hoisted to top of file by vitest's transform).
const { sendNotificationMock, setVapidDetailsMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(),
  setVapidDetailsMock: vi.fn(),
}));
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: setVapidDetailsMock,
    sendNotification: sendNotificationMock,
  },
  setVapidDetails: setVapidDetailsMock,
  sendNotification: sendNotificationMock,
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { upsertWebPushSubscription, getActiveWebPushSubscriptionsForUser } from '../db/queries.js';
import { sendWebPushPriceAlert, sendWebPushBasketAlert } from './web-push.js';
import type { Tracker } from '../db/queries.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function makeTracker(userId: number, overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 1, name: 'Samsung 990 Pro 4TB', url: 'https://amazon.com/dp/A',
    threshold_price: 300, check_interval_minutes: 60, css_selector: null,
    last_price: 279, last_checked_at: '2026-05-05 00:00:00', last_error: null,
    consecutive_failures: 0, status: 'active' as const,
    created_at: '2026-05-01', updated_at: '2026-05-05', user_id: userId,
    normalized_url: null, jitter_minutes: 0,
    ai_verdict_tier: null, ai_verdict_reason: null, ai_verdict_reason_key: null,
    ai_verdict_updated_at: null, ai_summary: null, ai_summary_updated_at: null,
    ai_signals_json: null, ai_failure_count: 0,
    ...overrides,
  } as Tracker;
}

function makeProject(userId: number): Project {
  return {
    id: 1, user_id: userId, name: 'NAS Build', target_total: 1200,
    status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05',
  };
}

function makeBasket(): BasketState {
  return {
    total: 1189, target_total: 1200, item_count: 8,
    items_with_price: 8, items_below_ceiling: 8,
    eligible: true, ineligible_reason: null,
  };
}

function makeMembers(): BasketMember[] {
  return [
    { tracker_id: 1, tracker_name: 'SSD', last_price: 279, tracker_status: 'active',
      per_item_ceiling: null, position: 0, ai_verdict_tier: 'BUY', ai_verdict_reason: null },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'pub';
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'priv';
  process.env.WEB_PUSH_SUBJECT = 'mailto:test@example.com';
});

describe('sendWebPushPriceAlert', () => {
  it('returns true and POSTs to every active subscription on success', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E1', p256dh_key: 'P', auth_key: 'A', device_label: 'Mac', user_agent: null });
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://web.push.apple.com/E2', p256dh_key: 'P', auth_key: 'A', device_label: 'iPhone', user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    const ok = await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    expect(ok).toBe(true);
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    expect(getActiveWebPushSubscriptionsForUser(u)).toHaveLength(2);
  });

  it('payload includes title, body, url, tag', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E1', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, '12-month low');

    const arg = sendNotificationMock.mock.calls[0][1];
    const payload = JSON.parse(arg);
    expect(payload.title).toContain('Samsung 990 Pro 4TB');
    expect(payload.title).toContain('279');
    expect(payload.body).toContain('12-month low');
    expect(payload.url).toBe('/tracker/1');
    expect(payload.tag).toBe('tracker-1-price');
  });

  it('410 response → deletes the stale subscription', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/STALE', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/OK', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock
      .mockImplementationOnce(() => { const e: { statusCode?: number } = new Error('Gone'); e.statusCode = 410; throw e; })
      .mockResolvedValueOnce({ statusCode: 201 });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    const remaining = getActiveWebPushSubscriptionsForUser(u);
    expect(remaining.map(r => r.endpoint.split('/').pop())).toEqual(['OK']);
  });

  it('404 response → deletes the stale subscription', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/STALE', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockImplementationOnce(() => { const e: { statusCode?: number } = new Error('Not Found'); e.statusCode = 404; throw e; });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    expect(getActiveWebPushSubscriptionsForUser(u)).toHaveLength(0);
  });

  it('5xx response → keeps subscription, logs but continues', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockImplementationOnce(() => { const e: { statusCode?: number } = new Error('Internal'); e.statusCode = 503; throw e; });

    const ok = await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    expect(ok).toBe(false);  // dispatch reported failure
    expect(getActiveWebPushSubscriptionsForUser(u)).toHaveLength(1);  // subscription survives
  });

  it('returns false when user has no subscriptions', async () => {
    const u = seedUser();
    const ok = await sendWebPushPriceAlert(makeTracker(u), 279, u, null);
    expect(ok).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('returns false (no-op) when VAPID keys are missing', async () => {
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = '';
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });

    const ok = await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    expect(ok).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('HIGH confidence prefixes body with green emoji and appends reasons', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, null, {
      level: 'HIGH', reasons: ['12-month low', 'typically holds ~5 days'],
    });

    const payload = JSON.parse(sendNotificationMock.mock.calls[0][1]);
    expect(payload.body.startsWith('🟢 ')).toBe(true);
    expect(payload.body).toContain('12-month low · typically holds ~5 days');
  });

  it('MEDIUM confidence prefixes body with yellow emoji', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, null, {
      level: 'MEDIUM', reasons: ['30-day low'],
    });

    const payload = JSON.parse(sendNotificationMock.mock.calls[0][1]);
    expect(payload.body.startsWith('🟡 ')).toBe(true);
  });

  it('LOW confidence body has no emoji prefix', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, null, {
      level: 'LOW', reasons: ['typically holds ~3 days'],
    });

    const payload = JSON.parse(sendNotificationMock.mock.calls[0][1]);
    expect(payload.body.startsWith('🟢')).toBe(false);
    expect(payload.body.startsWith('🟡')).toBe(false);
    expect(payload.body).toContain('typically holds ~3 days');
  });

  it('null confidence renders identically to today', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, '12-month low', null);

    const payload = JSON.parse(sendNotificationMock.mock.calls[0][1]);
    expect(payload.body.startsWith('🟢')).toBe(false);
    expect(payload.body.startsWith('🟡')).toBe(false);
    expect(payload.body).toContain('12-month low');
  });

  it('one device 410 + one device success → returns true (any-success semantics)', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/STALE', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/OK', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock
      .mockImplementationOnce(() => { const e: { statusCode?: number } = new Error('Gone'); e.statusCode = 410; throw e; })
      .mockResolvedValueOnce({ statusCode: 201 });

    const ok = await sendWebPushPriceAlert(makeTracker(u), 279, u, null);
    expect(ok).toBe(true);
  });
});

describe('sendWebPushBasketAlert', () => {
  it('payload includes basket title, body, project URL, tag', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    await sendWebPushBasketAlert(makeProject(u), makeBasket(), makeMembers(), u, null);

    const arg = sendNotificationMock.mock.calls[0][1];
    const payload = JSON.parse(arg);
    expect(payload.title).toContain('NAS Build');
    expect(payload.body).toContain('1189');
    expect(payload.url).toBe('/projects/1');
    expect(payload.tag).toBe('project-1-basket');
  });

  it('returns false when basket.total is null', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'https://fcm.googleapis.com/fcm/send/E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    const nullBasket: BasketState = { ...makeBasket(), total: null };

    const ok = await sendWebPushBasketAlert(makeProject(u), nullBasket, makeMembers(), u, null);

    expect(ok).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
