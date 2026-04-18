# OpenClaw Discord Skill for Price Tracker — Design

**Date:** 2026-04-18
**Status:** Approved
**Author:** Andrew Schultz + Claude

## Overview

Enable creating Price Tracker entries by DMing the OpenClaw Discord bot. User sends natural language like "track this: <url> for $30", OpenClaw's agent loads a new `price-tracker` skill that documents the Price Tracker API, and makes an authenticated POST to create the tracker. Confirms back with the tracker name and scraped initial price.

Scope is deliberately narrow: **create-only**. No list / check / delete — the web UI already handles those, and chat-based CRUD is a lot of surface for a single-user homelab.

## Decisions

- **Auth model:** Single shared API key in env vars on CT 302 (Price Tracker) and CT 301 (OpenClaw). One key, one designated owning user (the admin). No per-user keys, no DB table, no UI. Acceptable at 1-active-user scale; upgrade path documented in "Out of scope".
- **Transport:** Reuse the existing `POST /api/trackers` route and `X-API-Key` header. No new endpoints.
- **Discord inbound path:** Use OpenClaw's existing Discord gateway + natural-language agent. No new Discord slash commands or bot plumbing.
- **Skill file format:** Mirrors the existing Paperless / Actual Budget skill structure (`SKILL.md` with `{{env.VAR}}` substitution).

## Server changes

### New env vars

`/opt/price-tracker/.env`:

```
PRICE_TRACKER_API_KEY=<32-byte random hex>
PRICE_TRACKER_API_KEY_USER_ID=1
```

Loaded in `server/src/config.ts` alongside the existing SMTP / JWT config:

```typescript
priceTrackerApiKey: process.env.PRICE_TRACKER_API_KEY || '',
priceTrackerApiKeyUserId: parseInt(process.env.PRICE_TRACKER_API_KEY_USER_ID || '0', 10),
```

`isApiKeyConfigured()` helper returns true when both are non-empty / non-zero. Middleware short-circuits if unconfigured so a deployment without the env vars behaves exactly like today.

### New middleware: `server/src/auth/apiKey.ts`

Exports an Express middleware that:

1. Reads the `X-API-Key` header. If absent or empty, calls `next()` and lets the downstream JWT-cookie auth handle the request.
2. If present and `!isApiKeyConfigured()`, returns 401 `{ error: 'API key auth not configured' }`. This prevents a misconfigured deploy from silently accepting any header.
3. If present and matches `config.priceTrackerApiKey` via `crypto.timingSafeEqual` over Buffer.from(...) to avoid timing oracle: sets `req.user = { userId: config.priceTrackerApiKeyUserId, role: <from DB lookup> }` and calls `next()`. Role is fetched via `getUserById(userId)` so downstream admin-only routes still enforce correctly.
4. If present but doesn't match: returns 401 `{ error: 'Invalid API key' }`.

Logs every successful API-key request at info level with `{ source: 'api-key', path, method, userId }`. Never logs the key value or the `X-API-Key` header.

### Middleware wiring

In `server/src/index.ts`, install the API key middleware BEFORE the existing JWT middleware on the `/api/*` subtree. The order is: API key → JWT → authenticated routes. Since the API key middleware either sets `req.user` (and routes proceed as authenticated) or falls through when no header is set, the JWT middleware only needs to handle the cookie path.

### Route reuse

`POST /api/trackers` already:

- Validates the body via the existing Zod schema (`name`, `url`, `threshold_price`, `check_interval_minutes`, `css_selector`)
- Uses `req.user.userId` for ownership
- Returns 201 with the full `Tracker` JSON

No changes needed. The API-key middleware transparently sets `req.user` so the route works without knowing how auth happened.

### Admin awareness

No new admin UI in this feature. Future work can add an API-key management page (generate, revoke, label) when the per-user-key model is introduced. For now, the single shared key is rotated by editing `.env` and restarting the service.

## OpenClaw changes

### New skill file

`/root/.openclaw/workspace/skills/price-tracker/SKILL.md` on CT 301:

```markdown
---
name: price-tracker
description: Create a tracker in the Price Tracker app when the user sends a product URL. Reports the tracker name, initial scraped price, and a link to the detail page.
version: 1.0.0
---

# Price Tracker — Create Tracker

You help the user add products to the Price Tracker app at https://prices.schultzsolutions.tech.

## Service

- **Base URL (LAN from CT 301):** `http://192.168.1.166:3100/api`
- **Auth header:** `X-API-Key: {{env.PRICE_TRACKER_API_KEY}}`

Include the auth header on every request. Never log or expose the key value.

## When to Use This Skill

The user sends a message that reads as "add this product to Price Tracker":

- "track this: <url>"
- "add to price tracker: <url>"
- "watch this for price drops: <url>"
- "save this product: <url> threshold $30"
- "<url> — notify me under $30"

Extract the URL and (optionally) a threshold price in dollars. If the user gives both, pass both. If only the URL, create without a threshold.

## Capability: Create a Tracker

### Request

```
POST /trackers
Content-Type: application/json
X-API-Key: {{env.PRICE_TRACKER_API_KEY}}
```

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| url | string | yes | The product URL (any retailer; short links OK) |
| threshold_price | number | no | Target price in dollars; omit if unspecified |
| name | string | no | Defaults to a value derived from the URL |
| check_interval_minutes | number | no | Default 360 (6h) — don't override unless the user asks |
| css_selector | string | no | Leave unset — the scraper pipeline figures it out |

### Success response (201)

```json
{
  "id": 42,
  "name": "JetKVM",
  "url": "https://a.co/d/abc",
  "threshold_price": 75,
  "last_price": 99,
  "status": "active",
  ...
}
```

Reply to the user with a concise confirmation:

> Added **{name}** at ${last_price} (target ${threshold_price}).
> https://prices.schultzsolutions.tech/tracker/{id}

Pull `name`, `last_price`, `threshold_price`, and `id` from the response. If `threshold_price` is null, skip the target line.

### Error handling

Apply these rules before replying:

- **401 `Invalid API key`** → "Price Tracker auth failed — the API key on this CT doesn't match what the server expects. Check `PRICE_TRACKER_API_KEY` in both envs."
- **400 with a Zod error object** → "That URL didn't validate: `{error.url._errors[0]}`" (surface the first Zod message).
- **500 with "Could not extract price"** → "Couldn't extract a price from that URL — the page may be blocking the scraper or the structure changed. Try it manually on the web UI to see the specifics."
- **500 with "Product is currently unavailable on Amazon"** → "Amazon shows that product as 'Currently unavailable'. It won't track until it's back in stock."
- **Network error / timeout** → "Price Tracker didn't respond at 192.168.1.166:3100 — the service might be down."
- **Never silently fail** — always surface the error in user-friendly terms.

## Do Not

- Delete, update, or pause existing trackers (this skill is create-only — tell the user to use the web UI for those operations).
- Call `POST /trackers/test-scrape` separately — the create endpoint runs its own scrape internally.
- List the user's existing trackers (no list capability here — again, web UI).
- Log the API key value.
- Retry on 500 errors automatically. If the first call fails, tell the user and stop.

## Examples

### User says: "track this: https://amazon.com/dp/B0XYZ for $30"

→ `POST /trackers { url: "https://amazon.com/dp/B0XYZ", threshold_price: 30 }`
→ Reply: "Added **Awesome Widget** at $35.99 (target $30). https://prices.schultzsolutions.tech/tracker/43"

### User says: "watch this: https://newegg.com/p/N82E123"

→ `POST /trackers { url: "https://newegg.com/p/N82E123" }`
→ Reply: "Added **NAS Drive 18TB** at $459.95 (no target set). https://prices.schultzsolutions.tech/tracker/44"
```

### OpenClaw env var

Append to OpenClaw's env file on CT 301 (verify path during deploy — likely `~/.openclaw/.env` or a systemd `EnvironmentFile`):

```
PRICE_TRACKER_API_KEY=<same value as server>
```

The `{{env.PRICE_TRACKER_API_KEY}}` substitution follows the same pattern Paperless uses today (`{{env.PAPERLESS_API_TOKEN}}`).

## Trust model

- One shared key = full write access to the admin user's tracker list. Equivalent to the JWT cookie the web UI already stores.
- Both endpoints (CT 302 env, CT 301 env) are on trusted homelab CTs behind the LAN.
- OpenClaw's agent is already trusted with admin-level read/write on Actual Budget, Paperless, and Directus. The Price Tracker skill adds one more service to that list, same trust level.
- No external exposure: the API key is only accepted on `/api/*` routes that also accept JWT auth today. The public route `https://prices.schultzsolutions.tech/api/*` sits behind Cloudflare Access, so even an attacker who obtained the key externally would need to pass Cloudflare Access first. And the key itself never leaves the homelab — both endpoints (CT 302, CT 301) are on the internal LAN.

## Error handling (server)

- Middleware returns 401 JSON with `{ error: string }` body — same shape as the existing auth failures.
- `timingSafeEqual` requires equal-length buffers; middleware pads/truncates the incoming header to the configured key length before the compare so a mismatched length still takes constant time.
- If `PRICE_TRACKER_API_KEY` env var is missing, middleware falls through to JWT — the API key path is opt-in and fail-closed.

## Testing

### Server unit tests

`server/src/auth/apiKey.test.ts`:

- Missing header → `next()` called, `req.user` unset.
- Correct header → `req.user.userId = configured id`, `next()` called.
- Wrong header → 401 response, `next()` not called.
- Empty string header value → treated as "missing", falls through.
- Key configured but incoming value is a different length → 401 (not a crash).
- `isApiKeyConfigured()` returns false and header set → 401 `{ error: 'API key auth not configured' }`.

### Smoke tests post-deploy

1. Curl from CT 300 (dev): `curl -H "X-API-Key: <key>" http://192.168.1.166:3100/api/trackers` → returns the admin's tracker list.
2. Curl with wrong key → 401 JSON.
3. DM OpenClaw: "track https://amazon.com/dp/B0XYZ for $30" → tracker appears in web UI within seconds.

## Out of scope

- Per-user API keys with a DB table and admin UI (upgrade path — open this when a second user wants bot access).
- List / check-now / delete / update operations from chat.
- Rate limiting on API-key requests (existing express-rate-limit applies to all `/api/*`).
- Discord slash commands (`/addtracker`) — using OpenClaw's natural-language path instead.
- Audit log UI for API-key-authenticated requests (they're in the structured logs; no need for a dashboard yet).
