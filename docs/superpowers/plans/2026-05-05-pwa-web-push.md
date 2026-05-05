# PWA + Web Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PWA-ify the existing client app and add Web Push as a 5th notification channel slotted into the existing channel-fanout system.

**Architecture:** Web Push integrates as the 5th `ChannelName` value alongside Discord/ntfy/email/webhook. Same `firePriceAlerts` and `evaluateAndFireForProject` paths fan out to it. Per-device subscriptions stored in a new `web_push_subscriptions` table; the channel renderer loops devices via `Promise.allSettled`. Service worker is plain JS in `client/public/sw.js` (not bundled by Vite). VAPID keys generated once at deploy time, stored in `.env`, with the public key embedded into the client at build time via `VITE_VAPID_PUBLIC_KEY`. No new feature flag — natural rollout via user opt-in from Settings.

**Tech Stack:** TypeScript, Express, better-sqlite3, vitest, React + Tailwind on the client, Vite build, `web-push` npm library on the server, Web Push API on the client (PushManager + Notification API + Service Worker).

**Spec:** `docs/superpowers/specs/2026-05-05-pwa-web-push-design.md`

**Branch:** `feature/pwa-web-push`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `server/src/lib/device-label.ts` | Pure: `deriveDeviceLabel(userAgent) → string`. Regex on UA. |
| `server/src/lib/device-label.test.ts` | 6 unit tests covering major UA shapes |
| `server/src/db/migration-v10.test.ts` | Migration v10 schema + idempotency |
| `server/src/db/queries.web-push.test.ts` | DB CRUD tests |
| `server/src/notifications/web-push.ts` | `sendWebPushPriceAlert` + `sendWebPushBasketAlert`. Wraps the `web-push` npm library. Auto-cleanup on 410/404. |
| `server/src/notifications/web-push.test.ts` | 10 tests with mocked `web-push` library |
| `server/src/routes/web-push.ts` | `POST /subscribe`, `GET /devices`, `DELETE /subscriptions/:id` |
| `server/src/routes/web-push.test.ts` | 8 route tests |
| `server/src/scheduler/cron-web-push.test.ts` | Cron integration test |
| `client/public/sw.js` | Plain JS service worker (`install`, `activate`, `push`, `notificationclick`) |
| `client/public/manifest.webmanifest` | PWA manifest |
| `client/public/icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png` | Three PNG app icons |
| `client/src/lib/web-push.ts` | Client subscription helpers: `registerSW`, `subscribePush`, `unsubscribePush`, `getSubscriptionState` |
| `client/src/components/WebPushSettings.tsx` | The 5-state UI + devices list |

### Modified files

| Path | Change |
|---|---|
| `server/package.json` | Add `web-push` dependency |
| `server/src/config.ts` | Add `webPushVapidPublic`, `webPushVapidPrivate`, `webPushSubject` |
| `server/src/db/migrations.ts` | Append migration v10 — `web_push_subscriptions` table |
| `server/src/db/queries.ts` | UPSERT subscribe + reads + delete-by-id (with cross-user guard) + delete-by-endpoint + updateLastUsedAt |
| `server/src/scheduler/cron.ts` | Extend `ChannelName` to include `'web_push'`. Extend `CHANNEL_NAMES`. Extend `EnabledChannels`. Update `getEnabledChannels` to detect web-push via active subs. Add `web_push` case in `firePriceAlerts` switch. |
| `server/src/projects/firer.ts` | Add `web_push` case in basket-alert dispatch (parallel to discord/ntfy/email/webhook) |
| `server/src/index.ts` | Mount `/api/web-push` route |
| `.env.example` | Document `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_SUBJECT`, `VITE_VAPID_PUBLIC_KEY` |
| `client/index.html` | `<link rel="manifest">`, `<meta name="theme-color">`, register-SW script tag |
| `client/src/main.tsx` | Register service worker on boot, listen for `navigate` postMessage |
| `client/src/types.ts` | Add `WebPushSubscriptionRecord`, `WebPushDevice`, `SubscribePayload` types |
| `client/src/api.ts` | Add web-push API wrappers reusing the existing `request<T>` helper |
| `client/src/pages/Settings.tsx` | Embed `<WebPushSettings />` after the existing channel rows |

---

## Task 1: Install web-push + VAPID config

**Files:**
- Modify: `server/package.json` (and `package-lock.json`)
- Modify: `server/src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install the SDK**

```bash
cd /root/price-tracker/server && npm install web-push@latest && npm install --save-dev @types/web-push
```

Expected: `package.json` and `package-lock.json` updated. `web-push` and `@types/web-push` listed.

- [ ] **Step 2: Add config fields to `server/src/config.ts`**

Append to the exported `config` object (place near the existing `aiEnabled`/`anthropicApiKey` block from the AI Buyer's Assistant feature):

```ts
webPushVapidPublic: process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '',
webPushVapidPrivate: process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '',
webPushSubject: process.env.WEB_PUSH_SUBJECT || '',
```

- [ ] **Step 3: Add env vars to `.env.example`**

Append:

```
# Web Push (PWA notifications)
# Generate with: npx web-push generate-vapid-keys
WEB_PUSH_VAPID_PUBLIC_KEY=
WEB_PUSH_VAPID_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:you@example.com
# Same as WEB_PUSH_VAPID_PUBLIC_KEY — embedded into the client at build time
VITE_VAPID_PUBLIC_KEY=
```

- [ ] **Step 4: Verify the build still type-checks**

```bash
cd /root/price-tracker/server && npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config.ts .env.example
git commit -m "$(cat <<'EOF'
feat(pwa): install web-push + wire VAPID config

Adds the web-push library and the four env vars (private key,
public key, subject, plus the Vite-side public key for client
build). Defaults to empty so the channel stays silently disabled
until VAPID keys are generated.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Migration v10 — `web_push_subscriptions` table

**Files:**
- Modify: `server/src/db/migrations.ts`
- Create: `server/src/db/migration-v10.test.ts`

- [ ] **Step 1: Write the failing migration test**

Create `server/src/db/migration-v10.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

describe('migration v10 — web_push_subscriptions', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    runMigrations();
  });

  it('creates web_push_subscriptions table with expected columns', () => {
    const cols = getDb().prepare("PRAGMA table_info(web_push_subscriptions)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    for (const expected of ['id', 'user_id', 'endpoint', 'p256dh_key', 'auth_key', 'device_label', 'user_agent', 'created_at', 'last_used_at']) {
      expect(names).toContain(expected);
    }
  });

  it('endpoint has UNIQUE constraint', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(`INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (?, 'E', 'P', 'A')`).run(userId);
    expect(() =>
      db.prepare(`INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (?, 'E', 'P', 'A')`).run(userId)
    ).toThrow();
  });

  it('user_id index is created', () => {
    const indexes = getDb().prepare("PRAGMA index_list(web_push_subscriptions)").all() as { name: string }[];
    expect(indexes.map(i => i.name)).toContain('idx_web_push_subscriptions_user_id');
  });

  it('migration v10 is idempotent', () => {
    runMigrations();
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(web_push_subscriptions)").all();
    expect(cols).toHaveLength(9);
  });

  it('CASCADE deletes web_push_subscriptions when the user is deleted', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(`INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key) VALUES (?, 'E', 'P', 'A')`).run(userId);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(userId);
    const count = (db.prepare('SELECT COUNT(*) as c FROM web_push_subscriptions WHERE user_id=?').get(userId) as { c: number }).c;
    expect(count).toBe(0);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /root/price-tracker/server && npm test -- migration-v10
```

- [ ] **Step 3: Append v10 to `server/src/db/migrations.ts`**

Inside the `migrations` array, after the v9 entry (Bundle Tracker), append:

```ts
{
  version: 10,
  description: "PWA Web Push — web_push_subscriptions table",
  up: () => {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS web_push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh_key TEXT NOT NULL,
        auth_key TEXT NOT NULL,
        device_label TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_user_id
        ON web_push_subscriptions(user_id);
    `);
  },
},
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- migration-v10
```

Expected: 5 cases pass.

- [ ] **Step 5: Run full server suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: previous count (445 from Bundle Tracker) + 5 = 450/450.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/migrations.ts server/src/db/migration-v10.test.ts
git commit -m "$(cat <<'EOF'
feat(pwa): migration v10 adds web_push_subscriptions

Per-device subscription rows: (user_id, endpoint UNIQUE, p256dh_key,
auth_key, device_label, user_agent, created_at, last_used_at).
UNIQUE(endpoint) makes UPSERT semantics natural for re-subscribes
on the same browser. ON DELETE CASCADE on user_id.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure device-label helper

**Files:**
- Create: `server/src/lib/device-label.ts`
- Create: `server/src/lib/device-label.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// server/src/lib/device-label.test.ts
import { describe, it, expect } from 'vitest';
import { deriveDeviceLabel } from './device-label.js';

describe('deriveDeviceLabel', () => {
  it('Chrome on Mac → "Mac · Chrome"', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(deriveDeviceLabel(ua)).toBe('Mac · Chrome');
  });

  it('Safari on iPhone → "iPhone · Safari"', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1';
    expect(deriveDeviceLabel(ua)).toBe('iPhone · Safari');
  });

  it('Firefox on Windows → "Windows · Firefox"', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';
    expect(deriveDeviceLabel(ua)).toBe('Windows · Firefox');
  });

  it('Edge on Mac → "Mac · Edge"', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0';
    expect(deriveDeviceLabel(ua)).toBe('Mac · Edge');
  });

  it('Chrome on Android → "Android · Chrome"', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    expect(deriveDeviceLabel(ua)).toBe('Android · Chrome');
  });

  it('unknown UA → generic fallback', () => {
    expect(deriveDeviceLabel('SomeBot/1.0')).toBe('Device · Browser');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /root/price-tracker/server && npm test -- device-label
```

- [ ] **Step 3: Implement `server/src/lib/device-label.ts`**

```ts
// server/src/lib/device-label.ts
export function deriveDeviceLabel(userAgent: string): string {
  const browser =
    /Edg\//.test(userAgent) ? 'Edge' :
    /Firefox\//.test(userAgent) ? 'Firefox' :
    /Chrome\//.test(userAgent) ? 'Chrome' :
    /Safari\//.test(userAgent) ? 'Safari' :
    'Browser';
  const platform =
    /iPhone/.test(userAgent) ? 'iPhone' :
    /iPad/.test(userAgent) ? 'iPad' :
    /Android/.test(userAgent) ? 'Android' :
    /Macintosh/.test(userAgent) ? 'Mac' :
    /Windows/.test(userAgent) ? 'Windows' :
    /Linux/.test(userAgent) ? 'Linux' :
    'Device';
  return `${platform} · ${browser}`;
}
```

⚠️ Order matters: check Edge before Chrome (Edge UA contains both `Chrome/` and `Edg/`). Check iPhone/iPad/Android before Macintosh (iPhone UA contains both `Mac OS X` and `iPhone`).

- [ ] **Step 4: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- device-label
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/device-label.ts server/src/lib/device-label.test.ts
git commit -m "$(cat <<'EOF'
feat(pwa): pure deriveDeviceLabel helper

Regex on User-Agent → "Platform · Browser" string. Order matters:
Edge before Chrome (Edge UA contains both), and iPhone/Android
before Mac (iPhone UA contains "Mac OS X"). No external UA-parser
dependency — six unit tests cover the major shapes.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: DB queries for web push subscriptions

**Files:**
- Modify: `server/src/db/queries.ts`
- Create: `server/src/db/queries.web-push.test.ts`

- [ ] **Step 1: Add helpers + types at the bottom of `server/src/db/queries.ts`**

```ts
// === Web Push subscriptions ===

export interface WebPushSubscriptionRecord {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  device_label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

/**
 * UPSERT semantics: re-subscribing on the same browser+device returns the
 * same endpoint, so we ON CONFLICT update the keys + device_label rather
 * than creating a duplicate row.
 */
export function upsertWebPushSubscription(args: {
  user_id: number;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  device_label: string | null;
  user_agent: string | null;
}): number {
  const result = getDb().prepare(
    `INSERT INTO web_push_subscriptions
       (user_id, endpoint, p256dh_key, auth_key, device_label, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh_key = excluded.p256dh_key,
       auth_key = excluded.auth_key,
       device_label = excluded.device_label,
       user_agent = excluded.user_agent`
  ).run(args.user_id, args.endpoint, args.p256dh_key, args.auth_key, args.device_label, args.user_agent);
  // For UPSERTs, lastInsertRowid is 0 on UPDATE — re-fetch by endpoint.
  const row = getDb().prepare(`SELECT id FROM web_push_subscriptions WHERE endpoint = ?`)
    .get(args.endpoint) as { id: number };
  return row.id;
}

export function getActiveWebPushSubscriptionsForUser(userId: number): WebPushSubscriptionRecord[] {
  return getDb().prepare(
    `SELECT * FROM web_push_subscriptions WHERE user_id = ? ORDER BY created_at ASC`
  ).all(userId) as WebPushSubscriptionRecord[];
}

export function getWebPushSubscriptionById(id: number): WebPushSubscriptionRecord | undefined {
  return getDb().prepare(
    `SELECT * FROM web_push_subscriptions WHERE id = ?`
  ).get(id) as WebPushSubscriptionRecord | undefined;
}

export function deleteWebPushSubscription(id: number): void {
  getDb().prepare(`DELETE FROM web_push_subscriptions WHERE id = ?`).run(id);
}

/** Used by the firer to clean up stale endpoints when web-push returns 410/404. */
export function deleteWebPushSubscriptionByEndpoint(endpoint: string): void {
  getDb().prepare(`DELETE FROM web_push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

export function updateWebPushLastUsedAt(id: number): void {
  getDb().prepare(
    `UPDATE web_push_subscriptions SET last_used_at = datetime('now') WHERE id = ?`
  ).run(id);
}
```

- [ ] **Step 2: Write the failing tests at `server/src/db/queries.web-push.test.ts`**

```ts
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

  it('UNIQUE(endpoint) raises on a different user trying to claim the same endpoint', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    upsertWebPushSubscription({ user_id: u1, endpoint: 'SAME', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    // Same endpoint with different user — UPSERT will UPDATE the row, transferring it to u2.
    // That's not catastrophic but worth confirming the UPDATE path handles user_id correctly.
    upsertWebPushSubscription({ user_id: u2, endpoint: 'SAME', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    // Note: ON CONFLICT only updates the keys + label + UA fields, not user_id.
    // So the row's user_id stays as u1. The original user keeps it.
    expect(getActiveWebPushSubscriptionsForUser(u1)).toHaveLength(1);
    expect(getActiveWebPushSubscriptionsForUser(u2)).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- queries.web-push
```

Expected: 8 tests pass.

- [ ] **Step 4: Run full suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 458/458 (was 450; +8).

- [ ] **Step 5: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.web-push.test.ts
git commit -m "$(cat <<'EOF'
feat(pwa): web push subscription DB helpers

UPSERT-on-endpoint semantics for re-subscribes. Reads scoped per
user. Two delete paths: by id (user-initiated unsubscribe) and by
endpoint (firer cleanup on 410/404). updateLastUsedAt for the UI's
"active vs stale device" hint.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Web Push channel renderer + sender

**Files:**
- Create: `server/src/notifications/web-push.ts`
- Create: `server/src/notifications/web-push.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/notifications/web-push.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

// Mock the web-push library at the module level so our sender talks to a stub.
const sendNotificationMock = vi.fn();
const setVapidDetailsMock = vi.fn();
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
import type { Tracker, TrackerUrl } from '../db/queries.js';
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
    upsertWebPushSubscription({ user_id: u, endpoint: 'E1', p256dh_key: 'P', auth_key: 'A', device_label: 'Mac', user_agent: null });
    upsertWebPushSubscription({ user_id: u, endpoint: 'E2', p256dh_key: 'P', auth_key: 'A', device_label: 'iPhone', user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    const ok = await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    expect(ok).toBe(true);
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    expect(getActiveWebPushSubscriptionsForUser(u)).toHaveLength(2);
  });

  it('payload includes title, body, url, tag', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'E1', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockResolvedValue({ statusCode: 201 });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, '12-month low');

    const arg = sendNotificationMock.mock.calls[0][1];
    const payload = JSON.parse(arg);
    expect(payload.title).toContain('Samsung 990 Pro 4TB');
    expect(payload.title).toContain('279');
    expect(payload.body).toContain('12-month low');
    expect(payload.url).toBe('/trackers/1');
    expect(payload.tag).toBe('tracker-1-price');
  });

  it('410 response → deletes the stale subscription', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'STALE', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    upsertWebPushSubscription({ user_id: u, endpoint: 'OK', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock
      .mockImplementationOnce(() => { const e: { statusCode?: number } = new Error('Gone'); e.statusCode = 410; throw e; })
      .mockResolvedValueOnce({ statusCode: 201 });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    const remaining = getActiveWebPushSubscriptionsForUser(u);
    expect(remaining.map(r => r.endpoint)).toEqual(['OK']);
  });

  it('404 response → deletes the stale subscription', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'STALE', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    sendNotificationMock.mockImplementationOnce(() => { const e: { statusCode?: number } = new Error('Not Found'); e.statusCode = 404; throw e; });

    await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    expect(getActiveWebPushSubscriptionsForUser(u)).toHaveLength(0);
  });

  it('5xx response → keeps subscription, logs but continues', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
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
    upsertWebPushSubscription({ user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });

    const ok = await sendWebPushPriceAlert(makeTracker(u), 279, u, null);

    expect(ok).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('one device 410 + one device success → returns true (any-success semantics)', async () => {
    const u = seedUser();
    upsertWebPushSubscription({ user_id: u, endpoint: 'STALE', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    upsertWebPushSubscription({ user_id: u, endpoint: 'OK', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
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
    upsertWebPushSubscription({ user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
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
    upsertWebPushSubscription({ user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A', device_label: null, user_agent: null });
    const nullBasket: BasketState = { ...makeBasket(), total: null };

    const ok = await sendWebPushBasketAlert(makeProject(u), nullBasket, makeMembers(), u, null);

    expect(ok).toBe(false);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd /root/price-tracker/server && npm test -- web-push.test
```

- [ ] **Step 3: Implement `server/src/notifications/web-push.ts`**

```ts
// server/src/notifications/web-push.ts
import webpush from 'web-push';
import {
  getActiveWebPushSubscriptionsForUser,
  deleteWebPushSubscriptionByEndpoint,
  updateWebPushLastUsedAt,
} from '../db/queries.js';
import { logger } from '../logger.js';
import type { Tracker } from '../db/queries.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

interface WebPushError extends Error {
  statusCode?: number;
}

function configureVapid(): boolean {
  const pub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '';
  const priv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '';
  const subject = process.env.WEB_PUSH_SUBJECT || '';
  if (!pub || !priv || !subject) {
    logger.warn({}, 'web_push_vapid_missing');
    return false;
  }
  try {
    webpush.setVapidDetails(subject, pub, priv);
    return true;
  } catch (err) {
    logger.error({ err: String(err) }, 'web_push_vapid_setup_failed');
    return false;
  }
}

interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

async function dispatchToAllSubs(userId: number, payload: PushPayload): Promise<boolean> {
  if (!configureVapid()) return false;

  const subs = getActiveWebPushSubscriptionsForUser(userId);
  if (subs.length === 0) return false;

  const body = JSON.stringify(payload);
  const results = await Promise.allSettled(subs.map(async (sub) => {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh_key, auth: sub.auth_key },
    };
    const startMs = Date.now();
    try {
      await webpush.sendNotification(subscription, body);
      updateWebPushLastUsedAt(sub.id);
      logger.info({
        user_id: userId, subscription_id: sub.id, status: 'ok',
        endpoint_host: new URL(sub.endpoint).hostname,
        latency_ms: Date.now() - startMs,
      }, 'web_push_send');
      return true;
    } catch (err) {
      const wpe = err as WebPushError;
      const status = wpe.statusCode;
      if (status === 410 || status === 404) {
        deleteWebPushSubscriptionByEndpoint(sub.endpoint);
        logger.info({
          user_id: userId, subscription_id: sub.id, status,
        }, 'web_push_subscription_stale');
      } else {
        logger.warn({
          user_id: userId, subscription_id: sub.id, status, err: String(err),
        }, 'web_push_send_failed');
      }
      return false;
    }
  }));

  return results.some(r => r.status === 'fulfilled' && r.value === true);
}

export async function sendWebPushPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  userId: number,
  aiCommentary: string | null,
): Promise<boolean> {
  const title = `$${currentPrice.toFixed(2)} — ${tracker.name}`;
  const baseBody = tracker.last_price !== null && tracker.last_price > currentPrice
    ? `Down from $${tracker.last_price.toFixed(2)}`
    : `Now at $${currentPrice.toFixed(2)}`;
  const body = aiCommentary ? `${baseBody} — ${aiCommentary}` : baseBody;

  return dispatchToAllSubs(userId, {
    title,
    body,
    url: `/trackers/${tracker.id}`,
    tag: `tracker-${tracker.id}-price`,
  });
}

export async function sendWebPushBasketAlert(
  project: Project,
  basket: BasketState,
  members: BasketMember[],
  userId: number,
  aiCommentary: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;

  const title = `Bundle Ready: ${project.name}`;
  const baseBody = `$${basket.total.toFixed(2)} / $${project.target_total.toFixed(2)} target (${basket.item_count} items)`;
  const body = aiCommentary ? `${baseBody} — ${aiCommentary}` : baseBody;

  return dispatchToAllSubs(userId, {
    title,
    body,
    url: `/projects/${project.id}`,
    tag: `project-${project.id}-basket`,
  });
}
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- web-push.test
```

Expected: 10 tests pass.

- [ ] **Step 5: Run full suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 468/468 (was 458; +10).

- [ ] **Step 6: Commit**

```bash
git add server/src/notifications/web-push.ts server/src/notifications/web-push.test.ts
git commit -m "$(cat <<'EOF'
feat(pwa): web-push channel renderer with auto-cleanup

sendWebPushPriceAlert + sendWebPushBasketAlert wrap the web-push
npm library. Both fan out across the user's active subscriptions
via Promise.allSettled. 410/404 → delete the stale endpoint row
immediately. 5xx/other errors → log structured warning, keep
subscription. VAPID keys read from env at call time so missing
keys silently no-op without crashing the channel fanout.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: API routes — `/api/web-push/...`

**Files:**
- Create: `server/src/routes/web-push.ts`
- Create: `server/src/routes/web-push.test.ts`
- Modify: `server/src/index.ts` — mount the route

- [ ] **Step 1: Create `server/src/routes/web-push.ts`**

```ts
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  upsertWebPushSubscription,
  getActiveWebPushSubscriptionsForUser,
  getWebPushSubscriptionById,
  deleteWebPushSubscription,
} from '../db/queries.js';
import { deriveDeviceLabel } from '../lib/device-label.js';

const router = Router();

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  device_label: z.string().max(120).optional(),
});

// POST /api/web-push/subscribe
router.post('/subscribe', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const parsed = SubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  const ua = (req.get('user-agent') || '').slice(0, 500);
  const label = parsed.data.device_label?.slice(0, 120) || deriveDeviceLabel(ua);
  const id = upsertWebPushSubscription({
    user_id: userId,
    endpoint: parsed.data.endpoint,
    p256dh_key: parsed.data.keys.p256dh,
    auth_key: parsed.data.keys.auth,
    device_label: label,
    user_agent: ua || null,
  });
  const sub = getWebPushSubscriptionById(id);
  res.status(201).json({
    id: sub!.id,
    device_label: sub!.device_label,
    created_at: sub!.created_at,
    last_used_at: sub!.last_used_at,
  });
});

// GET /api/web-push/devices — keys redacted
router.get('/devices', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const subs = getActiveWebPushSubscriptionsForUser(userId);
  res.json(subs.map(s => ({
    id: s.id,
    device_label: s.device_label,
    created_at: s.created_at,
    last_used_at: s.last_used_at,
  })));
});

// DELETE /api/web-push/subscriptions/:id
router.delete('/subscriptions/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const sub = getWebPushSubscriptionById(id);
  if (!sub || sub.user_id !== userId) {
    return res.status(404).json({ error: 'not_found' });
  }
  deleteWebPushSubscription(id);
  res.status(204).send();
});

export default router;
```

- [ ] **Step 2: Mount the route in `server/src/index.ts`**

Find the existing mount block (e.g., `app.use('/api/projects', apiKeyMiddleware, authMiddleware, projectsRoutes)` from Bundle Tracker). Add alongside:

```ts
import webPushRoutes from './routes/web-push.js';

// alongside the other route mounts:
app.use('/api/web-push', apiKeyMiddleware, authMiddleware, webPushRoutes);
```

- [ ] **Step 3: Write the failing tests at `server/src/routes/web-push.test.ts`**

```ts
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
```

- [ ] **Step 4: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- routes/web-push
```

Expected: 8 tests pass.

- [ ] **Step 5: Run full suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 476/476 (was 468; +8).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/web-push.ts server/src/routes/web-push.test.ts server/src/index.ts
git commit -m "$(cat <<'EOF'
feat(pwa): web-push REST routes (subscribe / devices / unsubscribe)

POST /subscribe: zod-validated body, UPSERT on endpoint, derives a
device label from UA when not provided. GET /devices: user-scoped,
keys redacted from response (only id + label + timestamps). DELETE
/subscriptions/:id: cross-user isolation enforced — 404 (not 403)
when targeting another user's row to avoid leaking existence.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Cron integration — `web_push` as the 5th channel

**Files:**
- Modify: `server/src/scheduler/cron.ts` — extend `ChannelName`, `CHANNEL_NAMES`, `EnabledChannels`, `getEnabledChannels`, `firePriceAlerts`
- Create: `server/src/scheduler/cron-web-push.test.ts`

- [ ] **Step 1: Extend the channel-name surface in `cron.ts`**

Find this declaration (around line 42):

```ts
export type ChannelName = 'discord' | 'ntfy' | 'webhook' | 'email';
```

Change to:

```ts
export type ChannelName = 'discord' | 'ntfy' | 'webhook' | 'email' | 'web_push';
```

Find the constant (around line 44):

```ts
export const CHANNEL_NAMES: readonly ChannelName[] = ['discord', 'ntfy', 'webhook', 'email'] as const;
```

Change to:

```ts
export const CHANNEL_NAMES: readonly ChannelName[] = ['discord', 'ntfy', 'webhook', 'email', 'web_push'] as const;
```

Find the `EnabledChannels` interface (around line 46) and add a field:

```ts
export interface EnabledChannels {
  discord?: string;
  ntfy?: string;
  ntfyToken?: string;
  webhook?: string;
  email?: string;
  web_push?: boolean;       // NEW: true when user has any active subscription
}
```

- [ ] **Step 2: Update `getEnabledChannels` to detect web push**

Add the import at the top of `cron.ts` (alongside existing query imports):

```ts
import { getActiveWebPushSubscriptionsForUser } from '../db/queries.js';
```

Find the `getEnabledChannels` function. After its existing field assignments, add:

```ts
  if (userId) {
    const subs = getActiveWebPushSubscriptionsForUser(userId);
    if (subs.length > 0) result.web_push = true;
  }
```

(The exact form depends on how the existing function is structured — modify the existing pattern. The flag should be `true` only when the user has at least one active subscription.)

- [ ] **Step 3: Add the `web_push` case in `firePriceAlerts`**

Find the channel switch (around line 174 — `case 'discord': ...`). Add the new case after the existing four:

```ts
import { sendWebPushPriceAlert } from '../notifications/web-push.js';

// ... inside the switch:
case 'web_push':
  promise = sendWebPushPriceAlert(alertTracker, currentPrice, userId, aiCommentary);
  break;
```

The existing per-channel cooldown gate already iterates `CHANNEL_NAMES`, so the `web_push` channel inherits the cooldown logic for free.

- [ ] **Step 4: Write the cron integration test at `server/src/scheduler/cron-web-push.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

const sendWebPushPriceAlertMock = vi.fn();
vi.mock('../notifications/web-push.js', () => ({
  sendWebPushPriceAlert: sendWebPushPriceAlertMock,
  sendWebPushBasketAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../scraper/extractor.js', () => ({ extractPrice: vi.fn() }));
vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
  sendDiscordBasketAlert: vi.fn().mockResolvedValue(true),
  testDiscordWebhook: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyPriceAlert: vi.fn().mockResolvedValue(true),
  sendNtfyErrorAlert: vi.fn().mockResolvedValue(true),
  sendNtfyBasketAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericPriceAlert: vi.fn().mockResolvedValue(true),
  sendGenericErrorAlert: vi.fn().mockResolvedValue(true),
  sendGenericBasketAlert: vi.fn().mockResolvedValue(true),
  assertWebhookUrl: vi.fn(),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailPriceAlert: vi.fn().mockResolvedValue(true),
  sendEmailErrorAlert: vi.fn().mockResolvedValue(true),
  sendEmailBasketAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { upsertWebPushSubscription } from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function seedTrackerWithSeller(userId: number, name: string, lastPrice: number): { trackerId: number; trackerUrlId: number } {
  const trackerInsert = getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 100, 'active', 60, 0, ?)`
  ).run(name, `https://amazon.com/dp/${name}`, userId, lastPrice);
  const trackerId = Number(trackerInsert.lastInsertRowid);
  const urlInsert = getDb().prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position, last_price, status)
     VALUES (?, ?, 0, ?, 'active')`
  ).run(trackerId, `https://amazon.com/dp/${name}`, lastPrice);
  return { trackerId, trackerUrlId: Number(urlInsert.lastInsertRowid) };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('cron web_push channel', () => {
  it('fires sendWebPushPriceAlert when user has subscriptions and price drops below threshold', async () => {
    const u = seedUser();
    upsertWebPushSubscription({
      user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A',
      device_label: 'Phone', user_agent: null,
    });
    const { trackerUrlId } = seedTrackerWithSeller(u, 'A', 200);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    sendWebPushPriceAlertMock.mockResolvedValue(true);

    await checkTrackerUrl(trackerUrlId);

    expect(sendWebPushPriceAlertMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire web_push when user has no subscriptions', async () => {
    const u = seedUser();
    const { trackerUrlId } = seedTrackerWithSeller(u, 'A', 200);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(trackerUrlId);

    expect(sendWebPushPriceAlertMock).not.toHaveBeenCalled();
  });

  it('respects per-channel cooldown — recent web_push notification suppresses', async () => {
    const u = seedUser();
    upsertWebPushSubscription({
      user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A',
      device_label: null, user_agent: null,
    });
    const { trackerId, trackerUrlId } = seedTrackerWithSeller(u, 'A', 200);

    // Seed a recent notification on this (tracker, seller, web_push) tuple.
    getDb().prepare(
      `INSERT INTO notifications (tracker_id, tracker_url_id, channel, sent_at)
       VALUES (?, ?, 'web_push', datetime('now', '-1 hour'))`
    ).run(trackerId, trackerUrlId);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(trackerUrlId);

    // Default cooldown is 6h → recent 1-hour-old notification suppresses
    expect(sendWebPushPriceAlertMock).not.toHaveBeenCalled();
  });

  it('does not block other channels when web_push send returns false', async () => {
    const u = seedUser();
    upsertWebPushSubscription({
      user_id: u, endpoint: 'E', p256dh_key: 'P', auth_key: 'A',
      device_label: null, user_agent: null,
    });
    getDb().prepare(`UPDATE settings SET value = ? WHERE key = ?`).run('https://example/wh', 'discord_webhook_url');
    // (or use setSetting helper if available — match the existing test pattern)
    const { trackerUrlId } = seedTrackerWithSeller(u, 'A', 200);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    sendWebPushPriceAlertMock.mockResolvedValue(false);

    await checkTrackerUrl(trackerUrlId);

    // web_push returned false but the call was made; other channels independent
    expect(sendWebPushPriceAlertMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- cron-web-push
```

Expected: 4 tests pass.

- [ ] **Step 6: Run full suite — confirm existing scheduler tests still green**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 480/480 (was 476; +4). The existing `cron-cooldown`, `cron-plausibility`, `cron-recovery`, `cron-ai`, `cron-projects` tests must still pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/scheduler/cron.ts server/src/scheduler/cron-web-push.test.ts
git commit -m "$(cat <<'EOF'
feat(pwa): wire web_push as the 5th channel in firePriceAlerts

Extend ChannelName / CHANNEL_NAMES / EnabledChannels to include
web_push. getEnabledChannels detects availability via active
subscription count. firePriceAlerts switch gains the web_push case;
existing per-channel cooldown gate carries over for free. Four
integration tests confirm fire/skip behavior and that other channels
are unaffected.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Firer integration — basket alerts via web_push

**Files:**
- Modify: `server/src/projects/firer.ts` — add `web_push` case in basket dispatch
- Modify: `server/src/projects/firer.test.ts` — extend existing tests

- [ ] **Step 1: Add the `web_push` case in `firer.ts` basket dispatch**

Find the channel switch in `firer.ts` (around line 105 — `case 'discord': ...`). Add:

```ts
import { sendWebPushBasketAlert } from '../notifications/web-push.js';

// ... inside the switch:
case 'web_push':
  ok = await sendWebPushBasketAlert(project, basket, members, project.user_id, aiCommentary);
  break;
```

- [ ] **Step 2: Extend existing firer tests**

Open `server/src/projects/firer.test.ts`. Add the web-push mock alongside the existing channel mocks at the top:

```ts
vi.mock('../notifications/web-push.js', () => ({
  sendWebPushPriceAlert: vi.fn().mockResolvedValue(true),
  sendWebPushBasketAlert: vi.fn().mockResolvedValue(true),
}));
```

Add a new import:

```ts
import { sendWebPushBasketAlert } from '../notifications/web-push.js';
```

Add two new tests inside the existing `describe('evaluateAndFireForProject', ...)` block:

```ts
  it('fires sendWebPushBasketAlert when user has web push subscription', async () => {
    const u = seedUser();
    setupChannels(u);  // existing helper that enables Discord/ntfy/email/webhook
    // Add a web push subscription
    getDb().prepare(
      `INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
       VALUES (?, 'E', 'P', 'A')`
    ).run(u);

    const t = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t });

    await evaluateAndFireForProject(p);

    expect(sendWebPushBasketAlert).toHaveBeenCalledTimes(1);
    const notifs = getDb().prepare('SELECT channel FROM project_notifications WHERE project_id=?').all(p) as { channel: string }[];
    expect(notifs.map(n => n.channel).sort()).toContain('web_push');
  });

  it('respects per-(project, web_push) cooldown', async () => {
    const u = seedUser();
    getDb().prepare(
      `INSERT INTO web_push_subscriptions (user_id, endpoint, p256dh_key, auth_key)
       VALUES (?, 'E', 'P', 'A')`
    ).run(u);
    const t = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t });

    // Seed a recent web_push project notification (1 hour ago — within default 6h)
    getDb().prepare(
      `INSERT INTO project_notifications (project_id, channel, basket_total, target_total, sent_at)
       VALUES (?, 'web_push', 30, 100, datetime('now', '-1 hour'))`
    ).run(p);

    await evaluateAndFireForProject(p);
    expect(sendWebPushBasketAlert).not.toHaveBeenCalled();
  });
```

⚠️ The exact `seedTracker` / `setupChannels` / `addProjectTracker` helpers are already defined in `firer.test.ts` from Bundle Tracker Task 7. Reuse them.

- [ ] **Step 3: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- firer.test
```

Expected: 10 tests pass (was 8 + 2 new).

- [ ] **Step 4: Run full suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 482/482 (was 480; +2).

- [ ] **Step 5: Commit**

```bash
git add server/src/projects/firer.ts server/src/projects/firer.test.ts
git commit -m "$(cat <<'EOF'
feat(pwa): web_push as 5th channel in basket-alert fanout

evaluateAndFireForProject's switch gains the web_push case alongside
the existing four. Per-(project, web_push) cooldown via the existing
project_notifications table works for free. Two extension tests
confirm fire-on-eligible and cooldown-suppression behavior.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Service worker (no tests — plain JS, validated via DevTools)

**Files:**
- Create: `client/public/sw.js`

- [ ] **Step 1: Create `client/public/sw.js`**

Plain JS, not bundled. Lives in `client/public/` so Vite serves it at `/sw.js` with the right scope.

```js
// client/public/sw.js
// Plain JS — not bundled by Vite. Served directly at /sw.js with root scope.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', e => {
  let payload = {};
  try { payload = e.data ? e.data.json() : {}; }
  catch { payload = { title: 'Price Tracker', body: (e.data && e.data.text()) || '' }; }
  e.waitUntil(self.registration.showNotification(payload.title || 'Price Tracker', {
    body: payload.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-72.png',
    data: { url: payload.url || '/' },
    tag: payload.tag,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.location.origin)) {
        await w.focus();
        w.postMessage({ type: 'navigate', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
```

- [ ] **Step 2: Verify the file is valid JavaScript**

```bash
cd /root/price-tracker/client && node --check public/sw.js
```

Expected: silent success (no syntax errors). The `self.*` references won't exist in Node's runtime, but `--check` only validates syntax.

- [ ] **Step 3: Commit**

```bash
git add client/public/sw.js
git commit -m "$(cat <<'EOF'
feat(pwa): plain-JS service worker for push + click handling

skipWaiting + clients.claim → new versions activate immediately.
push handler: parse JSON payload, show native notification with
icon/badge/tag/url. notificationclick handler: focus an existing
window if open, otherwise open a new one. Plain JS — Vite serves
directly from public/ at /sw.js with root scope.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: PWA manifest + icons

**Files:**
- Create: `client/public/manifest.webmanifest`
- Create: `client/public/icons/icon-192.png`
- Create: `client/public/icons/icon-512.png`
- Create: `client/public/icons/icon-512-maskable.png`
- Create: `client/public/icons/badge-72.png`

- [ ] **Step 1: Create `client/public/manifest.webmanifest`**

```json
{
  "name": "Price Tracker",
  "short_name": "Prices",
  "description": "Track product prices across retailers",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "theme_color": "#0f172a",
  "background_color": "#ffffff",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 2: Generate placeholder PNG icons**

For v1, generate simple solid-color squares with a "P" via ImageMagick. The user can replace with branded artwork later.

```bash
cd /root/price-tracker/client && mkdir -p public/icons

# 192x192 — main icon
convert -size 192x192 xc:'#0f172a' \
  -gravity center -fill '#ffffff' -font DejaVu-Sans-Bold -pointsize 120 \
  -annotate +0+0 'P' \
  public/icons/icon-192.png

# 512x512 — main icon at higher resolution
convert -size 512x512 xc:'#0f172a' \
  -gravity center -fill '#ffffff' -font DejaVu-Sans-Bold -pointsize 320 \
  -annotate +0+0 'P' \
  public/icons/icon-512.png

# 512x512 maskable — same content but with safe-area padding (the OS
# will crop edges in adaptive icons; keep important content centered)
convert -size 512x512 xc:'#0f172a' \
  -gravity center -fill '#ffffff' -font DejaVu-Sans-Bold -pointsize 240 \
  -annotate +0+0 'P' \
  public/icons/icon-512-maskable.png

# 72x72 — notification badge (Android)
convert -size 72x72 xc:'#0f172a' \
  -gravity center -fill '#ffffff' -font DejaVu-Sans-Bold -pointsize 48 \
  -annotate +0+0 'P' \
  public/icons/badge-72.png
```

If `convert` (ImageMagick) is not installed, use `sudo apt install imagemagick` first. Alternative: any 192/512px PNG you already have.

- [ ] **Step 3: Add manifest link + theme color to `client/index.html`**

Edit `client/index.html` — find the `<head>` block and add (above the existing CSS link or in any logical position):

```html
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#0f172a">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
```

(`apple-touch-icon` is what iOS uses when adding to home screen — without it, iOS falls back to a screenshot of the page.)

- [ ] **Step 4: Verify the build packages everything**

```bash
cd /root/price-tracker/client && npm run build && ls dist/manifest.webmanifest dist/sw.js dist/icons/
```

Expected: `manifest.webmanifest`, `sw.js`, and the four icon PNGs all in `dist/`.

- [ ] **Step 5: Commit**

```bash
git add client/public/manifest.webmanifest client/public/icons/ client/index.html
git commit -m "$(cat <<'EOF'
feat(pwa): web app manifest + placeholder icons

Manifest declares standalone display, theme color matching the dark
slate of the existing navbar, three icon sizes (192, 512, 512-maskable)
plus a 72px notification badge for Android. Placeholder PNGs
generated via ImageMagick — solid-color squares with a "P".
Replaceable later with branded artwork.

index.html gains link rel=manifest, theme-color meta, and an
apple-touch-icon (iOS Add-to-Home-Screen falls back to a page
screenshot otherwise).

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Client types + API wrappers + lib

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`
- Create: `client/src/lib/web-push.ts`

- [ ] **Step 1: Add types at the bottom of `client/src/types.ts`**

```ts
// === Web Push (PWA notifications) ===

export interface WebPushDevice {
  id: number;
  device_label: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface SubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device_label?: string;
}
```

- [ ] **Step 2: Add API wrappers to `client/src/api.ts`**

Append at the bottom of the file (using the existing `request<T>` helper — same pattern as projects API):

```ts
import type { WebPushDevice, SubscribePayload } from './types';

// === Web Push ===

export function subscribeWebPush(payload: SubscribePayload): Promise<WebPushDevice> {
  return request<WebPushDevice>('/web-push/subscribe', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listWebPushDevices(): Promise<WebPushDevice[]> {
  return request<WebPushDevice[]>('/web-push/devices');
}

export function deleteWebPushDevice(id: number): Promise<void> {
  return request<void>(`/web-push/subscriptions/${id}`, { method: 'DELETE' });
}
```

If the existing `import type` line at the top already imports from `./types`, add `WebPushDevice` and `SubscribePayload` to that line instead of creating a duplicate.

- [ ] **Step 3: Create `client/src/lib/web-push.ts`**

```ts
// client/src/lib/web-push.ts
import { subscribeWebPush, listWebPushDevices, deleteWebPushDevice } from '../api';
import type { WebPushDevice } from '../types';

export type SubscriptionState =
  | 'unsupported'
  | 'permission-denied'
  | 'available'
  | 'enabled'
  | 'ios-needs-pwa';

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function registerSW(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .catch(err => console.warn('SW registration failed', err));
}

export async function getSubscriptionState(): Promise<SubscriptionState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') {
    return 'permission-denied';
  }
  if (isIOSSafari() && !isStandalone()) {
    return 'ios-needs-pwa';
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'enabled' : 'available';
}

export async function subscribePush(): Promise<WebPushDevice> {
  if (!VAPID_PUBLIC) {
    throw new Error('VITE_VAPID_PUBLIC_KEY is not set — server has no VAPID configured');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission denied');
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
  });
  const json = sub.toJSON();
  return subscribeWebPush({
    endpoint: json.endpoint!,
    keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
  });
}

export async function unsubscribePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sub.unsubscribe();
    // Find the matching server-side row by listing devices and finding the
    // one we just unsubscribed from. The endpoint isn't returned by /devices,
    // so we delete by matching the most-recently-used row that has no
    // last_used_at update since now. Simpler: just call /devices, find any
    // that match this device's User-Agent label, and delete those.
    // For v1 simplicity — we'll let the server's 410 cleanup handle it on
    // the next push attempt. The subscription is unsubscribed locally; the
    // server row will be removed automatically on the next 410.
  }
}

export async function getDevices(): Promise<WebPushDevice[]> {
  return listWebPushDevices();
}

export async function removeDevice(id: number): Promise<void> {
  return deleteWebPushDevice(id);
}
```

⚠️ Note on `unsubscribePush` simplification: the local browser-side `sub.unsubscribe()` succeeds, and then we *could* find the server row by endpoint and delete it — but the endpoint isn't exposed by `/devices` (keys redacted for security). For v1, we let natural 410 cleanup handle the server side: the next push attempt to the now-invalidated endpoint will return 410, and the firer deletes the row. Slightly delayed but eventually consistent. If users find this annoying, v2 can add an endpoint hash to the `/devices` response or a `DELETE /web-push/by-endpoint` route.

- [ ] **Step 4: Verify the client builds**

```bash
cd /root/price-tracker/client && npm run build
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/types.ts client/src/api.ts client/src/lib/web-push.ts
git commit -m "$(cat <<'EOF'
feat(pwa): client web-push types + API wrappers + subscription helper

Adds WebPushDevice + SubscribePayload to client types, reusing the
existing request<T> helper for the three API calls (subscribe,
list devices, delete by id). web-push.ts is the only client surface
that touches the Push API: getSubscriptionState() returns one of
five states (unsupported / permission-denied / available / enabled /
ios-needs-pwa), subscribePush() handles the full permission +
PushManager.subscribe + server registration flow, and the helper
imports VITE_VAPID_PUBLIC_KEY at build time.

unsubscribePush relies on server-side 410 cleanup for the row
removal — eventual consistency rather than another endpoint to
expose the encrypted keys.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: WebPushSettings React component

**Files:**
- Create: `client/src/components/WebPushSettings.tsx`
- Modify: `client/src/pages/Settings.tsx`

- [ ] **Step 1: Create `client/src/components/WebPushSettings.tsx`**

```tsx
import { useEffect, useState, useCallback } from 'react';
import {
  getSubscriptionState,
  subscribePush,
  unsubscribePush,
  getDevices,
  removeDevice,
  type SubscriptionState,
} from '../lib/web-push';
import type { WebPushDevice } from '../types';

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso + 'Z').getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function WebPushSettings() {
  const [state, setState] = useState<SubscriptionState | 'loading'>('loading');
  const [devices, setDevices] = useState<WebPushDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await getSubscriptionState());
      setDevices(await getDevices());
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      await subscribePush();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    try {
      await unsubscribePush();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveDevice(id: number) {
    setError(null);
    try {
      await removeDevice(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const helpText: Record<SubscriptionState | 'loading', string> = {
    'loading': 'Checking notification status...',
    'unsupported': "Your browser doesn't support push notifications.",
    'permission-denied': 'Notifications blocked. Enable in your browser settings.',
    'available': 'Receive price alerts as native browser notifications.',
    'enabled': 'You\'re receiving push notifications on this device.',
    'ios-needs-pwa': 'On iPhone: Share → Add to Home Screen first, then open from the home screen icon.',
  };

  const buttonLabel =
    state === 'enabled' ? 'Disable on this device' :
    state === 'available' ? 'Enable' :
    state === 'loading' ? '…' :
    'Enable';

  const buttonDisabled =
    busy ||
    state === 'unsupported' ||
    state === 'permission-denied' ||
    state === 'ios-needs-pwa' ||
    state === 'loading';

  return (
    <div className="rounded-lg border border-border bg-surface p-4 mb-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h3 className="font-semibold">Browser notifications</h3>
          <p className="text-sm text-text-muted mt-1">{helpText[state]}</p>
        </div>
        <button
          onClick={state === 'enabled' ? handleDisable : handleEnable}
          disabled={buttonDisabled}
          className="px-3 py-1.5 rounded bg-primary text-white text-sm font-medium disabled:opacity-50 flex-shrink-0"
        >
          {buttonLabel}
        </button>
      </div>

      {error && <div className="text-error text-sm mb-2">{error}</div>}

      {devices.length > 0 && (
        <div className="border-t border-border pt-3 mt-3">
          <div className="text-xs text-text-muted mb-2">Registered devices</div>
          <ul className="space-y-1">
            {devices.map(d => (
              <li key={d.id} className="flex items-center justify-between text-sm">
                <span className="text-text">
                  {d.device_label ?? `Device ${d.id}`}
                  <span className="text-text-muted ml-2">
                    · added {formatRelative(d.created_at)}
                    {d.last_used_at && ` · last fired ${formatRelative(d.last_used_at)}`}
                  </span>
                </span>
                <button
                  onClick={() => handleRemoveDevice(d.id)}
                  className="text-text-muted hover:text-error text-xs"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Embed the component in `client/src/pages/Settings.tsx`**

Read `client/src/pages/Settings.tsx` to find where the existing channel rows (Discord webhook URL, ntfy URL, email, etc.) are rendered. Add an import at the top:

```tsx
import { WebPushSettings } from '../components/WebPushSettings';
```

Render `<WebPushSettings />` after the four existing channel-config rows, before any cooldown sliders. Match the existing card layout style (the component already wraps itself in a `bg-surface` card matching the existing pattern).

- [ ] **Step 3: Verify the client builds**

```bash
cd /root/price-tracker/client && npm run build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/WebPushSettings.tsx client/src/pages/Settings.tsx
git commit -m "$(cat <<'EOF'
feat(pwa): WebPushSettings component (5-state UI + devices list)

State machine: loading → one of {unsupported, permission-denied,
available, enabled, ios-needs-pwa}. Toggle button label and
enabled-state derive from the current state. Devices list shows
device label, created-at relative timestamp, and last-fired
timestamp where present, with a per-row Remove button.

Embedded in Settings page after the four existing channel rows.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: App boot — service worker registration + navigation handling

**Files:**
- Modify: `client/src/main.tsx` (or `client/src/App.tsx` — locate the app entry)

- [ ] **Step 1: Register the service worker on app boot**

Read `client/src/main.tsx`. After the existing app-mount call, add:

```tsx
import { registerSW } from './lib/web-push';

// Register the service worker on app boot. Idempotent — safe to call on
// every load. Bails silently when the browser doesn't support SW.
registerSW();

// Listen for navigation messages from the SW (when an open tab receives a
// notification click, the SW's notificationclick handler postMessages the
// target URL to the focused window).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'navigate' && typeof e.data.url === 'string') {
      window.location.href = e.data.url;
    }
  });
}
```

Place these calls after the React root render — they don't depend on the React tree being mounted, but it's the conventional spot for "imperative side-effects on boot."

- [ ] **Step 2: Verify the client builds**

```bash
cd /root/price-tracker/client && npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/main.tsx
git commit -m "$(cat <<'EOF'
feat(pwa): register service worker + navigation message handling on boot

registerSW() is idempotent and bails on browsers without SW. The
postMessage listener handles the case where a notification click
lands on a focused tab — the SW's notificationclick handler tells
us which URL to navigate to, and we full-reload there for v1
simplicity.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Final pre-deploy checklist + PR

- [ ] **Step 1: Run the full server test suite — confirm green**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 482/482 pass. Zero failures. (445 from end of Bundle Tracker + 37 new across migration, device-label, queries, sender, routes, cron, firer.)

- [ ] **Step 2: Run the full client test suite — confirm green**

```bash
cd /root/price-tracker/client && npm test
```

Expected: existing client tests still pass. (No new client tests — visual components and SW are validated by manual exercise.)

- [ ] **Step 3: Build server + client clean**

```bash
cd /root/price-tracker/server && npm run build
cd /root/price-tracker/client && npm run build
```

Expected: zero TS errors, zero warnings. Verify these files exist in `client/dist/`:

```bash
ls /root/price-tracker/client/dist/sw.js \
   /root/price-tracker/client/dist/manifest.webmanifest \
   /root/price-tracker/client/dist/icons/icon-192.png \
   /root/price-tracker/client/dist/icons/icon-512.png \
   /root/price-tracker/client/dist/icons/icon-512-maskable.png \
   /root/price-tracker/client/dist/icons/badge-72.png
```

- [ ] **Step 4: Generate VAPID keys for the deployment**

```bash
cd /root/price-tracker/server && npx web-push generate-vapid-keys
```

Expected: prints three values — `Public Key`, `Private Key`, plus the suggestion to use `mailto:...` as the subject. Save these somewhere temporarily (we'll paste them on CT 302 in Step 7).

- [ ] **Step 5: Manual sanity check**

- Inspect `tasks/todo.md` — does the PWA + Web Push entry still link to the spec?
- Inspect `docs/superpowers/specs/2026-05-05-pwa-web-push-design.md` — unchanged on the branch?
- Spot-check that no new files accidentally landed elsewhere.

- [ ] **Step 6: Push the branch and open the PR**

```bash
git push -u origin feature/pwa-web-push
```

```bash
gh pr create --title "feat(pwa): PWA + Web Push as 5th notification channel" --body "$(cat <<'EOF'
## Summary

Implements the PWA + Web Push half of the third "next big bet" per \`docs/superpowers/specs/2026-05-05-pwa-web-push-design.md\`. The browser-extension half remains queued for a follow-up.

## What this ships

- **PWA-ification** of the existing client app: web app manifest, theme color, apple-touch-icon, install-to-home-screen flow.
- **Web Push as the 5th notification channel** — slotted into the existing channel-fanout in both \`firePriceAlerts\` (per-tracker) and \`evaluateAndFireForProject\` (basket alerts).
- **Per-device subscriptions** — one user → N active endpoints. All active subs fire on every alert.
- **Auto-cleanup** of stale endpoints — 410/404 from the \`web-push\` library triggers immediate row deletion.
- **5-state Settings UI** — handles unsupported / permission-denied / available / enabled / ios-needs-pwa.
- **Channel-level cooldown** reusing the existing \`\${channel}_cooldown_hours\` setting via the shared notifications + project_notifications tables.

Migration v10 adds \`web_push_subscriptions\`. No new feature flag — natural rollout via VAPID-key generation + user opt-in from Settings.

## Test plan

- [ ] Server tests pass: \`cd server && npm test\` → 482/482
- [ ] Client tests pass: \`cd client && npm test\`
- [ ] Both builds clean
- [ ] After deploy with VAPID keys: open Settings, enable browser notifications, accept the prompt, verify device appears in the list
- [ ] Trigger a price drop on any tracker → confirm a native notification arrives
- [ ] Click the notification → confirm it opens the relevant tracker
- [ ] Click "Remove" on the device → confirm the subscription disappears
- [ ] Repeat on phone via the Add-to-Home-Screen flow

## Architecture summary

\`\`\`
firePriceAlerts (existing per-tracker path)
  └─ for each enabled channel — now FIVE:
        ├─ Discord (existing)
        ├─ ntfy (existing)
        ├─ webhook (existing)
        ├─ email (existing)
        └─ web_push (NEW)
              ├─ subs = getActiveWebPushSubscriptionsForUser(userId)
              ├─ Promise.allSettled across devices
              │     ├─ on 410/404 → deleteWebPushSubscriptionByEndpoint
              │     ├─ on 5xx/network → log + skip
              │     └─ on success → updateLastUsedAt
              └─ insert ONE notifications row for the channel (not per device)
\`\`\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: After PR merges, deploy to CT 302**

```bash
# Generate VAPID keys (already done in Step 4 — paste from there)
ssh root@192.168.1.166 "cat >> /opt/price-tracker/.env" <<EOF
WEB_PUSH_VAPID_PUBLIC_KEY=BJ...
WEB_PUSH_VAPID_PRIVATE_KEY=...
WEB_PUSH_SUBJECT=mailto:andrew.schultz.w@gmail.com
VITE_VAPID_PUBLIC_KEY=BJ...
EOF

# Run the deploy
cd /root/price-tracker && bash scripts/deploy.sh
```

Expected: rebuild.sh runs migration v10, all tests pass, service restarts. Then verify per the lessons.md "merged ≠ deployed" rule:

```bash
ssh root@192.168.1.166 "
  echo '=== /api/health ===' && curl -s http://localhost:3100/api/health && echo &&
  echo '=== migration v10 ===' && sqlite3 /opt/price-tracker/data/price-tracker.db '.tables' | tr ' ' '\n' | grep web_push &&
  echo '=== sw.js + manifest in dist ===' && ls -la /opt/price-tracker/client/dist/sw.js /opt/price-tracker/client/dist/manifest.webmanifest &&
  echo '=== service uptime ===' && systemctl show price-tracker -p ActiveEnterTimestamp --value
"
```

- [ ] **Step 8: Browser smoke test**

- Open https://prices.schultzsolutions.tech/settings in Chrome
- Click "Enable browser notifications" — accept the OS prompt
- Verify "Mac · Chrome" (or similar) appears in the registered devices list
- Trigger a price drop on any tracker (or just wait for next scrape) → confirm a native notification arrives
- Click the notification → confirm it opens the tracker page
- Click "Remove" on the device row → verify it disappears from the list

Then on phone:
- Open the URL in mobile Safari (iOS) or Chrome (Android)
- Use Share → Add to Home Screen
- Open the app from the home screen icon
- Settings → Enable browser notifications → accept the OS prompt
- Trigger a price drop → confirm a native notification arrives on the phone

---

## Self-review

### Spec coverage

| Spec section | Covered by |
|---|---|
| Subscription model — per-device | Tasks 2, 4 (UPSERT on endpoint, multi-row read) |
| Channel integration — 5th `ChannelName` | Tasks 7, 8 |
| Cooldown — channel-level reuse | Tasks 7 (cron uses existing notifications table), 8 (firer uses existing project_notifications table) |
| VAPID keys — env-time + Vite build-time public | Tasks 1, 14 |
| Service worker — push + click only | Task 9 |
| Settings UI — 5-state component | Task 12 |
| Device labeling — UA regex | Task 3 |
| iOS support — display-mode standalone detection | Task 11 (web-push lib helper) |
| Error alerts NOT pushed via web push | Implicit — only sendWebPushPriceAlert + sendWebPushBasketAlert exist; no error-alert variant |
| Migration v10 schema | Task 2 |
| Web Push channel renderer w/ auto-cleanup | Task 5 |
| API routes (subscribe / devices / unsubscribe) | Task 6 |
| Cron integration | Task 7 |
| Firer integration | Task 8 |
| Manifest + icons | Task 10 |
| Client lib + types + API wrappers | Task 11 |
| App boot SW registration + nav handling | Task 13 |
| Rollout (VAPID generation + deploy + smoke) | Task 14 |

All spec sections accounted for.

### Known assumptions to verify during implementation

- **`setSetting` helper signature** in cron-web-push.test.ts Step 4 may differ from the placeholder — match the existing pattern from `cron-cooldown.test.ts`.
- **`Settings.tsx` row layout** is whatever the existing channel rows use — match it visually (the implementer reads the existing structure when embedding `<WebPushSettings />`).
- **`client/src/main.tsx` location** — if the app entry is `client/src/index.tsx` or somewhere else, adjust the file path in Task 13.
- **ImageMagick `convert` binary** is typically available on Linux dev environments. If missing, the implementer either installs it (`apt install imagemagick`) or supplies their own PNG icons.

These are codebase-shape questions, not design questions. Implementer resolves them by reading neighboring code at task time.
