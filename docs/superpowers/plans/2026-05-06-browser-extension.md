# Browser Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Chrome MV3 extension that adds the current page as a tracker in one click, plus the per-user API token feature on the server it depends on.

**Architecture:** Server-side per-user API tokens (new `user_api_tokens` table + extended `apiKeyMiddleware`), surfaced via a "Connected Apps" section on the existing Settings page. Chrome MV3 extension at `extension/` with a popup confirmation form, right-click context menu, and a background service worker that owns all `fetch()` calls. No content scripts. Sideload-only for v1.

**Tech Stack:** Node.js + Express + better-sqlite3 (server, existing); React + Vite + Tailwind (client, existing); Vite + `@crxjs/vite-plugin` + TypeScript (extension, new); vitest across all three.

**Spec:** [`docs/superpowers/specs/2026-05-06-browser-extension-design.md`](../specs/2026-05-06-browser-extension-design.md)

---

## File Structure

### Server (modified or created)

- Modify `server/src/db/migrations.ts` — append migration v12 (`user_api_tokens` table)
- Create `server/src/db/migration-v12.test.ts` — migration idempotency + schema check
- Modify `server/src/db/queries.ts` — append token CRUD helpers
- Create `server/src/db/api-tokens.test.ts` — token query unit tests
- Create `server/src/routes/api-tokens.ts` — REST routes for tokens
- Create `server/src/routes/api-tokens.test.ts` — route tests (auth + ownership)
- Modify `server/src/auth/apiKey.ts` — extend middleware to also accept user-issued tokens
- Create or modify `server/src/auth/apiKey.test.ts` — middleware tests
- Modify `server/src/index.ts` — mount new routes under `/api/settings/api-tokens`

### Client (modified or created)

- Modify `client/src/api.ts` — add `listApiTokens`, `createApiToken`, `revokeApiToken`
- Create `client/src/components/ConnectedAppsCard.tsx` — Settings card UI
- Create `client/src/components/ConnectedAppsCard.test.tsx` — component tests
- Modify `client/src/pages/Settings.tsx` — render the new card

### Extension (new workspace)

- Create `extension/package.json`, `extension/tsconfig.json`, `extension/vite.config.ts`
- Create `extension/manifest.json`
- Modify root `.gitignore` — add `extension/dist/` and `extension/node_modules/`
- Create `extension/src/background/service-worker.ts`
- Create `extension/src/popup/popup.{html,ts,css}`
- Create `extension/src/options/options.{html,ts,css}`
- Create `extension/src/lib/api.ts`, `lib/normalize-url.ts`, `lib/domains.ts`, `lib/messages.ts`
- Create `extension/src/types/api.ts`
- Create `extension/src/lib/normalize-url.test.ts`, `lib/messages.test.ts`
- Create `extension/icons/icon-{16,32,48,128}.png`
- Create `extension/RELEASE.md`

---

## Milestone 1 — Server-side per-user API tokens

### Task 1: Migration v12 — `user_api_tokens` table

**Files:**
- Modify: `server/src/db/migrations.ts` (append a new entry to the `migrations` array)
- Create: `server/src/db/migration-v12.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/db/migration-v12.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
});

describe('migration v12 — user_api_tokens', () => {
  it('creates the table with expected columns', () => {
    initializeSchema();
    const cols = getDb().prepare(`PRAGMA table_info(user_api_tokens)`).all() as Array<{ name: string }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      'created_at', 'id', 'last_used_at', 'name', 'prefix',
      'revoked_at', 'token_hash', 'user_id',
    ]);
  });

  it('enforces token_hash uniqueness', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO user_api_tokens (user_id, name, token_hash, prefix, created_at)
                VALUES (1, 'one', 'deadbeef', 'pt_aaaa', ?)`).run(Date.now());
    expect(() => db.prepare(`INSERT INTO user_api_tokens (user_id, name, token_hash, prefix, created_at)
                             VALUES (1, 'two', 'deadbeef', 'pt_bbbb', ?)`).run(Date.now())
    ).toThrow(/UNIQUE/);
  });

  it('cascades delete when the user is removed', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO user_api_tokens (user_id, name, token_hash, prefix, created_at)
                VALUES (1, 'one', 'h1', 'pt_aaaa', ?)`).run(Date.now());
    db.pragma('foreign_keys = ON');
    db.prepare('DELETE FROM users WHERE id = 1').run();
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM user_api_tokens').get() as { n: number };
    expect(remaining.n).toBe(0);
  });

  it('migration is idempotent (running schema init twice does not throw)', () => {
    initializeSchema();
    expect(() => initializeSchema()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd server && npx vitest run src/db/migration-v12.test.ts
```
Expected: FAIL — `no such table: user_api_tokens`.

- [ ] **Step 3: Add migration v12 to `server/src/db/migrations.ts`**

Append to the `migrations` array, after the existing v11 entry:

```typescript
  {
    version: 12,
    description: 'Per-user API tokens for the browser extension',
    up: () => {
      const db = getDb();
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_api_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          prefix TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_user_api_tokens_user ON user_api_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_user_api_tokens_hash ON user_api_tokens(token_hash);
      `);
    },
  },
```

- [ ] **Step 4: Run test to verify it passes**

```
cd server && npx vitest run src/db/migration-v12.test.ts
```
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```
cd /root/price-tracker
git add server/src/db/migrations.ts server/src/db/migration-v12.test.ts
git commit -m "feat(extension): migration v12 — user_api_tokens table

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Token DB query helpers

**Files:**
- Modify: `server/src/db/queries.ts` (append helpers near the end of the file)
- Create: `server/src/db/api-tokens.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/db/api-tokens.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import {
  createUserApiToken, listUserApiTokensForUser,
  findActiveTokenByHash, revokeUserApiToken, touchTokenLastUsed,
} from './queries.js';

function seedUser(email = 'a@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function hashFor(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('createUserApiToken', () => {
  it('returns plaintext + persists SHA-256 hash + prefix', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'My Mac');
    expect(t.token).toMatch(/^pt_[A-Za-z0-9_-]{43}$/);
    expect(t.prefix).toBe(t.token.slice(0, 8));
    const row = getDb().prepare('SELECT token_hash FROM user_api_tokens WHERE id = ?').get(t.id) as { token_hash: string };
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(t.token);
  });

  it('two tokens for the same user have different plaintext', () => {
    const u = seedUser();
    const a = createUserApiToken(u, 'A');
    const b = createUserApiToken(u, 'B');
    expect(a.token).not.toBe(b.token);
  });
});

describe('findActiveTokenByHash', () => {
  it('returns row when hash matches and not revoked', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    expect(findActiveTokenByHash(hashFor(t.token))?.user_id).toBe(u);
  });

  it('returns null when revoked', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    revokeUserApiToken(t.id, u);
    expect(findActiveTokenByHash(hashFor(t.token))).toBeNull();
  });

  it('returns null when hash does not match', () => {
    expect(findActiveTokenByHash('a'.repeat(64))).toBeNull();
  });
});

describe('listUserApiTokensForUser', () => {
  it('returns only that user\'s tokens, never plaintext or hash', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    createUserApiToken(u1, 'mine');
    createUserApiToken(u2, 'theirs');
    const out = listUserApiTokensForUser(u1);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('mine');
    expect((out[0] as Record<string, unknown>).token_hash).toBeUndefined();
    expect((out[0] as Record<string, unknown>).token).toBeUndefined();
  });
});

describe('revokeUserApiToken', () => {
  it('marks revoked_at on a token belonging to the user', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    expect(revokeUserApiToken(t.id, u)).toBe(true);
    const row = getDb().prepare('SELECT revoked_at FROM user_api_tokens WHERE id = ?').get(t.id) as { revoked_at: number | null };
    expect(row.revoked_at).toBeGreaterThan(0);
  });

  it('returns false when token belongs to another user', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = createUserApiToken(u1, 'M');
    expect(revokeUserApiToken(t.id, u2)).toBe(false);
  });
});

describe('touchTokenLastUsed', () => {
  it('updates last_used_at to now', () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    touchTokenLastUsed(t.id);
    const row = getDb().prepare('SELECT last_used_at FROM user_api_tokens WHERE id = ?').get(t.id) as { last_used_at: number };
    expect(row.last_used_at).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd server && npx vitest run src/db/api-tokens.test.ts
```
Expected: FAIL — import error (`createUserApiToken` not exported).

- [ ] **Step 3: Implement the helpers in `server/src/db/queries.ts`**

Add near the existing crypto imports at the top of the file:

```typescript
import { randomBytes, createHash } from 'crypto';
```

Then append the helpers (anywhere near the bottom of the file, before the trailing project/basket exports is fine):

```typescript
// --- User API tokens (browser extension) ---

export interface UserApiTokenRow {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CreatedUserApiToken {
  id: number;
  name: string;
  token: string;     // plaintext — returned ONLY here, never stored
  prefix: string;
  created_at: number;
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function createUserApiToken(userId: number, name: string): CreatedUserApiToken {
  const plaintext = 'pt_' + randomBytes(32).toString('base64url');
  const token_hash = hashToken(plaintext);
  const prefix = plaintext.slice(0, 8);
  const created_at = Date.now();
  const id = Number(getDb().prepare(
    `INSERT INTO user_api_tokens (user_id, name, token_hash, prefix, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, name, token_hash, prefix, created_at).lastInsertRowid);
  return { id, name, token: plaintext, prefix, created_at };
}

export function listUserApiTokensForUser(userId: number): UserApiTokenRow[] {
  return getDb().prepare(
    `SELECT id, user_id, name, prefix, created_at, last_used_at, revoked_at
     FROM user_api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  ).all(userId) as UserApiTokenRow[];
}

interface ActiveTokenLookup {
  id: number;
  user_id: number;
}

export function findActiveTokenByHash(token_hash: string): ActiveTokenLookup | null {
  const row = getDb().prepare(
    `SELECT id, user_id FROM user_api_tokens
     WHERE token_hash = ? AND revoked_at IS NULL`,
  ).get(token_hash) as ActiveTokenLookup | undefined;
  return row ?? null;
}

export function revokeUserApiToken(tokenId: number, userId: number): boolean {
  const result = getDb().prepare(
    `UPDATE user_api_tokens SET revoked_at = ?
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
  ).run(Date.now(), tokenId, userId);
  return result.changes > 0;
}

export function touchTokenLastUsed(tokenId: number): void {
  getDb().prepare(`UPDATE user_api_tokens SET last_used_at = ? WHERE id = ?`)
    .run(Date.now(), tokenId);
}
```

- [ ] **Step 4: Run test to verify it passes**

```
cd server && npx vitest run src/db/api-tokens.test.ts
```
Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit**

```
git add server/src/db/queries.ts server/src/db/api-tokens.test.ts
git commit -m "feat(extension): user API token DB helpers (create/list/find/revoke/touch)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Token REST routes

**Files:**
- Create: `server/src/routes/api-tokens.ts`
- Create: `server/src/routes/api-tokens.test.ts`
- Modify: `server/src/index.ts` — mount at `/api/settings/api-tokens`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/routes/api-tokens.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { authMiddleware } from '../auth/middleware.js';
import { createUserApiToken } from '../db/queries.js';
import apiTokenRoutes from './api-tokens.js';
import { signAccessToken } from '../auth/jwt.js';

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/settings/api-tokens', authMiddleware, apiTokenRoutes);
  return app;
}

function seedUser(email: string): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function authCookie(userId: number, role: 'user' | 'admin' = 'user'): string {
  const token = signAccessToken({ userId, email: 'x@x.com', role });
  return `access_token=${token}`;
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('POST /api/settings/api-tokens', () => {
  it('creates a token and returns plaintext exactly once', async () => {
    const u = seedUser('a@x.com');
    const res = await request(makeApp())
      .post('/api/settings/api-tokens')
      .set('Cookie', authCookie(u))
      .send({ name: 'My Mac' });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('My Mac');
    expect(res.body.token).toMatch(/^pt_[A-Za-z0-9_-]{43}$/);
    expect(res.body.prefix).toBe(res.body.token.slice(0, 8));
  });

  it('rejects empty name with 400', async () => {
    const u = seedUser('a@x.com');
    const res = await request(makeApp())
      .post('/api/settings/api-tokens')
      .set('Cookie', authCookie(u))
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(makeApp())
      .post('/api/settings/api-tokens')
      .send({ name: 'x' });
    expect(res.status).toBe(401);
  });
});

describe('GET /api/settings/api-tokens', () => {
  it('returns this user\'s tokens (no plaintext, no hash)', async () => {
    const u = seedUser('a@x.com');
    createUserApiToken(u, 'one');
    createUserApiToken(u, 'two');
    const res = await request(makeApp())
      .get('/api/settings/api-tokens')
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].token).toBeUndefined();
    expect(res.body[0].token_hash).toBeUndefined();
    expect(res.body[0].prefix).toMatch(/^pt_/);
  });

  it('does not leak other users\' tokens', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    createUserApiToken(u1, 'mine');
    createUserApiToken(u2, 'theirs');
    const res = await request(makeApp())
      .get('/api/settings/api-tokens')
      .set('Cookie', authCookie(u1));
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('mine');
  });
});

describe('DELETE /api/settings/api-tokens/:id', () => {
  it('revokes the user\'s own token', async () => {
    const u = seedUser('a@x.com');
    const t = createUserApiToken(u, 'M');
    const res = await request(makeApp())
      .delete(`/api/settings/api-tokens/${t.id}`)
      .set('Cookie', authCookie(u));
    expect(res.status).toBe(204);
  });

  it('returns 404 when revoking another user\'s token (no existence leak)', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = createUserApiToken(u1, 'M');
    const res = await request(makeApp())
      .delete(`/api/settings/api-tokens/${t.id}`)
      .set('Cookie', authCookie(u2));
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd server && npx vitest run src/routes/api-tokens.test.ts
```
Expected: FAIL — `Cannot find module ./api-tokens.js`.

- [ ] **Step 3: Create the route file**

```typescript
// server/src/routes/api-tokens.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createUserApiToken, listUserApiTokensForUser, revokeUserApiToken,
} from '../db/queries.js';
import { logger } from '../logger.js';

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(100),
});

router.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const created = createUserApiToken(req.user!.userId, parsed.data.name);
  logger.info({
    user_id: req.user!.userId, token_id: created.id, name: created.name,
  }, 'api_token_created');
  res.status(201).json(created);
});

router.get('/', (req: Request, res: Response) => {
  res.json(listUserApiTokensForUser(req.user!.userId));
});

router.delete('/:id', (req: Request, res: Response) => {
  const tokenId = Number(req.params.id);
  if (!Number.isFinite(tokenId)) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  const ok = revokeUserApiToken(tokenId, req.user!.userId);
  if (!ok) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  logger.info({ user_id: req.user!.userId, token_id: tokenId }, 'api_token_revoked');
  res.status(204).send();
});

export default router;
```

- [ ] **Step 4: Mount in `server/src/index.ts`**

Add the import near the other route imports at the top of the file:

```typescript
import apiTokenRoutes from './routes/api-tokens.js';
```

Add the mount line near the existing `app.use('/api/settings', ...)` block. Important: declare the more-specific path FIRST so Express matches it before the generic settings router:

```typescript
app.use('/api/settings/api-tokens', apiKeyMiddleware, authMiddleware, apiTokenRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

```
cd server && npx vitest run src/routes/api-tokens.test.ts
```
Expected: PASS, all 7 tests.

- [ ] **Step 6: Commit**

```
git add server/src/routes/api-tokens.ts server/src/routes/api-tokens.test.ts server/src/index.ts
git commit -m "feat(extension): /api/settings/api-tokens REST routes (POST/GET/DELETE)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Extend `apiKeyMiddleware` to accept user-issued tokens

**Files:**
- Modify: `server/src/auth/apiKey.ts`
- Create or modify: `server/src/auth/apiKey.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// server/src/auth/apiKey.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { apiKeyMiddleware } from './apiKey.js';
import { createUserApiToken } from '../db/queries.js';

function seedUser(email = 'a@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'A', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function makeApp(): express.Express {
  const app = express();
  app.use(apiKeyMiddleware, (req, res) => {
    res.json({ userId: req.user?.userId ?? null });
  });
  return app;
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
  delete process.env.PRICE_TRACKER_API_KEY;
  delete process.env.PRICE_TRACKER_API_KEY_USER_ID;
});

describe('apiKeyMiddleware — user tokens', () => {
  it('valid user token → req.user set', async () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    const res = await request(makeApp()).get('/').set('X-API-Key', t.token);
    expect(res.body.userId).toBe(u);
  });

  it('updates last_used_at on success', async () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    await request(makeApp()).get('/').set('X-API-Key', t.token);
    const row = getDb().prepare('SELECT last_used_at FROM user_api_tokens WHERE id = ?').get(t.id) as { last_used_at: number | null };
    expect(row.last_used_at).not.toBeNull();
    expect(row.last_used_at!).toBeGreaterThan(Date.now() - 5000);
  });

  it('revoked token → 401', async () => {
    const u = seedUser();
    const t = createUserApiToken(u, 'M');
    getDb().prepare('UPDATE user_api_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), t.id);
    const res = await request(makeApp()).get('/').set('X-API-Key', t.token);
    expect(res.status).toBe(401);
  });

  it('unknown token → 401', async () => {
    const res = await request(makeApp()).get('/').set('X-API-Key', 'pt_unknown' + 'x'.repeat(40));
    expect(res.status).toBe(401);
  });

  it('missing header → next() (delegates to JWT layer)', async () => {
    const res = await request(makeApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.body.userId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd server && npx vitest run src/auth/apiKey.test.ts
```
Expected: FAIL — user-token cases return 401 because the middleware doesn't yet recognize hashed user tokens.

- [ ] **Step 3: Modify `server/src/auth/apiKey.ts`**

Replace the function body so the global-key check stays as the first match (existing OpenClaw flow), and add a second branch that hash-looks-up `user_api_tokens` when the header doesn't match the global key:

```typescript
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'crypto';
import { config, isApiKeyConfigured } from '../config.js';
import { getUserById } from '../db/user-queries.js';
import { findActiveTokenByHash, touchTokenLastUsed } from '../db/queries.js';
import { logger } from '../logger.js';

export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.header('x-api-key');

  if (!headerValue) {
    next();
    return;
  }

  // Branch 1 — global PRICE_TRACKER_API_KEY (OpenClaw-style shared key).
  if (isApiKeyConfigured()) {
    const expected = Buffer.from(config.priceTrackerApiKey);
    const got = Buffer.from(headerValue);
    if (got.length === expected.length && timingSafeEqual(got, expected)) {
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
      return;
    }
  }

  // Branch 2 — per-user token. Hash the incoming header and look up.
  const hash = createHash('sha256').update(headerValue).digest('hex');
  const token = findActiveTokenByHash(hash);
  if (token) {
    const user = getUserById(token.user_id);
    if (!user) {
      logger.warn({ tokenId: token.id, userId: token.user_id }, 'User token matched but user missing');
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    touchTokenLastUsed(token.id);
    req.user = { userId: user.id, email: user.email, role: user.role };
    logger.info(
      { source: 'user-token', path: req.path, method: req.method, userId: user.id, tokenId: token.id },
      'API key auth succeeded',
    );
    next();
    return;
  }

  logger.info({ prefix: headerValue.slice(0, 8) }, 'api_token_auth_failed');
  res.status(401).json({ error: 'Invalid API key' });
}
```

- [ ] **Step 4: Run tests to verify they pass**

```
cd server && npx vitest run src/auth/apiKey.test.ts
```
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full server suite to check nothing regressed**

```
cd server && npm test -- --run
```
Expected: PASS, all tests (488 prior + ~20 new).

- [ ] **Step 6: Commit**

```
git add server/src/auth/apiKey.ts server/src/auth/apiKey.test.ts
git commit -m "feat(extension): apiKeyMiddleware accepts per-user tokens alongside global key

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: "Connected Apps" Settings UI

**Files:**
- Modify: `client/src/api.ts` — add three API wrappers
- Create: `client/src/components/ConnectedAppsCard.tsx`
- Create: `client/src/components/ConnectedAppsCard.test.tsx`
- Modify: `client/src/pages/Settings.tsx` — render the new card

- [ ] **Step 1: Write the failing test**

```typescript
// client/src/components/ConnectedAppsCard.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectedAppsCard } from './ConnectedAppsCard';
import * as api from '../api';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('ConnectedAppsCard', () => {
  it('renders existing tokens with name + prefix + created date', async () => {
    vi.spyOn(api, 'listApiTokens').mockResolvedValue([
      { id: 1, name: 'My Mac', prefix: 'pt_a3b9c', created_at: 1700000000000, last_used_at: null, revoked_at: null },
    ]);
    render(<ConnectedAppsCard />);
    expect(await screen.findByText('My Mac')).toBeInTheDocument();
    expect(screen.getByText(/pt_a3b9c/)).toBeInTheDocument();
  });

  it('clicking Generate opens the dialog', async () => {
    vi.spyOn(api, 'listApiTokens').mockResolvedValue([]);
    render(<ConnectedAppsCard />);
    await waitFor(() => expect(screen.getByText(/Generate new token/i)).toBeInTheDocument());
    fireEvent.click(screen.getByText(/Generate new token/i));
    expect(screen.getByPlaceholderText(/e\.g\./i)).toBeInTheDocument();
  });

  it('Generate flow reveals plaintext token once', async () => {
    vi.spyOn(api, 'listApiTokens').mockResolvedValue([]);
    vi.spyOn(api, 'createApiToken').mockResolvedValue({
      id: 1, name: 'My Mac', token: 'pt_aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkk',
      prefix: 'pt_aaaab', created_at: Date.now(),
    });
    render(<ConnectedAppsCard />);
    await waitFor(() => screen.getByText(/Generate new token/i));
    fireEvent.click(screen.getByText(/Generate new token/i));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\./i), { target: { value: 'My Mac' } });
    fireEvent.click(screen.getByRole('button', { name: /Generate$/i }));
    expect(await screen.findByText(/pt_aaaabbbbccccddddeeeeffffgggghhhhiiiijjjjkkk/)).toBeInTheDocument();
  });

  it('Revoke calls the API and removes the row', async () => {
    vi.spyOn(api, 'listApiTokens')
      .mockResolvedValueOnce([{ id: 7, name: 'Old', prefix: 'pt_aaaaa', created_at: 0, last_used_at: null, revoked_at: null }])
      .mockResolvedValueOnce([]);
    const revokeSpy = vi.spyOn(api, 'revokeApiToken').mockResolvedValue();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ConnectedAppsCard />);
    fireEvent.click(await screen.findByRole('button', { name: /Revoke/i }));
    await waitFor(() => expect(revokeSpy).toHaveBeenCalledWith(7));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd client && npx vitest run src/components/ConnectedAppsCard.test.tsx
```
Expected: FAIL — `Cannot find module ./ConnectedAppsCard`.

- [ ] **Step 3: Add API wrappers in `client/src/api.ts`**

Append:

```typescript
export interface ApiTokenSummary {
  id: number;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CreatedApiToken extends ApiTokenSummary {
  token: string; // plaintext, only here
}

export async function listApiTokens(): Promise<ApiTokenSummary[]> {
  const r = await fetch('/api/settings/api-tokens', { credentials: 'include' });
  if (!r.ok) throw new Error(`listApiTokens failed: ${r.status}`);
  return r.json();
}

export async function createApiToken(name: string): Promise<CreatedApiToken> {
  const r = await fetch('/api/settings/api-tokens', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`createApiToken failed: ${r.status}`);
  return r.json();
}

export async function revokeApiToken(id: number): Promise<void> {
  const r = await fetch(`/api/settings/api-tokens/${id}`, {
    method: 'DELETE', credentials: 'include',
  });
  if (!r.ok) throw new Error(`revokeApiToken failed: ${r.status}`);
}
```

- [ ] **Step 4: Implement the component**

```tsx
// client/src/components/ConnectedAppsCard.tsx
import { useEffect, useState } from 'react';
import { Plug, Copy, X } from 'lucide-react';
import { listApiTokens, createApiToken, revokeApiToken, type ApiTokenSummary, type CreatedApiToken } from '../api';

export function ConnectedAppsCard() {
  const [tokens, setTokens] = useState<ApiTokenSummary[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try { setTokens(await listApiTokens()); }
    catch (e) { setError(String(e)); }
  }

  useEffect(() => { refresh(); }, []);

  async function handleGenerate() {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const t = await createApiToken(name.trim());
      setCreated(t);
      setName('');
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id: number) {
    if (!confirm('Revoke this token? Anything using it will stop working.')) return;
    try {
      await revokeApiToken(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function closeDialog() {
    setShowDialog(false);
    setCreated(null);
    setName('');
  }

  function fmtDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10);
  }

  function fmtLastUsed(ms: number | null): string {
    if (!ms) return 'never';
    const days = Math.floor((Date.now() - ms) / 86_400_000);
    if (days === 0) return 'today';
    if (days === 1) return '1d ago';
    return `${days}d ago`;
  }

  return (
    <section className="bg-surface border border-border rounded-lg p-4">
      <header className="flex items-center justify-between mb-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Plug className="w-5 h-5" /> Connected Apps
        </h2>
        <button
          onClick={() => setShowDialog(true)}
          className="text-sm bg-primary hover:bg-primary-dark text-white px-3 py-1.5 rounded"
        >
          Generate new token
        </button>
      </header>

      {error && <div className="text-danger text-sm mb-2">{error}</div>}

      {tokens.length === 0 ? (
        <p className="text-text-muted text-sm">
          No tokens yet. Generate one to connect the browser extension or other API clients.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {tokens.map(t => (
            <li key={t.id} className="py-2 flex items-center gap-3 flex-wrap">
              <span className="font-medium">{t.name}</span>
              <code className="text-text-muted text-xs">{t.prefix}…</code>
              <span className="text-text-muted text-xs">created {fmtDate(t.created_at)}</span>
              <span className="text-text-muted text-xs">last used {fmtLastUsed(t.last_used_at)}</span>
              {t.revoked_at && <span className="text-danger text-xs">revoked</span>}
              <span className="flex-1" />
              {!t.revoked_at && (
                <button
                  onClick={() => handleRevoke(t.id)}
                  className="text-text-muted hover:text-danger text-sm"
                >
                  Revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {showDialog && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-surface border border-border rounded-lg p-6 max-w-md w-full">
            <header className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-semibold">{created ? 'Token created' : 'Generate token'}</h3>
              <button onClick={closeDialog} className="text-text-muted hover:text-text"><X className="w-4 h-4" /></button>
            </header>

            {!created ? (
              <>
                <label className="block text-xs uppercase text-text-muted mb-1">Name</label>
                <input
                  autoFocus
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="e.g. Browser Extension"
                  className="w-full bg-bg border border-border rounded px-2 py-1.5 mb-3"
                />
                <div className="flex justify-end gap-2">
                  <button onClick={closeDialog} className="text-sm px-3 py-1.5">Cancel</button>
                  <button
                    onClick={handleGenerate}
                    disabled={busy || !name.trim()}
                    className="text-sm bg-primary text-white px-3 py-1.5 rounded disabled:opacity-50"
                  >
                    Generate
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-warning mb-2">
                  Copy this now — you won't see it again.
                </p>
                <code className="block bg-bg border border-border rounded p-2 text-xs break-all mb-3">
                  {created.token}
                </code>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => navigator.clipboard.writeText(created.token)}
                    className="text-sm bg-primary text-white px-3 py-1.5 rounded flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" /> Copy
                  </button>
                  <button onClick={closeDialog} className="text-sm px-3 py-1.5">Done</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
```

- [ ] **Step 5: Render in `client/src/pages/Settings.tsx`**

Add the import near the top:

```typescript
import { ConnectedAppsCard } from '../components/ConnectedAppsCard';
```

Then render `<ConnectedAppsCard />` in the JSX, after the existing `<WebPushSettings />` block.

- [ ] **Step 6: Run tests + typecheck**

```
cd client && npx vitest run src/components/ConnectedAppsCard.test.tsx
cd client && npx tsc --noEmit
```
Expected: PASS, all 4 component tests; TS clean.

- [ ] **Step 7: Commit**

```
git add client/src/api.ts client/src/components/ConnectedAppsCard.tsx \
        client/src/components/ConnectedAppsCard.test.tsx client/src/pages/Settings.tsx
git commit -m "feat(extension): Connected Apps Settings card (generate / list / revoke tokens)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 2 — Extension scaffolding

### Task 6: Initialize `extension/` workspace

**Files:**
- Create: `extension/package.json`, `tsconfig.json`, `vite.config.ts`, `manifest.json`
- Modify: root `.gitignore`
- Create: `extension/src/types/api.ts`

- [ ] **Step 1: Create `extension/package.json`**

```json
{
  "name": "price-tracker-extension",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@crxjs/vite-plugin": "^2.0.0-beta.25",
    "@types/chrome": "^0.0.260",
    "@types/node": "^20.10.0",
    "typescript": "^5.4.0",
    "vite": "^5.2.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: Create `extension/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["chrome", "vite/client"],
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitOverride": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "noEmit": true
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

- [ ] **Step 3: Create `extension/vite.config.ts`**

```typescript
import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
```

- [ ] **Step 4: Create `extension/manifest.json`**

```json
{
  "manifest_version": 3,
  "name": "Price Tracker",
  "version": "0.1.0",
  "description": "One-click add to your Price Tracker.",
  "icons": {
    "16": "icons/icon-16.png",
    "32": "icons/icon-32.png",
    "48": "icons/icon-48.png",
    "128": "icons/icon-128.png"
  },
  "permissions": ["activeTab", "contextMenus", "storage"],
  "host_permissions": ["https://prices.schultzsolutions.tech/*"],
  "background": {
    "service_worker": "src/background/service-worker.ts",
    "type": "module"
  },
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_title": "Price Tracker",
    "default_icon": {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png"
    }
  },
  "options_ui": {
    "page": "src/options/options.html",
    "open_in_tab": true
  }
}
```

- [ ] **Step 5: Create `extension/src/types/api.ts`**

```typescript
// Manual mirror of server/src/db/queries.ts Tracker type. Keep in sync
// with the server's createSchema (POST /api/trackers body).
export interface TrackerCreatePayload {
  name: string;
  url: string;
  threshold_price?: number | null;
  check_interval_minutes?: number;
  css_selector?: string | null;
}

export interface Tracker {
  id: number;
  name: string;
  url: string;
  normalized_url: string | null;
  threshold_price: number | null;
  check_interval_minutes: number;
  last_price: number | null;
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
}
```

- [ ] **Step 6: Add ignores to root `.gitignore`**

Append:

```
extension/dist/
extension/node_modules/
```

- [ ] **Step 7: Install dependencies**

```
cd extension && npm install
```
Expected: clean install.

- [ ] **Step 8: Run typecheck**

```
cd extension && npm run typecheck
```
Expected: PASS.

- [ ] **Step 9: Commit**

```
git add extension/package.json extension/tsconfig.json extension/vite.config.ts \
        extension/manifest.json extension/src/types/api.ts extension/package-lock.json .gitignore
git commit -m "feat(extension): scaffold workspace (package.json, vite, manifest, types)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Background service worker stub

**Files:**
- Create: `extension/src/background/service-worker.ts`

- [ ] **Step 1: Implement the stub**

```typescript
// extension/src/background/service-worker.ts
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'add-to-price-tracker',
    title: 'Add to Price Tracker',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['<all_urls>'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'add-to-price-tracker' || !tab?.id) return;
  void chrome.action.openPopup();
});

chrome.runtime.onMessage.addListener((_msg, _sender, sendResponse) => {
  sendResponse({ ok: false, error: 'NOT_IMPLEMENTED' });
  return true;
});
```

- [ ] **Step 2: Build to confirm it compiles**

```
cd extension && npm run build
```
Expected: success, `extension/dist/` populated. The crxjs plugin will warn that popup.html and options.html are missing — that's the next two tasks.

- [ ] **Step 3: Commit**

```
git add extension/src/background/service-worker.ts
git commit -m "feat(extension): background service worker stub (context menu + msg listener)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: Hello-popup that shows current tab

**Files:**
- Create: `extension/src/popup/popup.html`, `popup.ts`, `popup.css`
- Create: placeholder `extension/icons/icon-{16,32,48,128}.png`

- [ ] **Step 1: Create `extension/src/popup/popup.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="popup.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Create `extension/src/popup/popup.css`**

```css
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  width: 360px;
  background: #0f172a;
  color: #f1f5f9;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  font-size: 13px;
}
.header {
  padding: 10px 14px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.body { padding: 14px; }
.muted { color: #94a3b8; font-size: 11px; }
```

- [ ] **Step 3: Create `extension/src/popup/popup.ts`**

```typescript
async function main() {
  const root = document.getElementById('root')!;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  root.innerHTML = `
    <div class="header"><strong>Price Tracker</strong></div>
    <div class="body">
      <div>${tab?.title ? escapeHtml(tab.title) : '(no title)'}</div>
      <div class="muted">${tab?.url ? escapeHtml(tab.url) : ''}</div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

main().catch(err => console.error('popup failed', err));
```

- [ ] **Step 4: Create placeholder PNG icons**

Real branded icons land in Task 16. For now, place any 4 PNGs at `extension/icons/icon-{16,32,48,128}.png` (matching pixel sizes). Quickest source: use `client/public/icons/icon-512.png` (the PWA's existing icon) as the upstream and let an external image tool produce the four downsamples. If that file exists and ImageMagick is available locally:

```
cd /root/price-tracker
mkdir -p extension/icons
convert client/public/icons/icon-512.png -resize 16x16   extension/icons/icon-16.png
convert client/public/icons/icon-512.png -resize 32x32   extension/icons/icon-32.png
convert client/public/icons/icon-512.png -resize 48x48   extension/icons/icon-48.png
convert client/public/icons/icon-512.png -resize 128x128 extension/icons/icon-128.png
```

If ImageMagick isn't available, drop ANY four PNGs at the matching sizes (the manifest only requires the files exist and decode). Final branded icons are a hard requirement and ship in Task 16.

- [ ] **Step 5: Build**

```
cd extension && npm run build
```
Expected: clean build with `dist/` populated.

- [ ] **Step 6: Manual smoke (skip if Chrome unavailable on this host)**

In Chrome: `chrome://extensions` → enable Developer mode → Load unpacked → select `extension/dist/`. Click the toolbar icon. Expected: popup shows the active tab's title + URL.

- [ ] **Step 7: Commit**

```
git add extension/src/popup/ extension/icons/
git commit -m "feat(extension): hello-popup that displays the active tab

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 3 — Options page + token storage

### Task 9: API fetch wrapper + message contracts

**Files:**
- Create: `extension/src/lib/messages.ts`
- Create: `extension/src/lib/api.ts`
- Create: `extension/src/lib/messages.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/lib/messages.test.ts
import { describe, it, expect } from 'vitest';
import { isCheckDup, isCreate, isTestConnection } from './messages.js';

describe('message type guards', () => {
  it('isCheckDup', () => {
    expect(isCheckDup({ type: 'CHECK_DUP', url: 'https://x' })).toBe(true);
    expect(isCheckDup({ type: 'CREATE' })).toBe(false);
    expect(isCheckDup(null)).toBe(false);
  });

  it('isCreate', () => {
    expect(isCreate({ type: 'CREATE', payload: { name: 'x', url: 'https://x' } })).toBe(true);
    expect(isCreate({ type: 'CHECK_DUP' })).toBe(false);
  });

  it('isTestConnection', () => {
    expect(isTestConnection({ type: 'TEST_CONNECTION' })).toBe(true);
    expect(isTestConnection({ type: 'OTHER' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd extension && npm test
```
Expected: FAIL — `Cannot find module ./messages.js`.

- [ ] **Step 3: Create `extension/src/lib/messages.ts`**

```typescript
import type { TrackerCreatePayload, Tracker } from '../types/api.js';

export interface CheckDupMessage {
  type: 'CHECK_DUP';
  url: string;
}

export interface CreateMessage {
  type: 'CREATE';
  payload: TrackerCreatePayload;
}

export interface TestConnectionMessage {
  type: 'TEST_CONNECTION';
}

export type ExtensionMessage = CheckDupMessage | CreateMessage | TestConnectionMessage;

export interface CheckDupResponse {
  ok: true;
  exists: boolean;
  tracker?: Tracker;
}

export interface CreateResponse {
  ok: true;
  tracker: Tracker;
}

export interface TestConnectionResponse {
  ok: true;
}

export type ErrorCode =
  | 'NO_TOKEN' | 'UNAUTHORIZED' | 'NETWORK' | 'SERVER'
  | 'VALIDATION' | 'CONFLICT' | 'NOT_IMPLEMENTED' | 'UNKNOWN';

export interface ErrorResponse {
  ok: false;
  error: ErrorCode;
  detail?: string;
}

export type ExtensionResponse =
  | CheckDupResponse | CreateResponse | TestConnectionResponse | ErrorResponse;

export function isCheckDup(msg: unknown): msg is CheckDupMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'CHECK_DUP';
}

export function isCreate(msg: unknown): msg is CreateMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'CREATE';
}

export function isTestConnection(msg: unknown): msg is TestConnectionMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'TEST_CONNECTION';
}
```

- [ ] **Step 4: Create `extension/src/lib/api.ts`**

```typescript
import type { Tracker, TrackerCreatePayload } from '../types/api.js';
import type { ErrorCode } from './messages.js';

const API_ORIGIN = 'https://prices.schultzsolutions.tech';

export async function getStoredToken(): Promise<string | null> {
  const data = await chrome.storage.local.get(['apiToken']);
  return (data.apiToken as string | undefined) ?? null;
}

export async function setStoredToken(token: string): Promise<void> {
  await chrome.storage.local.set({ apiToken: token });
}

export async function clearStoredToken(): Promise<void> {
  await chrome.storage.local.remove('apiToken');
}

class ApiError extends Error {
  code: ErrorCode;
  detail?: string;
  constructor(code: ErrorCode, detail?: string) {
    super(`api ${code}`);
    this.code = code;
    this.detail = detail;
  }
}

async function request<T>(path: string, init: RequestInit & { method: string }): Promise<T> {
  const token = await getStoredToken();
  if (!token) throw new ApiError('NO_TOKEN');

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'Content-Type': 'application/json',
        'X-API-Key': token,
      },
    });
  } catch (err) {
    throw new ApiError('NETWORK', String(err));
  }
  if (response.status === 401) throw new ApiError('UNAUTHORIZED');
  if (response.status === 400) throw new ApiError('VALIDATION', await safeBody(response));
  if (response.status === 409) throw new ApiError('CONFLICT');
  if (response.status >= 500) throw new ApiError('SERVER', String(response.status));
  if (!response.ok) throw new ApiError('UNKNOWN', String(response.status));
  return response.json() as Promise<T>;
}

async function safeBody(r: Response): Promise<string> {
  try { return JSON.stringify(await r.json()); } catch { return ''; }
}

export async function listTrackers(): Promise<Tracker[]> {
  return request<Tracker[]>('/api/trackers', { method: 'GET' });
}

export async function createTracker(payload: TrackerCreatePayload): Promise<Tracker> {
  return request<Tracker>('/api/trackers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function testConnection(): Promise<void> {
  await listTrackers();
}
```

- [ ] **Step 5: Run tests to verify they pass**

```
cd extension && npm test
```
Expected: PASS, 3 message-guard tests.

- [ ] **Step 6: Commit**

```
git add extension/src/lib/messages.ts extension/src/lib/api.ts extension/src/lib/messages.test.ts
git commit -m "feat(extension): typed message contracts + API fetch wrapper

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: Options page (paste token + Test connection)

**Files:**
- Create: `extension/src/options/options.html`, `options.ts`, `options.css`
- Modify: `extension/src/background/service-worker.ts` — handle TEST_CONNECTION

- [ ] **Step 1: Create `extension/src/options/options.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Price Tracker — Options</title>
  <link rel="stylesheet" href="options.css">
</head>
<body>
  <main>
    <h1>Price Tracker</h1>
    <p class="muted">
      Paste an API token from
      <a href="https://prices.schultzsolutions.tech/settings" target="_blank">Settings → Connected Apps</a>.
    </p>

    <label>API token</label>
    <input id="token" type="password" placeholder="pt_…" autocomplete="off">

    <div class="row">
      <button id="save">Save</button>
      <button id="test">Test connection</button>
      <button id="clear" class="ghost">Clear</button>
    </div>

    <div id="status" class="status"></div>
  </main>
  <script type="module" src="options.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Create `extension/src/options/options.css`**

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #0f172a;
  color: #f1f5f9;
  font-family: ui-sans-serif, system-ui, sans-serif;
}
main {
  max-width: 540px;
  margin: 40px auto;
  padding: 24px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
}
h1 { margin: 0 0 8px 0; }
.muted { color: #94a3b8; font-size: 13px; margin: 0 0 16px 0; }
.muted a { color: #a5b4fc; }
label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  color: #94a3b8;
  margin-bottom: 4px;
}
input {
  width: 100%;
  background: #0f172a;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 8px 10px;
  color: #f1f5f9;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  margin-bottom: 12px;
}
.row { display: flex; gap: 8px; margin-top: 8px; }
button {
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 4px;
  padding: 8px 14px;
  font-size: 13px;
  cursor: pointer;
}
button:hover { background: #4f46e5; }
button.ghost {
  background: transparent;
  border: 1px solid #334155;
  color: #f1f5f9;
}
.status { margin-top: 14px; font-size: 13px; min-height: 20px; }
.status.ok { color: #10b981; }
.status.err { color: #ef4444; }
```

- [ ] **Step 3: Create `extension/src/options/options.ts`**

```typescript
import { getStoredToken, setStoredToken, clearStoredToken } from '../lib/api.js';
import type { ExtensionResponse } from '../lib/messages.js';

const tokenInput = document.getElementById('token') as HTMLInputElement;
const status = document.getElementById('status')!;

(async () => {
  const existing = await getStoredToken();
  if (existing) {
    tokenInput.value = existing;
    setStatus(`Token loaded (${existing.slice(0, 8)}…).`, 'ok');
  }
})();

document.getElementById('save')!.addEventListener('click', async () => {
  const v = tokenInput.value.trim();
  if (!v) { setStatus('Enter a token first.', 'err'); return; }
  await setStoredToken(v);
  setStatus('Saved.', 'ok');
});

document.getElementById('clear')!.addEventListener('click', async () => {
  await clearStoredToken();
  tokenInput.value = '';
  setStatus('Cleared.', 'ok');
});

document.getElementById('test')!.addEventListener('click', async () => {
  setStatus('Testing…', null);
  const resp = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }) as ExtensionResponse;
  if (resp.ok) setStatus('Connection works.', 'ok');
  else setStatus(`Failed: ${resp.error}${resp.detail ? ' — ' + resp.detail : ''}`, 'err');
});

function setStatus(text: string, cls: 'ok' | 'err' | null) {
  status.textContent = text;
  status.className = 'status' + (cls ? ' ' + cls : '');
}
```

- [ ] **Step 4: Wire TEST_CONNECTION in `extension/src/background/service-worker.ts`**

Replace the existing `chrome.runtime.onMessage.addListener` block with:

```typescript
import { isTestConnection } from '../lib/messages.js';
import { testConnection } from '../lib/api.js';
import type { ExtensionResponse, ErrorCode } from '../lib/messages.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  void (async () => {
    sendResponse(await dispatch(msg));
  })();
  return true;
});

async function dispatch(msg: unknown): Promise<ExtensionResponse> {
  try {
    if (isTestConnection(msg)) {
      await testConnection();
      return { ok: true };
    }
    return { ok: false, error: 'NOT_IMPLEMENTED' };
  } catch (err) {
    const e = err as { code?: ErrorCode; detail?: string };
    return { ok: false, error: e.code ?? 'UNKNOWN', detail: e.detail };
  }
}
```

(Keep the existing `onInstalled` and `contextMenus.onClicked` listeners as they are.)

- [ ] **Step 5: Build + typecheck**

```
cd extension && npm run build && npm run typecheck
```
Expected: clean.

- [ ] **Step 6: Manual smoke**

Reload extension. Right-click extension icon → Options. Paste a real token from Settings → Connected Apps → Save → Test connection → expect green "Connection works."

- [ ] **Step 7: Commit**

```
git add extension/src/options/ extension/src/background/service-worker.ts
git commit -m "feat(extension): options page (paste token + Test connection)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 4 — Add flow

### Task 11: Popup form templates

**Files:**
- Modify: `extension/src/popup/popup.html` — add `<template>`s for each state
- Modify: `extension/src/popup/popup.ts` — render Add form prefilled from `tab.url`/`tab.title`
- Modify: `extension/src/popup/popup.css` — form/control styles

- [ ] **Step 1: Replace `extension/src/popup/popup.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="popup.css">
</head>
<body>
  <div id="root"></div>

  <template id="tpl-form">
    <div class="header"><strong>Add to Price Tracker</strong><span class="host"></span></div>
    <div class="body">
      <label>Name</label>
      <input data-field="name" type="text" />

      <label>URL</label>
      <input data-field="url" type="text" readonly />

      <label>Threshold price (optional)</label>
      <input data-field="threshold" type="text" placeholder="$0.00" />

      <details class="advanced">
        <summary>Advanced</summary>
        <label>CSS selector (optional)</label>
        <input data-field="css" type="text" />
        <label>Check interval (minutes)</label>
        <input data-field="interval" type="number" min="5" placeholder="360" />
      </details>

      <button data-action="add" class="primary">Add Tracker</button>
      <div data-error class="error hidden"></div>
    </div>
  </template>

  <template id="tpl-no-token">
    <div class="header"><strong>Set up your API token</strong></div>
    <div class="body center">
      <p>The extension needs an API token from your Price Tracker.</p>
      <button data-action="open-options" class="primary">Open Settings</button>
    </div>
  </template>

  <template id="tpl-success">
    <div class="header"><strong>Added ✓</strong></div>
    <div class="body center">
      <div class="check-icon">✓</div>
      <div class="title">Tracking now</div>
      <p class="muted">First scrape will run within the next cron tick.</p>
      <a data-link class="ghost-button" target="_blank">View tracker →</a>
      <div class="muted small">closes in 2s…</div>
    </div>
  </template>

  <template id="tpl-error">
    <div class="header"><strong>Couldn't add tracker</strong></div>
    <div class="body">
      <p data-msg></p>
      <button data-action="retry" class="primary">Retry</button>
      <button data-action="open-options" class="ghost">Open Settings</button>
    </div>
  </template>

  <script type="module" src="popup.ts"></script>
</body>
</html>
```

- [ ] **Step 2: Replace `extension/src/popup/popup.css`**

```css
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  width: 360px;
  background: #0f172a;
  color: #f1f5f9;
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 13px;
}
.header {
  padding: 10px 14px;
  background: #1e293b;
  border-bottom: 1px solid #334155;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.header strong { font-size: 13px; }
.host { color: #94a3b8; font-size: 11px; }
.body { padding: 14px; }
.body.center { text-align: center; }
label {
  display: block;
  font-size: 11px;
  text-transform: uppercase;
  color: #94a3b8;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}
input {
  width: 100%;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 4px;
  padding: 7px 9px;
  color: #f1f5f9;
  font-size: 13px;
  font-family: inherit;
  margin-bottom: 10px;
}
input[readonly] { color: #94a3b8; font-size: 11px; }
.advanced { margin: 4px 0 10px 0; }
.advanced summary {
  color: #94a3b8;
  font-size: 11px;
  cursor: pointer;
  margin-bottom: 6px;
}
button, .ghost-button {
  display: block;
  width: 100%;
  background: #6366f1;
  color: white;
  border: none;
  border-radius: 4px;
  padding: 9px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  margin-top: 4px;
  text-align: center;
  text-decoration: none;
}
button:hover, .ghost-button:hover { background: #4f46e5; }
button.ghost, .ghost-button {
  background: transparent;
  border: 1px solid #334155;
  color: #f1f5f9;
}
.error { color: #ef4444; font-size: 12px; margin-top: 8px; }
.hidden { display: none; }
.muted { color: #94a3b8; font-size: 12px; margin: 8px 0 14px 0; }
.muted.small { font-size: 11px; margin: 8px 0 0 0; }
.check-icon {
  width: 36px; height: 36px;
  background: #10b981;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  margin: 4px auto 8px;
  color: white;
  font-size: 18px;
}
.title { font-weight: 500; margin-bottom: 4px; }
```

- [ ] **Step 3: Replace `extension/src/popup/popup.ts`**

```typescript
import { getStoredToken } from '../lib/api.js';
import type { ExtensionResponse, CreateMessage } from '../lib/messages.js';
import type { TrackerCreatePayload } from '../types/api.js';

const root = document.getElementById('root')!;

async function main() {
  const token = await getStoredToken();
  if (!token) { renderNoToken(); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) { renderError('Could not read the active tab. Open a retailer page and try again.'); return; }

  renderForm(tab.url, tab.title ?? '');
}

function renderNoToken() {
  swap('tpl-no-token');
  root.querySelector('[data-action="open-options"]')!.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

function renderForm(url: string, title: string) {
  swap('tpl-form');
  const host = root.querySelector('.host')!;
  host.textContent = new URL(url).hostname;

  const $name = root.querySelector('[data-field="name"]') as HTMLInputElement;
  const $url = root.querySelector('[data-field="url"]') as HTMLInputElement;
  const $threshold = root.querySelector('[data-field="threshold"]') as HTMLInputElement;
  const $css = root.querySelector('[data-field="css"]') as HTMLInputElement;
  const $interval = root.querySelector('[data-field="interval"]') as HTMLInputElement;
  $name.value = title;
  $url.value = url;
  $name.focus();
  $name.select();

  const $error = root.querySelector('[data-error]') as HTMLDivElement;

  root.querySelector('[data-action="add"]')!.addEventListener('click', async () => {
    $error.classList.add('hidden');
    const payload: TrackerCreatePayload = {
      name: $name.value.trim(),
      url: $url.value,
      threshold_price: parseThreshold($threshold.value),
      css_selector: $css.value.trim() || null,
      check_interval_minutes: parseInterval($interval.value),
    };
    if (!payload.name) { showError($error, 'Name is required.'); return; }
    const msg: CreateMessage = { type: 'CREATE', payload };
    const resp = await chrome.runtime.sendMessage(msg) as ExtensionResponse;
    if (resp.ok && 'tracker' in resp) {
      renderSuccess(resp.tracker.id);
    } else if (!resp.ok) {
      showError($error, errorText(resp.error, resp.detail));
    }
  });
}

function renderSuccess(trackerId: number) {
  swap('tpl-success');
  const link = root.querySelector('[data-link]') as HTMLAnchorElement;
  link.href = `https://prices.schultzsolutions.tech/tracker/${trackerId}`;
  setTimeout(() => window.close(), 2000);
}

function renderError(text: string) {
  swap('tpl-error');
  (root.querySelector('[data-msg]') as HTMLElement).textContent = text;
  root.querySelector('[data-action="retry"]')!.addEventListener('click', () => location.reload());
  root.querySelector('[data-action="open-options"]')!.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function swap(tplId: string) {
  const tpl = document.getElementById(tplId) as HTMLTemplateElement;
  root.replaceChildren(tpl.content.cloneNode(true));
}

function showError(node: HTMLDivElement, msg: string) {
  node.textContent = msg;
  node.classList.remove('hidden');
}

function parseThreshold(s: string): number | null {
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseInterval(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 5 ? n : undefined;
}

function errorText(code: string, detail?: string): string {
  switch (code) {
    case 'NO_TOKEN': return 'Open Settings to paste your API token.';
    case 'UNAUTHORIZED': return 'Token isn\'t working — re-paste in Settings.';
    case 'NETWORK': return 'Couldn\'t reach prices.schultzsolutions.tech.';
    case 'SERVER': return 'Server hiccup — try again, or add manually.';
    case 'VALIDATION': return `URL doesn't look right${detail ? ` (${detail})` : ''}.`;
    case 'CONFLICT': return 'Already tracking this URL.';
    default: return 'Something went wrong.';
  }
}

main().catch(err => renderError(String(err)));
```

- [ ] **Step 4: Build + typecheck**

```
cd extension && npm run build && npm run typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```
git add extension/src/popup/
git commit -m "feat(extension): popup Add form with prefilled name/URL + state templates

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Background CREATE handler

**Files:**
- Modify: `extension/src/background/service-worker.ts`

- [ ] **Step 1: Update the dispatch in `service-worker.ts`**

Update the imports at the top to add `isCreate` and `createTracker`. Replace the existing `dispatch` function with:

```typescript
import { isTestConnection, isCreate } from '../lib/messages.js';
import { testConnection, createTracker } from '../lib/api.js';
import type { ExtensionResponse, ErrorCode } from '../lib/messages.js';

async function dispatch(msg: unknown): Promise<ExtensionResponse> {
  try {
    if (isTestConnection(msg)) {
      await testConnection();
      return { ok: true };
    }
    if (isCreate(msg)) {
      const tracker = await createTracker(msg.payload);
      return { ok: true, tracker };
    }
    return { ok: false, error: 'NOT_IMPLEMENTED' };
  } catch (err) {
    const e = err as { code?: ErrorCode; detail?: string };
    return { ok: false, error: e.code ?? 'UNKNOWN', detail: e.detail };
  }
}
```

- [ ] **Step 2: Build + typecheck**

```
cd extension && npm run build && npm run typecheck
```
Expected: clean.

- [ ] **Step 3: Manual smoke**

Reload extension. Right-click any retailer page → "Add to Price Tracker" → confirm in popup → expect: success state, tracker row visible at `prices.schultzsolutions.tech/tracker/<id>`.

- [ ] **Step 4: Commit**

```
git add extension/src/background/service-worker.ts
git commit -m "feat(extension): background CREATE handler routes POST /api/trackers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 5 — Duplicate detection

### Task 13: Port `normalize-url.ts` and `domains.ts` from server

**Files:**
- Create: `extension/src/lib/domains.ts`
- Create: `extension/src/lib/normalize-url.ts`
- Create: `extension/src/lib/normalize-url.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// extension/src/lib/normalize-url.test.ts
// Parity test: outputs must match server/src/lib/normalize-url.test.ts
// for the same inputs. This is a drift detector.
import { describe, it, expect } from 'vitest';
import { normalizeTrackerUrl } from './normalize-url.js';

describe('normalizeTrackerUrl — parity with server', () => {
  it('canonicalizes amazon variants to amazon.com', () => {
    expect(normalizeTrackerUrl('https://www.amazon.com/dp/B01N5IB20Q'))
      .toBe('amazon.com/dp/b01n5ib20q');
    expect(normalizeTrackerUrl('https://smile.amazon.com/dp/B01N5IB20Q'))
      .toBe('amazon.com/dp/b01n5ib20q');
    expect(normalizeTrackerUrl('https://amazon.co.uk/dp/B01N5IB20Q'))
      .toBe('amazon.com/dp/b01n5ib20q');
  });

  it('strips tracking + utm params, keeps product params', () => {
    expect(normalizeTrackerUrl(
      'https://www.amazon.com/dp/B01?tag=foo&ref=bar&utm_source=z&size=large',
    )).toBe('amazon.com/dp/b01?size=large');
  });

  it('returns null on malformed input', () => {
    expect(normalizeTrackerUrl('not a url')).toBeNull();
    expect(normalizeTrackerUrl('')).toBeNull();
  });

  it('strips trailing slash on path', () => {
    expect(normalizeTrackerUrl('https://newegg.com/p/A/'))
      .toBe('newegg.com/p/a');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
cd extension && npm test
```
Expected: FAIL — `Cannot find module ./normalize-url.js`.

- [ ] **Step 3: Copy the two files from the server**

```
cp /root/price-tracker/server/src/lib/domains.ts /root/price-tracker/extension/src/lib/domains.ts
cp /root/price-tracker/server/src/lib/normalize-url.ts /root/price-tracker/extension/src/lib/normalize-url.ts
```

The server's `normalize-url.ts` imports from `./domains.js` — same import works here since we just copied that file too. Both are pure-JS modules with no external deps, so no further changes are needed.

- [ ] **Step 4: Run tests to verify they pass**

```
cd extension && npm test
```
Expected: PASS, all 4 parity tests + the prior 3 message tests.

- [ ] **Step 5: Commit**

```
git add extension/src/lib/domains.ts extension/src/lib/normalize-url.ts extension/src/lib/normalize-url.test.ts
git commit -m "feat(extension): port normalize-url + domains from server (parity-tested)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: Background CHECK_DUP handler with cache

**Files:**
- Modify: `extension/src/background/service-worker.ts`

- [ ] **Step 1: Add cache helper + CHECK_DUP handler**

Update imports and add the cache helpers:

```typescript
import { isTestConnection, isCreate, isCheckDup } from '../lib/messages.js';
import { testConnection, createTracker, listTrackers } from '../lib/api.js';
import { normalizeTrackerUrl } from '../lib/normalize-url.js';
import type { ExtensionResponse, ErrorCode } from '../lib/messages.js';
import type { Tracker } from '../types/api.js';

const TRACKER_LIST_TTL_MS = 60_000;

interface CachedList {
  fetchedAt: number;
  trackers: Tracker[];
}

async function getCachedTrackerList(): Promise<Tracker[]> {
  const data = await chrome.storage.session.get(['trackerListCache']);
  const cached = data.trackerListCache as CachedList | undefined;
  if (cached && Date.now() - cached.fetchedAt < TRACKER_LIST_TTL_MS) {
    return cached.trackers;
  }
  const trackers = await listTrackers();
  await chrome.storage.session.set({
    trackerListCache: { fetchedAt: Date.now(), trackers } satisfies CachedList,
  });
  return trackers;
}

async function appendToCache(tracker: Tracker): Promise<void> {
  const data = await chrome.storage.session.get(['trackerListCache']);
  const cached = data.trackerListCache as CachedList | undefined;
  if (!cached) return; // no cache yet — let the next read fetch fresh
  await chrome.storage.session.set({
    trackerListCache: { fetchedAt: cached.fetchedAt, trackers: [...cached.trackers, tracker] },
  });
}
```

Update `dispatch` to handle CHECK_DUP and update the cache after a successful CREATE:

```typescript
async function dispatch(msg: unknown): Promise<ExtensionResponse> {
  try {
    if (isTestConnection(msg)) {
      await testConnection();
      return { ok: true };
    }
    if (isCheckDup(msg)) {
      const target = normalizeTrackerUrl(msg.url);
      if (!target) return { ok: true, exists: false };
      const trackers = await getCachedTrackerList();
      const match = trackers.find(t => t.normalized_url === target);
      return match
        ? { ok: true, exists: true, tracker: match }
        : { ok: true, exists: false };
    }
    if (isCreate(msg)) {
      const tracker = await createTracker(msg.payload);
      await appendToCache(tracker);
      return { ok: true, tracker };
    }
    return { ok: false, error: 'NOT_IMPLEMENTED' };
  } catch (err) {
    const e = err as { code?: ErrorCode; detail?: string };
    return { ok: false, error: e.code ?? 'UNKNOWN', detail: e.detail };
  }
}
```

- [ ] **Step 2: Build + typecheck**

```
cd extension && npm run build && npm run typecheck
```
Expected: clean.

- [ ] **Step 3: Commit**

```
git add extension/src/background/service-worker.ts
git commit -m "feat(extension): CHECK_DUP handler with chrome.storage.session cache (60s TTL)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 15: Popup "Already tracking" state

**Files:**
- Modify: `extension/src/popup/popup.html` — add the dup template
- Modify: `extension/src/popup/popup.ts` — call CHECK_DUP on mount, branch on result
- Modify: `extension/src/popup/popup.css` — style the dup card

- [ ] **Step 1: Add `<template id="tpl-dup">` to `popup.html`**

Insert before the closing `</body>`:

```html
<template id="tpl-dup">
  <div class="header"><strong>Already tracking</strong><span class="host"></span></div>
  <div class="body">
    <div class="muted small" data-name></div>
    <div class="last-price">
      <span data-price>—</span>
      <span data-verdict class="verdict-pill hidden"></span>
    </div>
    <p class="muted" data-reason></p>
    <a data-link class="ghost-button" target="_blank">Open in Price Tracker →</a>
  </div>
</template>
```

- [ ] **Step 2: Add styles in `popup.css`**

Append:

```css
.last-price {
  font-size: 22px;
  font-weight: 600;
  margin: 4px 0 8px 0;
}
.verdict-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  margin-left: 6px;
  vertical-align: middle;
  color: white;
}
.verdict-pill.buy { background: #10b981; }
.verdict-pill.wait { background: #f59e0b; }
.verdict-pill.hold { background: #94a3b8; }
```

- [ ] **Step 3: Update `popup.ts` to do dup check on mount + add `renderDup`**

Update the imports at the top:

```typescript
import { getStoredToken } from '../lib/api.js';
import type { ExtensionResponse, CreateMessage, CheckDupMessage } from '../lib/messages.js';
import type { TrackerCreatePayload, Tracker } from '../types/api.js';
```

Replace `main()` with:

```typescript
async function main() {
  const token = await getStoredToken();
  if (!token) { renderNoToken(); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) { renderError('Could not read the active tab.'); return; }

  const dup: ExtensionResponse = await chrome.runtime.sendMessage({
    type: 'CHECK_DUP', url: tab.url,
  } satisfies CheckDupMessage);

  if (dup.ok && 'exists' in dup && dup.exists && dup.tracker) {
    renderDup(dup.tracker);
    return;
  }

  renderForm(tab.url, tab.title ?? '');
}
```

Add the `renderDup` function (anywhere in the module):

```typescript
function renderDup(tracker: Tracker) {
  swap('tpl-dup');
  const host = root.querySelector('.host')!;
  try { host.textContent = new URL(tracker.url).hostname; } catch { /* keep blank */ }
  (root.querySelector('[data-name]') as HTMLElement).textContent = tracker.name;
  (root.querySelector('[data-price]') as HTMLElement).textContent =
    tracker.last_price !== null ? `$${tracker.last_price.toFixed(2)}` : '—';
  if (tracker.ai_verdict_tier) {
    const pill = root.querySelector('[data-verdict]') as HTMLElement;
    pill.textContent = tracker.ai_verdict_tier;
    pill.classList.remove('hidden');
    pill.classList.add(tracker.ai_verdict_tier.toLowerCase());
  }
  (root.querySelector('[data-reason]') as HTMLElement).textContent =
    tracker.ai_verdict_reason ?? '';
  (root.querySelector('[data-link]') as HTMLAnchorElement).href =
    `https://prices.schultzsolutions.tech/tracker/${tracker.id}`;
}
```

(All other functions in `popup.ts` stay as they are.)

- [ ] **Step 4: Build + typecheck**

```
cd extension && npm run build && npm run typecheck
```
Expected: clean.

- [ ] **Step 5: Manual smoke**

Reload extension. Click the toolbar icon on a URL you ALREADY track → expect: "Already tracking" card with verdict pill. Click on a fresh URL → Add form. Add it, click toolbar again on the same URL → "Already tracking" (cache appended in Task 14).

- [ ] **Step 6: Commit**

```
git add extension/src/popup/
git commit -m "feat(extension): popup 'Already tracking' state on duplicate URL

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Milestone 6 — Polish

### Task 16: Real branded icons

**Files:**
- Replace: `extension/icons/icon-{16,32,48,128}.png`

- [ ] **Step 1: Generate the icons**

Either hand-design a 128×128 source PNG (logo on dark indigo `#0f172a` background, white "P" or chart-line glyph) and downsample, or reuse the SPA's existing 512px PWA icon as the source. With ImageMagick available locally:

```
cd /root/price-tracker
convert client/public/icons/icon-512.png -resize 16x16   extension/icons/icon-16.png
convert client/public/icons/icon-512.png -resize 32x32   extension/icons/icon-32.png
convert client/public/icons/icon-512.png -resize 48x48   extension/icons/icon-48.png
convert client/public/icons/icon-512.png -resize 128x128 extension/icons/icon-128.png
```

If you don't have ImageMagick or Node-side tooling, hand-export from a graphics editor of your choice and drop the four PNGs at the matching paths.

- [ ] **Step 2: Verify pixel sizes**

```
file extension/icons/icon-*.png
```
Expected: each line shows the matching `WxH` dimension (16x16, 32x32, 48x48, 128x128).

- [ ] **Step 3: Build to confirm manifest still valid**

```
cd extension && npm run build
```
Expected: clean build, all four icons referenced from `dist/manifest.json`.

- [ ] **Step 4: Commit**

```
git add extension/icons/
git commit -m "feat(extension): real branded icons (16/32/48/128)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 17: Loading polish in popup

**Files:**
- Modify: `extension/src/popup/popup.html` — add `<template id="tpl-loading">`
- Modify: `extension/src/popup/popup.css` — `.loading` + `.spinner`
- Modify: `extension/src/popup/popup.ts` — render loading state during dup-check

- [ ] **Step 1: Add `<template id="tpl-loading">` in `popup.html`**

```html
<template id="tpl-loading">
  <div class="header"><strong>Price Tracker</strong></div>
  <div class="body center loading">
    <div class="spinner"></div>
    <p class="muted small">Checking…</p>
  </div>
</template>
```

- [ ] **Step 2: Add `.spinner` + `.loading` CSS in `popup.css`**

Append:

```css
.loading { padding: 30px 14px; }
.spinner {
  width: 20px; height: 20px;
  border: 2px solid #334155;
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  margin: 0 auto 8px;
}
@keyframes spin { to { transform: rotate(360deg); } }
```

- [ ] **Step 3: Render loading state at the start of `main()` in `popup.ts`**

Replace the first lines of `main()`:

```typescript
async function main() {
  swap('tpl-loading');

  const token = await getStoredToken();
  if (!token) { renderNoToken(); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) { renderError('Could not read the active tab.'); return; }

  const dup: ExtensionResponse = await chrome.runtime.sendMessage({
    type: 'CHECK_DUP', url: tab.url,
  } satisfies CheckDupMessage);

  if (dup.ok && 'exists' in dup && dup.exists && dup.tracker) {
    renderDup(dup.tracker);
    return;
  }

  renderForm(tab.url, tab.title ?? '');
}
```

- [ ] **Step 4: Build + smoke**

```
cd extension && npm run build && npm run typecheck
```
Expected: clean. Reload extension → click icon → spinner → form (or dup card) within ~200-400ms.

- [ ] **Step 5: Commit**

```
git add extension/src/popup/
git commit -m "feat(extension): loading state during popup mount

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 18: RELEASE.md sideload instructions

**Files:**
- Create: `extension/RELEASE.md`

- [ ] **Step 1: Create the file**

````markdown
# Price Tracker — Browser Extension

Chrome MV3 extension that adds the current page as a tracker in one click.

## Sideload (Chrome / Edge / Brave)

1. Build the extension:
   ```
   cd extension
   npm install   # first time only
   npm run build
   ```
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `extension/dist/` folder
6. Pin the extension icon to the toolbar (puzzle-piece menu → pin Price Tracker)

## First-time setup

1. Sign in to https://prices.schultzsolutions.tech
2. Go to **Settings → Connected Apps → Generate new token**
3. Name it ("Browser Extension"), click Generate, **copy the token** (shown once)
4. In Chrome: right-click the extension icon → **Options**
5. Paste the token → **Save** → **Test connection** → expect green "Connection works."

## Usage

- Click the toolbar icon, OR
- Right-click any retailer page → **Add to Price Tracker**

The popup pre-fills the page title + URL. Set an optional threshold price, click **Add Tracker**, done. Re-clicking on a tracked URL shows the current price + AI verdict instead of the Add form.

## Updating

```
cd extension
git pull
npm run build
```
Then in `chrome://extensions`, click the **Reload** button next to Price Tracker.

## Revoking access

Settings → Connected Apps → **Revoke** next to the token. The extension's stored token will start failing — re-paste a new token in Options.
````

- [ ] **Step 2: Commit**

```
git add extension/RELEASE.md
git commit -m "docs(extension): sideload + first-time setup instructions

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 19: Whole-feature manual smoke + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the full server suite**

```
cd /root/price-tracker/server && npm test -- --run
```
Expected: PASS, all tests including the new ~24 token/middleware tests.

- [ ] **Step 2: Run the full client suite**

```
cd /root/price-tracker/client && npm test -- --run
```
Expected: PASS, including the new ConnectedAppsCard tests.

- [ ] **Step 3: Run the extension test suite**

```
cd /root/price-tracker/extension && npm test
```
Expected: PASS, message + parity tests.

- [ ] **Step 4: Typecheck everything**

```
cd /root/price-tracker/server && npx tsc --noEmit
cd /root/price-tracker/client && npx tsc --noEmit
cd /root/price-tracker/extension && npm run typecheck
```
Expected: all three clean.

- [ ] **Step 5: Manual end-to-end smoke**

a. Deploy server changes:
   ```
   cd /root/price-tracker && bash scripts/deploy.sh
   ```
b. Open https://prices.schultzsolutions.tech/settings → Connected Apps card visible. Generate a token. Copy.
c. `cd extension && npm run build` → load `extension/dist/` unpacked in Chrome.
d. Right-click extension icon → Options → paste token → Save → Test connection → "Connection works."
e. Right-click on `https://www.amazon.com/dp/<some product>` → "Add to Price Tracker" → fill threshold → Add → expect success state, auto-close after 2s.
f. Verify tracker appears at https://prices.schultzsolutions.tech/tracker/<id>
g. Right-click again on the same URL → expect "Already tracking" state with last price (may be `—` if first scrape hasn't run) and verdict pill (may be missing if `AI_ENABLED=false`).
h. Settings → Connected Apps → Revoke. Click extension icon on a fresh URL → expect "Token isn't working — re-paste in Settings."
i. Generate a new token, paste in Options, retry → success.

- [ ] **Step 6: Open the PR**

```
git push -u origin feature/browser-extension
gh pr create --title "feat: browser extension + per-user API tokens" --body "$(cat <<'EOF'
## Summary

- New Chrome MV3 extension at `extension/` — toolbar icon + right-click context menu, popup confirmation form, Already-tracking state on revisit, sideload-only for v1
- New server-side per-user API tokens — Settings → Connected Apps card, hashed (SHA-256) at rest, soft-delete via `revoked_at`
- `apiKeyMiddleware` extended to accept user-issued tokens alongside the existing global `PRICE_TRACKER_API_KEY` (OpenClaw flow)
- Migration v12: `user_api_tokens` table

Spec: `docs/superpowers/specs/2026-05-06-browser-extension-design.md`
Plan: `docs/superpowers/plans/2026-05-06-browser-extension.md`

## Test plan
- [x] Server suite (~510 tests)
- [x] Client suite
- [x] Extension suite (normalize-url parity + message contracts)
- [x] Typecheck server / client / extension all clean
- [x] Manual: token mint → paste → test → add tracker → revisit shows dup state → revoke → fail → re-mint → recover
- [ ] Deploy and verify Settings → Connected Apps card appears live
EOF
)"
```

- [ ] **Step 7: Print PR URL**

```
gh pr view --json url,state | jq
```
Expected: open PR with the URL printed.

---

### Task 20: Mark v1 done in `tasks/todo.md`

**Files:**
- Modify: `tasks/todo.md`

- [ ] **Step 1: After PR is merged + deployed**

Update the Browser extension entry in `tasks/todo.md`:
- Change `- [ ]` to `- [x]`
- Add `**Done YYYY-MM-DD:** ` followed by a 1-2 sentence summary including server test count delta and the merged PR link
- Move any nits discovered during implementation into the v2 sub-list immediately below

- [ ] **Step 2: Commit the todo update directly to main (per CLAUDE.md: "Commit directly to main only for trivial or solo changes")**

```
git checkout main
git pull
# edit tasks/todo.md
git add tasks/todo.md
git commit -m "docs: mark browser extension v1 done; carry-forward to v2

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

---

## Out of Scope (for reference)

These were ruled out during brainstorming and are tracked in `tasks/todo.md` under the Browser extension entry:

- Live in-page price extraction / element picker / content scripts
- Firefox compat
- Chrome Web Store distribution
- Quick-edit / delete trackers from popup
- Add-to-Project flow from popup
- Toolbar badge / icon coloring
- Keyboard shortcut

---

## Final Self-Review

Spec coverage: every section of the spec maps to at least one task.

| Spec section | Task(s) |
|---|---|
| Migration v12 | 1 |
| Token DB helpers | 2 |
| Token routes (POST/GET/DELETE) | 3 |
| Middleware extension | 4 |
| Settings UI | 5 |
| Extension scaffolding | 6, 7, 8 |
| Options page + token storage | 9, 10 |
| Popup add flow | 11, 12 |
| Duplicate detection | 13, 14, 15 |
| Polish (icons, loading, RELEASE.md) | 16, 17, 18 |
| Manual smoke + PR | 19 |
| Todo retro | 20 |
| Error categories table | 11 (errorText), 9 (api.ts switch) |
| Observability logs (api_token_*) | 3 (POST/DELETE), 4 (auth_failed) |
| Security: hashed at rest, plaintext shown once, host_permissions minimum | 2, 5, 6 |
| Testing: parity tests, ownership scoping | 13, 3 |

Type consistency: `Tracker`, `TrackerCreatePayload`, `ExtensionMessage`/`ExtensionResponse`, `ErrorCode`, and `CachedList` are defined once and used consistently across tasks. Function signatures (`createUserApiToken`, `findActiveTokenByHash`, `revokeUserApiToken`, `touchTokenLastUsed`) match between Task 2's definitions and Task 3/4's call sites. Message-type guards (`isCheckDup`, `isCreate`, `isTestConnection`) introduced in Task 9 and used unchanged in Tasks 10, 12, 14.

No placeholders.
