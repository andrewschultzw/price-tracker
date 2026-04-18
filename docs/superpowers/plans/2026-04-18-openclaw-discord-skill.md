# OpenClaw Discord Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable creating Price Tracker entries by DMing the OpenClaw Discord bot via a new `X-API-Key` auth path on the server + a new `price-tracker` skill file on CT 301.

**Architecture:** Single shared API key in `.env` on CT 302 (server) and CT 301 (OpenClaw). New `auth/apiKey.ts` middleware runs before the existing JWT middleware on `/api/*` routes: if `X-API-Key` header matches and the key is configured, sets `req.user` from a DB lookup of `PRICE_TRACKER_API_KEY_USER_ID`; if absent, falls through to JWT; if present but wrong, 401. Route handlers (including the existing `POST /api/trackers`) work unchanged. OpenClaw reuses its natural-language agent + Discord gateway — no new bot plumbing.

**Tech Stack:** Express, better-sqlite3, crypto.timingSafeEqual, OpenClaw SKILL.md format.

**Spec:** `docs/superpowers/specs/2026-04-18-openclaw-discord-skill-design.md`

**Branch:** `feature/openclaw-discord-skill` (spec commit present).

---

## Task 1: Server config — API key + isApiKeyConfigured helper

**Files:**
- Modify: `server/src/config.ts`

- [ ] **Step 1: Extend the config object**

In `server/src/config.ts`, add two new fields to the `config` object alongside the existing SMTP fields:

```typescript
  // OpenClaw / programmatic API key. Single shared key in this env;
  // any request presenting it on X-API-Key acts as user N
  // (PRICE_TRACKER_API_KEY_USER_ID). Empty string disables the auth
  // path — the server still accepts JWT cookies as before.
  priceTrackerApiKey: process.env.PRICE_TRACKER_API_KEY || '',
  priceTrackerApiKeyUserId: parseInt(process.env.PRICE_TRACKER_API_KEY_USER_ID || '0', 10),
```

Add these lines immediately after `smtpFrom` and before `isProduction`.

- [ ] **Step 2: Add the `isApiKeyConfigured` helper**

Below the existing `isEmailConfigured()` function, add:

```typescript
/**
 * True when both the API key and its mapped user ID are set. Used by
 * the X-API-Key middleware to decide whether to enforce the header or
 * fall through. When false, the middleware treats a missing header as
 * "use JWT" and a present header as "misconfigured" (401).
 */
export function isApiKeyConfigured(): boolean {
  return !!(config.priceTrackerApiKey && config.priceTrackerApiKeyUserId > 0);
}
```

- [ ] **Step 3: TypeCheck**

Run: `cd /root/price-tracker/server && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add server/src/config.ts
git commit -m "feat(server): add PRICE_TRACKER_API_KEY config + isApiKeyConfigured

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: API-key middleware + unit tests

**Files:**
- Create: `server/src/auth/apiKey.ts`
- Create: `server/src/auth/apiKey.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/auth/apiKey.test.ts` with EXACTLY this content:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock config and user-queries before importing the module under test.
vi.mock('../config.js', () => ({
  config: {
    priceTrackerApiKey: 'test-api-key-123456',
    priceTrackerApiKeyUserId: 7,
  },
  isApiKeyConfigured: () => true,
}));

vi.mock('../db/user-queries.js', () => ({
  getUserById: vi.fn((id: number) => {
    if (id === 7) {
      return { id: 7, email: 'admin@example.com', role: 'admin' };
    }
    return undefined;
  }),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { apiKeyMiddleware } from './apiKey.js';

function makeReqResNext(header?: string) {
  const req = { header: vi.fn((name: string) => (name.toLowerCase() === 'x-api-key' ? header : undefined)), path: '/api/trackers', method: 'POST' } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('apiKeyMiddleware', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls next() without setting req.user when header is absent', () => {
    const { req, res, next } = makeReqResNext(undefined);
    apiKeyMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when header is the empty string (treated as absent)', () => {
    const { req, res, next } = makeReqResNext('');
    apiKeyMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toBeUndefined();
  });

  it('sets req.user and calls next() on a matching key', () => {
    const { req, res, next } = makeReqResNext('test-api-key-123456');
    apiKeyMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toEqual({ userId: 7, email: 'admin@example.com', role: 'admin' });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 on a wrong key', () => {
    const { req, res, next } = makeReqResNext('wrong-key');
    apiKeyMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
  });

  it('returns 401 on a mismatched-length key without crashing', () => {
    const { req, res, next } = makeReqResNext('short');
    apiKeyMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when the mapped user does not exist in the DB', async () => {
    const userQueries = await import('../db/user-queries.js');
    (userQueries.getUserById as any).mockReturnValueOnce(undefined);
    const { req, res, next } = makeReqResNext('test-api-key-123456');
    apiKeyMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('apiKeyMiddleware when API key auth is not configured', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when a header is set but auth is unconfigured', async () => {
    // Re-mock isApiKeyConfigured to return false for this block
    vi.doMock('../config.js', () => ({
      config: { priceTrackerApiKey: '', priceTrackerApiKeyUserId: 0 },
      isApiKeyConfigured: () => false,
    }));
    vi.resetModules();
    const { apiKeyMiddleware: mw } = await import('./apiKey.js');
    const { req, res, next } = makeReqResNext('anything');
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'API key auth not configured' });
    // Restore for subsequent suites
    vi.doUnmock('../config.js');
    vi.resetModules();
  });

  it('calls next() without setting req.user when header absent AND unconfigured (fall-through to JWT)', async () => {
    vi.doMock('../config.js', () => ({
      config: { priceTrackerApiKey: '', priceTrackerApiKeyUserId: 0 },
      isApiKeyConfigured: () => false,
    }));
    vi.resetModules();
    const { apiKeyMiddleware: mw } = await import('./apiKey.js');
    const { req, res, next } = makeReqResNext(undefined);
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toBeUndefined();
    vi.doUnmock('../config.js');
    vi.resetModules();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /root/price-tracker/server && npx vitest run src/auth/apiKey.test.ts`
Expected: FAIL with "Cannot find module './apiKey.js'".

- [ ] **Step 3: Implement the middleware**

Create `server/src/auth/apiKey.ts` with EXACTLY this content:

```typescript
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config, isApiKeyConfigured } from '../config.js';
import { getUserById } from '../db/user-queries.js';
import { logger } from '../logger.js';

/**
 * X-API-Key auth middleware. Mounted BEFORE the JWT cookie middleware
 * on /api/* routes. Behavior:
 *
 *   - Header absent or empty   → next() with req.user unset; JWT handles it
 *   - Header present + API key auth not configured → 401
 *   - Header present + matches configured key      → sets req.user from
 *     getUserById(PRICE_TRACKER_API_KEY_USER_ID) and calls next()
 *   - Header present + wrong / mismatched length   → 401
 *
 * Uses timingSafeEqual over equal-length Buffers so a mismatched length
 * doesn't crash and a right-prefix doesn't leak information via timing.
 * Never logs the incoming header or the configured key. Successful
 * requests log at info level with a fixed "api-key" source tag for
 * audit purposes.
 */
export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.header('x-api-key');

  // Missing / empty header: let the next middleware (JWT) handle auth.
  if (!headerValue) {
    next();
    return;
  }

  // Header set but API key auth not configured on this deploy → fail
  // closed. Matches the principle: if someone is reaching for header
  // auth, the server shouldn't silently accept/deny without reason.
  if (!isApiKeyConfigured()) {
    res.status(401).json({ error: 'API key auth not configured' });
    return;
  }

  // Constant-time compare over equal-length buffers. If the lengths
  // differ, skip the compare entirely and 401 — timingSafeEqual would
  // throw on length mismatch otherwise.
  const expected = Buffer.from(config.priceTrackerApiKey);
  const got = Buffer.from(headerValue);
  const matches = got.length === expected.length && timingSafeEqual(got, expected);

  if (!matches) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Key is good. Look up the configured user so role-gated middleware
  // (e.g., adminMiddleware) still works downstream.
  const user = getUserById(config.priceTrackerApiKeyUserId);
  if (!user) {
    logger.warn(
      { userId: config.priceTrackerApiKeyUserId },
      'API key matched but PRICE_TRACKER_API_KEY_USER_ID does not exist',
    );
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  req.user = { userId: user.id, email: user.email, role: user.role };

  logger.info(
    { source: 'api-key', path: req.path, method: req.method, userId: user.id },
    'API key auth succeeded',
  );

  next();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/price-tracker/server && npx vitest run src/auth/apiKey.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 5: Run full server suite**

Run: `cd /root/price-tracker/server && npm test`
Expected: baseline + 8 new. Count will depend on what's currently on main; if the branch started at 222, expect 230.

- [ ] **Step 6: Commit**

```bash
git add server/src/auth/apiKey.ts server/src/auth/apiKey.test.ts
git commit -m "feat(server): X-API-Key middleware for programmatic access

Adds a second auth path alongside the existing JWT-cookie middleware.
Missing header falls through to JWT; present header must match the
single configured key in env. On match, sets req.user from the
configured user ID so role-gated routes keep working.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Wire middleware in index.ts

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Import the middleware**

In `server/src/index.ts`, extend the existing auth import:

```typescript
import { authMiddleware, adminMiddleware } from './auth/middleware.js';
import { apiKeyMiddleware } from './auth/apiKey.js';
```

- [ ] **Step 2: Apply apiKeyMiddleware BEFORE authMiddleware on each protected route**

Find the existing route mounts (around lines 74-78):

```typescript
app.use('/api/trackers', authMiddleware, trackerRoutes);
app.use('/api/trackers', authMiddleware, priceRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/notifications', authMiddleware, notificationRoutes);
app.use('/api/admin', authMiddleware, adminMiddleware, adminRoutes);
```

Replace each with the two-middleware chain (API key first, JWT second):

```typescript
app.use('/api/trackers', apiKeyMiddleware, authMiddleware, trackerRoutes);
app.use('/api/trackers', apiKeyMiddleware, authMiddleware, priceRoutes);
app.use('/api/settings', apiKeyMiddleware, authMiddleware, settingsRoutes);
app.use('/api/notifications', apiKeyMiddleware, authMiddleware, notificationRoutes);
app.use('/api/admin', apiKeyMiddleware, authMiddleware, adminMiddleware, adminRoutes);
```

The API-key middleware either:
- Sets `req.user` and calls `next()` → JWT middleware sees `req.user` already populated and should skip cookie lookup. BUT the existing JWT middleware doesn't check for a pre-populated user — it always tries to read the cookie and 401s on missing cookie. We need to make authMiddleware a no-op when req.user is already set.

- [ ] **Step 3: Update authMiddleware to skip when req.user already populated**

In `server/src/auth/middleware.ts`, change `authMiddleware` to:

```typescript
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // If an earlier middleware (e.g., apiKeyMiddleware) has already set
  // req.user, skip the cookie check — the request is already authenticated.
  if (req.user) {
    next();
    return;
  }

  const token = req.cookies?.access_token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
```

- [ ] **Step 4: TypeCheck + full test suite**

Run: `cd /root/price-tracker/server && npx tsc --noEmit && npm test`
Expected: all tests still pass. The change to `authMiddleware` is additive (new short-circuit at the top); no existing behavior changes when `req.user` is undefined.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/src/auth/middleware.ts
git commit -m "feat(server): wire apiKeyMiddleware on /api/* before authMiddleware

authMiddleware now skips cookie check when req.user is already set by
an earlier middleware. Order: apiKeyMiddleware -> authMiddleware. The
API-key path fully authenticates and short-circuits the cookie path.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Deploy to CT 302 + curl smoke test

- [ ] **Step 1: Generate a random API key**

From CT 300:

```bash
openssl rand -hex 32
```

Copy the resulting 64-character hex string — it's the value for `PRICE_TRACKER_API_KEY`.

- [ ] **Step 2: Append to CT 302's `.env`**

```bash
ssh root@192.168.1.166 'bash -s' <<REMOTE
cat >> /opt/price-tracker/.env <<'ENVBLOCK'

# OpenClaw / programmatic API key (single shared)
PRICE_TRACKER_API_KEY=<paste the 64-hex value from Step 1>
PRICE_TRACKER_API_KEY_USER_ID=1
ENVBLOCK
grep -oE '^PRICE_TRACKER_API_KEY[_A-Z]*=' /opt/price-tracker/.env
REMOTE
```

Replace `<paste the 64-hex value from Step 1>` with the actual generated key. Verify the grep output shows both variable names.

- [ ] **Step 3: Deploy**

```bash
cd /root/price-tracker && bash scripts/deploy.sh 2>&1 | tail -8
```

Expected: build succeeds, service restarts clean.

- [ ] **Step 4: Verify service health**

```bash
ssh root@192.168.1.166 'systemctl is-active price-tracker && journalctl -u price-tracker -n 10 --no-pager | tail -5'
```

Expected: `active`; last lines show "Price Tracker running on port 3100" with no startup errors.

- [ ] **Step 5: Curl smoke test (correct key)**

From CT 300:

```bash
curl -sS -H "X-API-Key: <the-64-hex-key>" http://192.168.1.166:3100/api/trackers | python3 -c "import sys, json; d = json.load(sys.stdin); print(f'OK: {len(d)} trackers returned')"
```

Expected: `OK: 22 trackers returned` (or whatever the current count is).

- [ ] **Step 6: Curl smoke test (wrong key → 401)**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -H "X-API-Key: wrong-value" http://192.168.1.166:3100/api/trackers
```

Expected: `401`.

- [ ] **Step 7: Curl smoke test (missing header → 401 from JWT path)**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://192.168.1.166:3100/api/trackers
```

Expected: `401` (JWT auth rejects because no cookie — proves the fall-through works).

- [ ] **Step 8: No commit needed** (this is a deploy + smoke test task, no code change).

---

## Task 5: OpenClaw-side setup (env + SKILL.md)

**Files:**
- Create on CT 301: `~/.openclaw/workspace/skills/price-tracker/SKILL.md`
- Modify on CT 301: OpenClaw's env file (path TBD — likely `~/.openclaw/.env` or systemd EnvironmentFile)

- [ ] **Step 1: Locate OpenClaw's env config on CT 301**

```bash
ssh root@192.168.1.165 'systemctl cat openclaw 2>/dev/null | grep -E "EnvironmentFile|Environment" ; ls -la ~/.openclaw/.env 2>/dev/null'
```

Expected output: either an `EnvironmentFile=...` line from systemd, or confirmation that `~/.openclaw/.env` exists. Whichever path is shown is the one to edit in step 2.

If nothing is found, fall back to checking `ls ~/.openclaw/` for an `env`, `.env`, or `config.env` file.

- [ ] **Step 2: Append PRICE_TRACKER_API_KEY to OpenClaw's env**

Substitute `<env-path>` with the path found in Step 1. Example (adjust the path):

```bash
ssh root@192.168.1.165 'bash -s' <<REMOTE
cat >> <env-path> <<'ENVBLOCK'

# Price Tracker API (single shared key; see price-tracker skill)
PRICE_TRACKER_API_KEY=<same 64-hex value as CT 302>
ENVBLOCK
grep '^PRICE_TRACKER_API_KEY=' <env-path> | sed 's/=.*/=<redacted>/'
REMOTE
```

- [ ] **Step 3: Create the skill directory**

```bash
ssh root@192.168.1.165 'mkdir -p ~/.openclaw/workspace/skills/price-tracker'
```

- [ ] **Step 4: Write SKILL.md to CT 301**

Save the skill content below to a local file first:

```bash
cat > /tmp/price-tracker-skill.md <<'SKILL'
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

Do not send `check_interval_minutes` or `css_selector` — the server uses sensible defaults.

### Success response (201)

```json
{
  "id": 42,
  "name": "JetKVM",
  "url": "https://a.co/d/abc",
  "threshold_price": 75,
  "last_price": 99,
  "status": "active"
}
```

Reply to the user with a concise confirmation:

> Added **{name}** at ${last_price} (target ${threshold_price}).
> https://prices.schultzsolutions.tech/tracker/{id}

Pull `name`, `last_price`, `threshold_price`, and `id` from the response. If `threshold_price` is null, skip the target line.

### Error handling

Apply these rules before replying:

- **401 `Invalid API key`** → "Price Tracker auth failed — the API key on this CT doesn't match what the server expects. Check `PRICE_TRACKER_API_KEY` in both envs."
- **400 with a Zod error** → "That URL didn't validate: `{error.url._errors[0]}`" (surface the first Zod message).
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

Call `POST /trackers { url: "https://amazon.com/dp/B0XYZ", threshold_price: 30 }`
Reply: "Added **Awesome Widget** at $35.99 (target $30). https://prices.schultzsolutions.tech/tracker/43"

### User says: "watch this: https://newegg.com/p/N82E123"

Call `POST /trackers { url: "https://newegg.com/p/N82E123" }`
Reply: "Added **NAS Drive 18TB** at $459.95 (no target set). https://prices.schultzsolutions.tech/tracker/44"
SKILL
```

Copy to CT 301:

```bash
scp -q /tmp/price-tracker-skill.md root@192.168.1.165:~/.openclaw/workspace/skills/price-tracker/SKILL.md
```

- [ ] **Step 5: Verify the skill file lands**

```bash
ssh root@192.168.1.165 'head -10 ~/.openclaw/workspace/skills/price-tracker/SKILL.md'
```

Expected: the YAML frontmatter `name: price-tracker` and the first few lines.

- [ ] **Step 6: Restart OpenClaw so it picks up the new skill + env var**

```bash
ssh root@192.168.1.165 'systemctl --user restart openclaw 2>/dev/null || systemctl restart openclaw'
```

Try both invocations — OpenClaw may run as a user service or a system service. Verify it's active afterward:

```bash
ssh root@192.168.1.165 'systemctl --user status openclaw 2>/dev/null || systemctl status openclaw | head -5'
```

Expected: `active (running)`.

- [ ] **Step 7: Commit** (only the spec/plan — SKILL.md lives on CT 301, not in this repo).

Nothing to commit on this task. Proceed to Task 6.

---

## Task 6: End-to-end Discord smoke test

- [ ] **Step 1: DM OpenClaw a create request**

In Discord, DM the OpenClaw bot:

> track this: https://www.ikoolcore.com/products/jetkvm for $80

(Pick any product URL you don't already track. Use a low-risk stable domain like ikoolcore.)

- [ ] **Step 2: Confirm OpenClaw's reply**

Expected reply format:

> Added **JetKVM** at $99.00 (target $80).
> https://prices.schultzsolutions.tech/tracker/{new-id}

If it replies with an error, check OpenClaw's logs:

```bash
ssh root@192.168.1.165 'journalctl --user -u openclaw -n 40 --no-pager 2>/dev/null || journalctl -u openclaw -n 40 --no-pager'
```

Typical failure modes:
- `Price Tracker auth failed` → the two envs don't match; re-check Step 2 of Task 5.
- `Couldn't extract a price` → retailer blocked the scrape. Try a different URL.
- `Price Tracker didn't respond` → CT 302 is down or firewall.

- [ ] **Step 3: Verify the tracker appears in the web UI**

Open https://prices.schultzsolutions.tech → the new tracker should be on the dashboard with its initial price and threshold.

- [ ] **Step 4: Verify the server audit log**

```bash
ssh root@192.168.1.166 'journalctl -u price-tracker -n 50 --no-pager | grep "api-key"'
```

Expected: at least one line with `"source":"api-key"` and the correct path `/trackers` (or `/api/trackers` depending on how the middleware reports it).

- [ ] **Step 5: Curl a wrong-key request post-rollout**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" -H "X-API-Key: definitely-wrong" http://192.168.1.166:3100/api/trackers
```

Expected: `401`. Confirms the API-key middleware is actually checking.

---

## Task 7: Docs + PR

- [ ] **Step 1: Mark the todo done**

Edit `tasks/todo.md` — change the OpenClaw integration line to `[x]` with a done summary:

```markdown
- [x] **OpenClaw integration.** ~~Discord bot skill that accepts a product link + threshold.~~ **Done 2026-04-18:** added `X-API-Key` auth middleware (`server/src/auth/apiKey.ts`) that runs before the JWT middleware on `/api/*`. Single shared key in env (`PRICE_TRACKER_API_KEY` + `PRICE_TRACKER_API_KEY_USER_ID`) maps every inbound request to the configured user. New `price-tracker` skill file on CT 301 teaches OpenClaw's agent to POST to `/api/trackers`. DM the Discord bot "track this: <url> for $30" → tracker appears. Create-only by design; list/check/delete stay in the web UI. Spec: `docs/superpowers/specs/2026-04-18-openclaw-discord-skill-design.md`. Plan: `docs/superpowers/plans/2026-04-18-openclaw-discord-skill.md`.
```

- [ ] **Step 2: Update lessons.md if anything surprising came up during Task 4-6**

If the deploy or OpenClaw setup surfaced a non-obvious gotcha, add a short entry to `tasks/lessons.md`. If not, skip.

- [ ] **Step 3: Push branch**

```bash
git add tasks/todo.md tasks/lessons.md 2>/dev/null
git diff --cached --quiet || git commit -m "docs: mark OpenClaw integration done

Co-Authored-By: Claude <noreply@anthropic.com>"
git push -u origin feature/openclaw-discord-skill
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat: OpenClaw Discord skill + X-API-Key auth" --body "$(cat <<'EOF'
## Summary

Enables creating Price Tracker entries by DMing the OpenClaw Discord bot. New auth path on the server accepts `X-API-Key` alongside the existing JWT cookie; OpenClaw's natural-language agent uses the key to POST `/api/trackers` when the user sends a URL in chat.

Scope is **create-only** by design — list / check / delete still live in the web UI.

## Changes

- **`server/src/config.ts`** — new `priceTrackerApiKey` + `priceTrackerApiKeyUserId` fields, `isApiKeyConfigured()` helper.
- **`server/src/auth/apiKey.ts` (new)** — middleware that reads `X-API-Key`, constant-time-compares against the configured key, looks up the mapped user, sets `req.user`. Missing header → fall through to JWT. Present but wrong → 401. Audit-logs successful hits at info level with source `api-key`.
- **`server/src/auth/middleware.ts`** — JWT middleware short-circuits when `req.user` is already populated (by the API-key middleware).
- **`server/src/index.ts`** — wires `apiKeyMiddleware` BEFORE `authMiddleware` on every `/api/*` route.
- **OpenClaw side (CT 301)** — new `~/.openclaw/workspace/skills/price-tracker/SKILL.md` documenting the API for the agent. Env var `PRICE_TRACKER_API_KEY` in OpenClaw's env.

## Spec + plan

- Spec: `docs/superpowers/specs/2026-04-18-openclaw-discord-skill-design.md`
- Plan: `docs/superpowers/plans/2026-04-18-openclaw-discord-skill.md`

## Test plan

- [x] 8 new server tests covering `apiKeyMiddleware`: missing header, empty header, matching key, wrong key, mismatched length, missing user, unconfigured + header, unconfigured + no header
- [x] Deploy to CT 302 — service starts clean
- [x] Curl smoke: correct key → list; wrong key → 401; no header → 401 (JWT path)
- [x] OpenClaw skill deployed, env set, bot restarted
- [x] End-to-end: DM bot → tracker appears in UI; audit log shows `source:api-key`

## Trust model

Single shared key exposes the admin user's full API surface. Same as the JWT cookie the web UI already uses. Both envs (CT 302, CT 301) live on trusted LAN CTs; the public `prices.schultzsolutions.tech` endpoint sits behind Cloudflare Access regardless of auth method.

## Merge order

Stacks on top of #5 (canary) and #6 (overlap). Merge those first to shrink this PR's diff.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Backfill PR number in `tasks/todo.md`**

Once the PR URL is known, edit the todo entry to add `[PR #N](...)` at the end, then:

```bash
git add tasks/todo.md
git commit -m "docs: backfill PR link for OpenClaw skill

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

---

## Self-review notes

- **Spec coverage:** every section of the spec maps to a task — config/helper (Task 1), middleware + tests (Task 2), wiring (Task 3), env var setup (Task 4+5), skill file (Task 5), smoke (Task 6), docs (Task 7).
- **No placeholders remain** except two explicit substitution points in Task 4 Step 2 and Task 5 Step 2 where the engineer pastes the generated key. Those are intentional runtime values.
- **Type consistency:** `apiKeyMiddleware` matches the Express `(Request, Response, NextFunction) => void` signature used by the existing `authMiddleware`. `req.user` shape matches `TokenPayload` from tokens.ts.
- **One risk noted:** Task 3's change to authMiddleware (short-circuit on `req.user` set) could break if any future middleware populates `req.user` without actually authenticating. The plan doesn't add such a middleware, but flagging in case future work introduces one.
