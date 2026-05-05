# PWA + Web Push Design

**Date:** 2026-05-05
**Status:** Approved
**Author:** Andrew Schultz + Claude

## Overview

Price Tracker today is a regular web app that users open in a browser tab. Notifications come through Discord, ntfy, email, or a generic webhook — all of which require a separate app or relay. This change PWA-ifies the existing client app and adds Web Push as a fifth notification channel: the user installs Price Tracker to their phone or laptop home screen, opts in once, and from then on price-drop and bundle-ready alerts arrive as native OS notifications without any third-party intermediary.

Web Push slots cleanly into the existing channel-fanout system. The server-side `firePriceAlerts` and `evaluateAndFireForProject` already iterate `CHANNEL_NAMES` and dispatch per channel — adding `'web_push'` to the enum extends both alert paths without parallel code. Per-channel cooldown logic carries over (one row per `(tracker, seller, web_push)` and `(project, web_push)`, same as the existing four channels), so spam protection works uniformly.

The defining design principles:

- **Web Push is the 5th channel, not a separate subsystem.** Reuses `firePriceAlerts`, `evaluateAndFireForProject`, the cooldown table, the channel toggles in Settings, and the AI alert-copy generation. The 1:N device fanout (one user → multiple subscriptions) happens *inside* the channel renderer, transparent to the orchestrator.
- **Per-device subscriptions.** A user has up to N active subscriptions, one per `(user_id, endpoint)` pair. All active subscriptions fire on every alert. Cooldown is at the channel level (one alert per cooldown window), so phone + laptop both get notified once, not twice.
- **Auto-cleanup of stale endpoints.** When the `web-push` library returns 410 or 404, the firer immediately deletes the subscription row. Standard pattern, no proactive expiry sweep needed.
- **No parallel offline / background-sync infrastructure for v1.** The service worker handles `push` and `notificationclick` only. No dashboard caching (would mislead with stale data). No background sync (overkill).

## Decisions

- **Subscription model:** per-device. `web_push_subscriptions` table with `UNIQUE(endpoint)`. Re-subscribing on the same browser UPSERTs the existing row.
- **Channel integration:** Web Push is the 5th `ChannelName` value. `firePriceAlerts` dispatches it parallel to the existing four; `evaluateAndFireForProject` does the same for basket alerts.
- **Cooldown:** channel-level, not per-device. Reuses the existing `${channel}_cooldown_hours` user setting via `web_push_cooldown_hours`. Default 0 (no cooldown — push is high-volume by design).
- **VAPID keys:** generated once at deploy time via `npx web-push generate-vapid-keys`. Stored in `.env` as `WEB_PUSH_VAPID_PUBLIC_KEY` / `WEB_PUSH_VAPID_PRIVATE_KEY` / `WEB_PUSH_SUBJECT`. Public key also exposed to the client at build time via `VITE_VAPID_PUBLIC_KEY` (Vite env var).
- **Service worker scope:** `push` event handler + `notificationclick` handler. No offline caching. Plain JS in `client/public/sw.js` (not bundled by Vite).
- **Settings UI:** new `<WebPushSettings />` component embedded in `client/src/pages/Settings.tsx`. Toggle to enable/disable on this device. Devices list with per-row Remove. Cooldown input matching the existing per-channel pattern.
- **Device labeling:** server-side regex on `User-Agent` at subscribe time. Format: `${platform} · ${browser}` (e.g. "Mac · Chrome", "iPhone · Safari"). No `ua-parser-js` dependency.
- **iOS support:** standard Web Push works on iOS 16.4+ when the PWA is added to the home screen and opened from there. Settings UI shows an inline note when iOS Safari is detected and the app isn't running in standalone mode.
- **Error alerts:** explicitly NOT pushed via web push in v1. The existing `sendXxxErrorAlert` path stays per-channel (Discord/ntfy/email/webhook). Pushing every Walmart captcha to the user's phone is bad UX.

## Architecture

### New module map

| Path | Purpose | Talks to network? |
|---|---|---|
| `server/src/notifications/web-push.ts` | `sendWebPushPriceAlert` + `sendWebPushBasketAlert`. Wraps the `web-push` npm library. Handles VAPID signing, encryption, 410/404 auto-cleanup. Only Web-Push-aware module on the server. | yes — only module that does |
| `server/src/routes/web-push.ts` | `POST /api/web-push/subscribe`, `GET /api/web-push/devices`, `DELETE /api/web-push/subscriptions/:id` | no |
| `server/src/lib/device-label.ts` | Pure: `deriveDeviceLabel(userAgent) → string`. Regex on UA to produce "Platform · Browser". | no |
| `client/public/sw.js` | Plain-JS service worker. `install` (skipWaiting), `activate` (clients.claim), `push` (showNotification), `notificationclick` (focus existing window or open new). Sits in `public/` so Vite serves it directly at `/sw.js` with the right scope. | no |
| `client/public/manifest.webmanifest` | PWA manifest (name, icons, theme, display=standalone, scope=/) | no |
| `client/public/icons/icon-{192,512}.png`, `icon-512-maskable.png` | Three PNG app icons | no |
| `client/src/lib/web-push.ts` | Client-side helpers: `registerSW()`, `subscribePush()`, `unsubscribePush()`, `getSubscriptionState()` | no |
| `client/src/components/WebPushSettings.tsx` | The 5-state UI: unsupported / permission-denied / available / enabled / ios-needs-pwa. Devices list with Remove buttons. | no |

### Modified modules

**Server:**
- `server/src/db/migrations.ts` — append migration v10: `web_push_subscriptions` table.
- `server/src/db/queries.ts` — CRUD helpers for the new table.
- `server/src/scheduler/cron.ts` — extend `ChannelName`, `CHANNEL_NAMES`, `EnabledChannels`. Add `web_push` case in `firePriceAlerts` switch. Update `getEnabledChannels` to flag web-push availability based on whether the user has any active subscriptions.
- `server/src/projects/firer.ts` — add `web_push` case in basket-alert dispatch (parallel to discord/ntfy/email/webhook).
- `server/src/config.ts` — add `webPushVapidPublic`, `webPushVapidPrivate`, `webPushSubject`.
- `server/src/index.ts` — mount `/api/web-push` route.
- `server/package.json` — add `web-push` dependency.
- `.env.example` — document new env vars.

**Client:**
- `client/index.html` — `<link rel="manifest" href="/manifest.webmanifest">` + `<meta name="theme-color">`.
- `client/src/main.tsx` — call `registerSW()` on mount.
- `client/src/types.ts` — add `WebPushSubscriptionRecord`, `WebPushDevice`, `SubscribePayload` types.
- `client/src/api.ts` — add web-push API wrappers reusing the existing `request<T>` helper.
- `client/src/pages/Settings.tsx` — embed `<WebPushSettings />` after the existing channel rows.

### Data flow on subscribe

```
User clicks "Enable browser notifications" in Settings
  ├─ Notification.requestPermission() → 'granted'
  ├─ navigator.serviceWorker.register('/sw.js') (idempotent — already registered at app boot)
  ├─ subscription = await registration.pushManager.subscribe({
  │     userVisibleOnly: true,
  │     applicationServerKey: <VAPID_PUBLIC, urlBase64ToUint8Array>
  │   })
  ├─ POST /api/web-push/subscribe {
  │     endpoint: subscription.endpoint,
  │     keys: { p256dh, auth },
  │     device_label: deriveDeviceLabel(navigator.userAgent)
  │   }
  │     └─ INSERT INTO web_push_subscriptions  (UPSERT — same endpoint UPDATEs)
  └─ UI refresh: state → 'enabled', devices list refetches
```

### Data flow on alert dispatch (per-tracker)

```
firePriceAlerts (existing path)
  ├─ existing 4 channels fire (unchanged)
  └─ NEW web_push channel:
       ├─ subs = getActiveWebPushSubscriptionsForUser(userId)
       ├─ skip if subs.length === 0
       ├─ apply per-(tracker, seller, web_push) cooldown gate (same notifications table — channel='web_push')
       ├─ if gate passes:
       │    └─ for each sub (Promise.allSettled):
       │         └─ web-push.sendNotification(sub, payload)
       │              ├─ on 410/404 → deleteWebPushSubscription(sub.id)
       │              ├─ on 5xx/network → log structured warning
       │              └─ on success → updateLastUsedAt(sub.id)
       └─ insert ONE notifications row for the channel (not per device)
```

Same flow for basket alerts via `firer.ts`.

### Module boundaries

- `web-push.ts` is the only Web-Push-aware module on the server. Mockable in tests via `vi.mock('web-push')`.
- Routes for `/api/web-push/...` are isolated. Don't touch any other route handlers.
- `client/public/sw.js` is plain JS — bypasses Vite's module bundling. Lives at `/sw.js` after the build, registered with the root scope.
- `WebPushSettings.tsx` is the only client surface that talks to the Push API. Other components stay browser-API-clean.
- All web-push code under `server/src/notifications/web-push.{ts,test.ts}`, `server/src/routes/web-push.{ts,test.ts}`, `client/src/lib/web-push.ts`, `client/src/components/WebPushSettings.tsx`, `client/public/{sw.js,manifest.webmanifest,icons/}`. Disabling the feature is removing the channel entry from `CHANNEL_NAMES`; deleting it is `rm` of those files plus reverting four touch-points.

## Data model

### Migration v10

```sql
CREATE TABLE web_push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,        -- same browser+device returns the same endpoint
  p256dh_key TEXT NOT NULL,             -- public key for encryption (base64url)
  auth_key TEXT NOT NULL,               -- auth secret for encryption (base64url)
  device_label TEXT,                    -- friendly name from user-agent
  user_agent TEXT,                      -- raw UA for debugging
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
CREATE INDEX idx_web_push_subscriptions_user_id ON web_push_subscriptions(user_id);
```

`endpoint UNIQUE` makes UPSERT semantics natural — re-subscribing on the same browser updates the existing row instead of duplicating. `ON DELETE CASCADE` on user_id cleans up when a user is deleted.

### Types

```ts
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

// What the client POSTs to /api/web-push/subscribe
export interface SubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device_label?: string;
}

// What GET /api/web-push/devices returns (keys redacted)
export interface WebPushDevice {
  id: number;
  device_label: string | null;
  created_at: string;
  last_used_at: string | null;
}
```

## Service worker (`client/public/sw.js`)

Plain JS, not bundled. Sits in `client/public/sw.js`, served at `/sw.js` with root scope.

```js
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
    tag: payload.tag,         // browser coalesces same-tag notifications
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

`skipWaiting` + `clients.claim` make new versions take effect immediately. The `notificationclick` handler tries to focus an existing window before opening a new one (better mobile UX).

## Web App Manifest (`client/public/manifest.webmanifest`)

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

Three PNG icons in `client/public/icons/`. Theme color matches the existing dark navbar (verify hex against the design system).

## Push payloads

Both kept under 4KB (web-push limit). Server emits JSON; SW parses with text fallback.

**Per-tracker price alert:**
```json
{
  "title": "$279 — Samsung 990 Pro 4TB",
  "body": "Down from $349.99 — 12-month low",
  "url": "/trackers/123",
  "tag": "tracker-123-price"
}
```

**Bundle-ready alert:**
```json
{
  "title": "Bundle Ready: NAS Build",
  "body": "$1,189 / $1,200 target (8 items)",
  "url": "/projects/4",
  "tag": "project-4-basket"
}
```

The `tag` causes the OS notification panel to coalesce — if a tracker fires twice in a row, the second replaces the first rather than stacking.

## Settings UI — `<WebPushSettings />`

### 5-state component

| State | Trigger | UI |
|---|---|---|
| `unsupported` | `'serviceWorker' in navigator === false` OR `'PushManager' in window === false` | Toggle disabled, message: "Your browser doesn't support push notifications." |
| `permission-denied` | `Notification.permission === 'denied'` | Toggle disabled, message: "Notifications blocked. Enable in your browser settings." |
| `available` | No active subscription on this device | Toggle says **"Enable"** |
| `enabled` | Subscription exists for this device + permission granted | Toggle says **"Disable on this device"**, devices list renders |
| `ios-needs-pwa` | iOS Safari detected and not running as PWA (`window.matchMedia('(display-mode: standalone)').matches === false`) | Toggle disabled, inline iOS instructions render |

State detection on mount via `await navigator.serviceWorker.ready` + `registration.pushManager.getSubscription()`.

### Layout

```
┌────────────────────────────────────────────────────────┐
│ Browser notifications                          [Enable]│
│                                                        │
│ Receive price alerts as native browser notifications.  │
│ ⓘ On iPhone: Share → Add to Home Screen first, then    │
│   open from the home screen icon. (only when relevant) │
├────────────────────────────────────────────────────────┤
│ Registered devices                                     │
│ • MacBook · Chrome — added 3 days ago        [Remove]  │
│ • iPhone · Safari — added 2 hours ago        [Remove]  │
├────────────────────────────────────────────────────────┤
│ Cooldown:  [  0  ] hours    (0 = no cooldown)          │
└────────────────────────────────────────────────────────┘
```

Sits in `client/src/pages/Settings.tsx` after the four existing channel rows. Reuses the existing card and row styles.

### Subscription lifecycle

**Subscribe:**
```
1. await Notification.requestPermission() → must be 'granted' to proceed
2. await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: <VAPID_PUBLIC bytes> })
3. POST /api/web-push/subscribe { endpoint, keys: {p256dh, auth}, device_label }
4. UI refresh: state → 'enabled', devices refetches
```

**Unsubscribe (this device):**
```
1. await subscription.unsubscribe()
2. DELETE /api/web-push/subscriptions/:id
3. UI refresh: state → 'available'
```

**Remove a different device's subscription:**
```
1. DELETE /api/web-push/subscriptions/:id  (server-side row removed; we can't unsubscribe a different browser's PushManager)
2. Next push to that device returns 410 → firer cleans up server-side; deletion already happened, so it's a no-op
```

### Device labeling — pure helper

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

Pure function. Six unit tests cover the major UA shapes.

### VAPID public key on the client

Embedded at build time via Vite env: `import.meta.env.VITE_VAPID_PUBLIC_KEY`. Set in `.env` (read by Vite during dev + build) alongside `WEB_PUSH_VAPID_PUBLIC_KEY` (read by the server — same value). Rotating keys requires rebuild + redeploy + every device re-subscribing — acceptable for a single-deployment homelab tool.

### REST routes

| Method | Path | Body / Returns |
|---|---|---|
| `POST` | `/api/web-push/subscribe` | `{ endpoint, keys: {p256dh, auth}, device_label? }` → 201 + new device record |
| `GET` | `/api/web-push/devices` | List the user's `WebPushDevice` rows (no keys exposed) |
| `DELETE` | `/api/web-push/subscriptions/:id` | 204 if owned by req.user; 404 otherwise |

All routes scoped to `req.user.userId`. Subscribe handles UPSERT — same endpoint UPDATEs keys + device_label rather than creating a duplicate.

### Service worker registration

In `client/src/main.tsx`, on app boot:

```ts
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .catch(err => console.warn('SW registration failed', err));
}
navigator.serviceWorker?.addEventListener('message', e => {
  if (e.data?.type === 'navigate' && typeof e.data.url === 'string') {
    window.location.href = e.data.url;
  }
});
```

Registration is idempotent. The SW handles its own lifecycle. Navigation messages from the SW (when an open window receives a notification click) reload to the target URL — full reload is fine for v1.

## Error handling

| Failure | Behavior | User impact |
|---|---|---|
| Web Push send returns `410 Gone` or `404 Not Found` | Delete the subscription row immediately (browser invalidated it) | Device disappears from registered list on next refresh |
| Web Push send returns `413 Payload Too Large` | Log structured + skip. (Shouldn't happen — payloads < 200 bytes; surface only if a future change blows past 4KB) | Alert silently dropped on this device |
| Web Push send returns `429 Rate Limited` | Log + skip; next alert retries naturally | Alert dropped on this device |
| Web Push send 5xx / network failure | Log + skip; subscription stays | Alert dropped on this device |
| VAPID keys missing/invalid at startup | Log fatal; web-push channel stays silently skipped (other 4 channels unaffected) | No web push delivery; UI shows `unsupported` for clarity |
| Service worker fails to register | UI state = `unsupported`, toggle disabled | User can't enable web push; other channels still work |
| Push permission revoked after subscription | Server keeps row until first delivery returns 410 → row deleted | Next time user opens Settings, state = `available` |
| Cross-user `DELETE /api/web-push/subscriptions/:id` | Route checks `row.user_id === req.user.userId`; mismatch → 404 (don't leak existence) | n/a (defensive) |
| User toggles off-then-on rapidly | Same `endpoint` returns from `pushManager.subscribe()`; UPSERT handles it (no duplicate row) | Smooth re-subscribe |
| Sub fires for archived project | Channel-fanout in `firer.ts` already gates on `status === 'active'` | No web push for archived projects |
| Firer throws while preparing web-push payload | Caught by the firer's existing top-level try/catch — basket eval continues for other channels | Other channels still fire |

## Observability

Structured logs at every web-push event:

- `web_push_subscribe` (info) `{ user_id, device_label, endpoint_host }`
- `web_push_unsubscribe` (info) `{ user_id, subscription_id }`
- `web_push_send` (info) `{ user_id, subscription_id, status, latency_ms }`
- `web_push_subscription_stale` (info) `{ user_id, subscription_id, status }` — emitted alongside the auto-delete
- `web_push_send_failed` (warn) `{ user_id, subscription_id, status, err }` — non-410 errors

`endpoint_host` is the hostname of the push endpoint (`fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`) — useful for spotting browser-specific delivery problems.

## Testing

| Layer | File | Approx tests |
|---|---|---|
| Pure device-label heuristic | `server/src/lib/device-label.test.ts` | ~6 — Chrome/Mac, Safari/iPhone, Firefox/Windows, Edge/Mac, Chrome/Android, generic fallback |
| Migration v10 | `server/src/db/migration-v10.test.ts` | ~5 — table created, UNIQUE on endpoint, FK CASCADE, idempotent, index on user_id present |
| DB queries (web push) | `server/src/db/queries.web-push.test.ts` | ~8 — UPSERT subscribe, getActiveForUser, deleteById with cross-user guard, deleteByEndpoint (for 410 cleanup), updateLastUsedAt |
| Web Push sender | `server/src/notifications/web-push.test.ts` | ~10 — success path, 410 cleanup deletes row, 404 cleanup deletes row, 5xx logs without delete, payload-shape sanity, multi-device fanout via Promise.allSettled, missing VAPID keys → no-op |
| Web Push routes | `server/src/routes/web-push.test.ts` | ~8 — auth required, subscribe + UPSERT, list devices (keys redacted), delete with cross-user 404, validation rejects malformed payload |
| Cron integration | `server/src/scheduler/cron-web-push.test.ts` | ~4 — fires alongside other channels on price-change scrape, respects per-channel cooldown, no-op when user has no subs, no-op when permission revoked (handled via 410 cleanup) |
| Firer integration (basket alerts) | extend `server/src/projects/firer.test.ts` | ~2 — fires web_push for basket-ready, respects cooldown |

**Target: ~43 new tests.** Server suite goes from 445 → ~488.

**Not unit-tested:**
- Service worker (`client/public/sw.js`) — no good way in Node. Validated via DevTools manual exercise + the smoke test below.
- React component subscription flow — visual / browser-API-driven; manual exercise.

## Rollout

1. **Generate VAPID keys** locally: `npx web-push generate-vapid-keys`. Three values: subject (use a `mailto:` URL), public key, private key.
2. **Add to `.env`** on CT 302:
   ```
   WEB_PUSH_VAPID_PUBLIC_KEY=BJ...
   WEB_PUSH_VAPID_PRIVATE_KEY=...
   WEB_PUSH_SUBJECT=mailto:andrew.schultz.w@gmail.com
   VITE_VAPID_PUBLIC_KEY=BJ...
   ```
3. **Deploy** (`bash scripts/deploy.sh` from local). Migration v10 runs, server starts with VAPID keys configured, client bundle has the public key embedded.
4. **Manual smoke test in browser:**
   - Open https://prices.schultzsolutions.tech/settings
   - Click "Enable browser notifications" — accept the OS permission prompt
   - Verify your device appears in the registered list
   - Trigger a price drop on any tracker (manually edit `last_price` in DB above target, then click "Check Now") → confirm a native notification arrives
   - Click the notification → confirm it opens the relevant tracker
   - Click "Remove" on the device → confirm the subscription disappears
5. **Repeat on phone** via the iOS/Android PWA install flow.

## Out of scope for v1

Deferred to v2 if v1 lands well:

- Error alerts via web push (price scrape failures pushed to the user)
- Action buttons in notifications ("Mark as seen", "Open tracker")
- Background sync (the app continues working offline and replays mutations on reconnect)
- Offline dashboard cache (would need to handle stale-data warnings)
- "Quiet hours" / do-not-disturb (push only between 8am-9pm)
- Rich notifications with images (product photos in the panel)
- Per-tracker push opt-out (today: all-or-nothing per channel — same as existing channels)

## Open questions resolved

- **VAPID rotation:** not needed for v1. Single keypair lives in `.env`; rotation requires rebuild + redeploy + every device re-subscribing. Acceptable.
- **Rate limiting on `/subscribe`:** not needed. Auth gates it; spam-subscribing your own account is harmless.
- **Subscription expiry policy:** rely on natural expiry. The browser sends 410 when the subscription is invalidated, the firer cleans up, the user re-subscribes from Settings. No proactive expiry sweep.
