# User Accounts & Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add multi-user support with invite-only registration, JWT auth, and per-user data isolation to Price-Tracker.

**Architecture:** Express backend gains auth middleware, user/invite/token tables in SQLite, and per-user query filtering. React frontend adds AuthContext, login/register pages, and an admin panel. JWT access tokens (15 min) and refresh tokens (30 days) are stored in httpOnly cookies.

**Tech Stack:** Express, better-sqlite3, bcrypt, jsonwebtoken, cookie-parser, express-rate-limit, React Context API

**Spec:** `docs/superpowers/specs/2026-03-30-user-accounts-design.md`

---

## File Structure

### Server — New Files
| File | Responsibility |
|------|---------------|
| `server/src/db/migrations.ts` | Schema migration runner with version tracking |
| `server/src/auth/passwords.ts` | bcrypt hash/verify wrappers |
| `server/src/auth/tokens.ts` | JWT sign/verify, refresh token generation, cookie helpers |
| `server/src/auth/middleware.ts` | `authMiddleware` and `adminMiddleware` |
| `server/src/routes/auth.ts` | Login, register, logout, refresh, me endpoints |
| `server/src/routes/admin.ts` | User management, invite code CRUD |
| `server/src/db/user-queries.ts` | User, invite code, and refresh token DB operations |

### Server — Modified Files
| File | Changes |
|------|---------|
| `server/src/config.ts` | Add `jwtSecret`, `jwtAccessExpiry`, `jwtRefreshExpiry` |
| `server/src/db/schema.ts` | Add migration call before legacy schema init |
| `server/src/db/queries.ts` | Add `userId` param to all tracker/settings/notification queries |
| `server/src/routes/trackers.ts` | Extract `req.user.id`, pass to queries |
| `server/src/routes/prices.ts` | Extract `req.user.id`, verify tracker ownership |
| `server/src/routes/settings.ts` | Per-user settings with `req.user.id` |
| `server/src/scheduler/cron.ts` | Resolve per-user webhook in `checkTracker` |
| `server/src/notifications/discord.ts` | Accept webhook URL param instead of global lookup |
| `server/src/index.ts` | Add cookie-parser, rate limiter, auth middleware, new routes, first-run setup |
| `server/package.json` | Add bcrypt, jsonwebtoken, cookie-parser, express-rate-limit |

### Client — New Files
| File | Responsibility |
|------|---------------|
| `client/src/context/AuthContext.tsx` | Auth state provider, login/logout/refresh functions |
| `client/src/components/ProtectedRoute.tsx` | Redirect to `/login` if not authenticated |
| `client/src/components/AdminRoute.tsx` | Redirect if not admin |
| `client/src/pages/Login.tsx` | Login form |
| `client/src/pages/Register.tsx` | Registration form with invite code |
| `client/src/pages/Admin.tsx` | User management + invite code tabs |
| `client/src/pages/Setup.tsx` | First-run admin account creation |

### Client — Modified Files
| File | Changes |
|------|---------|
| `client/src/types.ts` | Add `User`, `InviteCode` interfaces |
| `client/src/api.ts` | Add `credentials: 'include'`, auth API calls, 401 interceptor |
| `client/src/main.tsx` | Wrap with `AuthProvider` |
| `client/src/App.tsx` | Add auth routes, protected routes, nav user display + logout |

---

## Task 1: Install Server Dependencies

**Files:**
- Modify: `server/package.json`

- [ ] **Step 1: Install new packages**

```bash
cd /root/price-tracker/server && npm install bcrypt jsonwebtoken cookie-parser express-rate-limit
```

- [ ] **Step 2: Install type definitions**

```bash
cd /root/price-tracker/server && npm install -D @types/bcrypt @types/jsonwebtoken @types/cookie-parser
```

- [ ] **Step 3: Verify install**

```bash
cd /root/price-tracker/server && npm ls bcrypt jsonwebtoken cookie-parser express-rate-limit
```

Expected: All four packages listed without errors.

- [ ] **Step 4: Commit**

```bash
cd /root/price-tracker && git add server/package.json server/package-lock.json
git commit -m "chore: add auth dependencies (bcrypt, jsonwebtoken, cookie-parser, express-rate-limit)"
```

---

## Task 2: Add Config for Auth

**Files:**
- Modify: `server/src/config.ts`

- [ ] **Step 1: Update config.ts**

Add JWT and auth configuration to the existing config object:

```typescript
// In server/src/config.ts, add to the config object:
export const config = {
  // ... existing fields stay the same ...
  port: parseInt(process.env.PORT || '3100', 10),
  databasePath: resolve(process.env.DATABASE_PATH || './data/price-tracker.db'),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  defaultCheckInterval: 360,
  notificationCooldownHours: 6,
  maxConsecutiveFailures: 3,
  maxConcurrentScrapes: 2,

  // Auth
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-do-not-use-in-prod'),
  jwtAccessExpirySeconds: 900,       // 15 minutes
  jwtRefreshExpiryDays: 30,
  bcryptRounds: 12,
  isProduction: process.env.NODE_ENV === 'production',
};

// Fail fast if JWT_SECRET is missing in production
if (config.isProduction && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required in production');
  process.exit(1);
}
```

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add server/src/config.ts
git commit -m "feat: add JWT and auth configuration"
```

---

## Task 3: Schema Migration System

**Files:**
- Create: `server/src/db/migrations.ts`
- Modify: `server/src/db/schema.ts`

- [ ] **Step 1: Create migrations.ts**

```typescript
// server/src/db/migrations.ts
import { getDb } from './connection.js';
import { logger } from '../logger.js';

interface Migration {
  version: number;
  description: string;
  up: () => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Add user accounts, invite codes, refresh tokens',
    up: () => {
      const db = getDb();

      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS invite_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          created_by INTEGER REFERENCES users(id),
          used_by INTEGER REFERENCES users(id),
          expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by);
        CREATE INDEX IF NOT EXISTS idx_invite_codes_used_by ON invite_codes(used_by);

        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT UNIQUE NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
      `);

      // Add user_id to trackers (nullable for migration)
      const trackerCols = db.prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
      if (!trackerCols.some(c => c.name === 'user_id')) {
        db.exec('ALTER TABLE trackers ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
        db.exec('CREATE INDEX IF NOT EXISTS idx_trackers_user_id ON trackers(user_id)');
      }

      // Recreate settings table with composite PK (user_id, key)
      const settingsCols = db.prepare("PRAGMA table_info(settings)").all() as { name: string }[];
      if (!settingsCols.some(c => c.name === 'user_id')) {
        db.exec(`
          CREATE TABLE settings_new (
            user_id INTEGER,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
          );
          INSERT INTO settings_new (user_id, key, value)
            SELECT NULL, key, value FROM settings;
          DROP TABLE settings;
          ALTER TABLE settings_new RENAME TO settings;
        `);
      }
    },
  },
];

export function runMigrations(): void {
  const db = getDb();

  // Create schema_migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map(r => r.version)
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    logger.info({ version: migration.version, description: migration.description }, 'Applying migration');

    db.transaction(() => {
      migration.up();
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    })();

    logger.info({ version: migration.version }, 'Migration applied');
  }
}
```

- [ ] **Step 2: Update schema.ts to run migrations**

In `server/src/db/schema.ts`, add the migration call at the end of `initializeSchema()`:

```typescript
// Add import at top:
import { runMigrations } from './migrations.js';

// Add at end of initializeSchema() function, after the existing db.exec():
  runMigrations();
```

- [ ] **Step 3: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Test migration runs**

```bash
cd /root/price-tracker/server && npx tsx -e "
import { initializeSchema } from './src/db/schema.js';
initializeSchema();
console.log('Migration successful');
import { getDb } from './src/db/connection.js';
const tables = getDb().prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('Tables:', tables.map((t) => t.name));
const cols = getDb().prepare('PRAGMA table_info(trackers)').all();
console.log('Tracker columns:', cols.map((c) => c.name));
const settingsCols = getDb().prepare('PRAGMA table_info(settings)').all();
console.log('Settings columns:', settingsCols.map((c) => c.name));
getDb().close();
"
```

Expected: Should show `users`, `invite_codes`, `refresh_tokens`, `schema_migrations` tables. `trackers` should have `user_id` column. `settings` should have `user_id` and `key` columns.

- [ ] **Step 5: Commit**

```bash
cd /root/price-tracker && git add server/src/db/migrations.ts server/src/db/schema.ts
git commit -m "feat: add schema migration system with user accounts tables"
```

---

## Task 4: Password Utilities

**Files:**
- Create: `server/src/auth/passwords.ts`

- [ ] **Step 1: Create passwords.ts**

```typescript
// server/src/auth/passwords.ts
import bcrypt from 'bcrypt';
import { config } from '../config.js';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.bcryptRounds);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
```

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add server/src/auth/passwords.ts
git commit -m "feat: add password hashing utilities"
```

---

## Task 5: Token Utilities

**Files:**
- Create: `server/src/auth/tokens.ts`

- [ ] **Step 1: Create tokens.ts**

```typescript
// server/src/auth/tokens.ts
import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import type { Response } from 'express';
import { config } from '../config.js';

export interface TokenPayload {
  userId: number;
  email: string;
  role: string;
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtAccessExpirySeconds,
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwtSecret) as TokenPayload;
}

export function generateRefreshToken(): string {
  return randomBytes(64).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict' as const,
    path: '/',
  };

  res.cookie('access_token', accessToken, {
    ...cookieOptions,
    maxAge: config.jwtAccessExpirySeconds * 1000,
  });

  res.cookie('refresh_token', refreshToken, {
    ...cookieOptions,
    maxAge: config.jwtRefreshExpiryDays * 24 * 60 * 60 * 1000,
    path: '/api/auth', // Only sent to auth endpoints
  });
}

export function clearAuthCookies(res: Response): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict' as const,
    path: '/',
  };

  res.clearCookie('access_token', cookieOptions);
  res.clearCookie('refresh_token', { ...cookieOptions, path: '/api/auth' });
}
```

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add server/src/auth/tokens.ts
git commit -m "feat: add JWT and refresh token utilities"
```

---

## Task 6: User & Auth Database Queries

**Files:**
- Create: `server/src/db/user-queries.ts`

- [ ] **Step 1: Create user-queries.ts**

```typescript
// server/src/db/user-queries.ts
import { randomBytes } from 'crypto';
import { getDb } from './connection.js';
import { hashToken } from '../auth/tokens.js';

export interface User {
  id: number;
  email: string;
  password_hash: string;
  display_name: string;
  role: 'admin' | 'user';
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface SafeUser {
  id: number;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface InviteCode {
  id: number;
  code: string;
  created_by: number;
  used_by: number | null;
  expires_at: string | null;
  created_at: string;
}

// --- Users ---

export function getUserByEmail(email: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
}

export function getUserById(id: number): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getSafeUserById(id: number): SafeUser | undefined {
  return getDb().prepare(
    'SELECT id, email, display_name, role, is_active, created_at, updated_at FROM users WHERE id = ?'
  ).get(id) as SafeUser | undefined;
}

export function createUser(data: {
  email: string;
  password_hash: string;
  display_name: string;
  role?: 'admin' | 'user';
}): User {
  const stmt = getDb().prepare(`
    INSERT INTO users (email, password_hash, display_name, role)
    VALUES (@email, @password_hash, @display_name, @role)
  `);
  const result = stmt.run({
    email: data.email,
    password_hash: data.password_hash,
    display_name: data.display_name,
    role: data.role ?? 'user',
  });
  return getUserById(Number(result.lastInsertRowid))!;
}

export function getUserCount(): number {
  return (getDb().prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
}

export function getAllUsers(): SafeUser[] {
  return getDb().prepare(
    'SELECT id, email, display_name, role, is_active, created_at, updated_at FROM users ORDER BY created_at DESC'
  ).all() as SafeUser[];
}

export function updateUser(id: number, data: Partial<{ role: string; is_active: number }>): SafeUser | undefined {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return getSafeUserById(id);

  fields.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = @id`).run(values);
  return getSafeUserById(id);
}

export function deleteUser(id: number): boolean {
  const result = getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getActiveAdminCount(): number {
  return (getDb().prepare(
    "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1"
  ).get() as { count: number }).count;
}

export function resetUserPassword(id: number, passwordHash: string): boolean {
  const result = getDb().prepare(
    "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(passwordHash, id);
  return result.changes > 0;
}

// --- Invite Codes ---

export function createInviteCode(createdBy: number, expiresAt?: string): InviteCode {
  const code = randomBytes(12).toString('hex'); // 24-char hex
  const stmt = getDb().prepare(`
    INSERT INTO invite_codes (code, created_by, expires_at)
    VALUES (@code, @created_by, @expires_at)
  `);
  const result = stmt.run({
    code,
    created_by: createdBy,
    expires_at: expiresAt ?? null,
  });
  return getDb().prepare('SELECT * FROM invite_codes WHERE id = ?').get(Number(result.lastInsertRowid)) as InviteCode;
}

export function getInviteByCode(code: string): InviteCode | undefined {
  return getDb().prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as InviteCode | undefined;
}

export function markInviteUsed(code: string, usedBy: number): void {
  getDb().prepare('UPDATE invite_codes SET used_by = ? WHERE code = ?').run(usedBy, code);
}

export function getAllInviteCodes(): InviteCode[] {
  return getDb().prepare('SELECT * FROM invite_codes ORDER BY created_at DESC').all() as InviteCode[];
}

export function deleteInviteCode(id: number): boolean {
  const result = getDb().prepare('DELETE FROM invite_codes WHERE id = ? AND used_by IS NULL').run(id);
  return result.changes > 0;
}

// --- Refresh Tokens ---

export function storeRefreshToken(userId: number, token: string, expiresAt: string): void {
  const tokenHash = hashToken(token);
  getDb().prepare(`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, tokenHash, expiresAt);
}

export function getRefreshTokenByHash(tokenHash: string): { id: number; user_id: number; expires_at: string } | undefined {
  return getDb().prepare(
    'SELECT id, user_id, expires_at FROM refresh_tokens WHERE token_hash = ?'
  ).get(tokenHash) as { id: number; user_id: number; expires_at: string } | undefined;
}

export function deleteRefreshToken(id: number): void {
  getDb().prepare('DELETE FROM refresh_tokens WHERE id = ?').run(id);
}

export function deleteAllRefreshTokensForUser(userId: number): void {
  getDb().prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
}

export function deleteExpiredRefreshTokens(): void {
  getDb().prepare("DELETE FROM refresh_tokens WHERE expires_at <= datetime('now')").run();
}

// --- Orphan Assignment (first-run migration) ---

export function assignOrphanedTrackersToUser(userId: number): number {
  const result = getDb().prepare('UPDATE trackers SET user_id = ? WHERE user_id IS NULL').run(userId);
  return result.changes;
}

export function assignOrphanedSettingsToUser(userId: number): number {
  const result = getDb().prepare('UPDATE settings SET user_id = ? WHERE user_id IS NULL').run(userId);
  return result.changes;
}
```

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add server/src/db/user-queries.ts
git commit -m "feat: add user, invite code, and refresh token queries"
```

---

## Task 7: Auth Middleware

**Files:**
- Create: `server/src/auth/middleware.ts`

- [ ] **Step 1: Create middleware.ts**

```typescript
// server/src/auth/middleware.ts
import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type TokenPayload } from './tokens.js';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
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

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
```

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add server/src/auth/middleware.ts
git commit -m "feat: add auth and admin middleware"
```

---

## Task 8: Auth Routes

**Files:**
- Create: `server/src/routes/auth.ts`

- [ ] **Step 1: Create auth.ts**

```typescript
// server/src/routes/auth.ts
import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  signAccessToken, generateRefreshToken, hashToken,
  setAuthCookies, clearAuthCookies,
} from '../auth/tokens.js';
import { authMiddleware } from '../auth/middleware.js';
import {
  getUserByEmail, getUserById, createUser, getUserCount,
  getInviteByCode, markInviteUsed,
  storeRefreshToken, getRefreshTokenByHash,
  deleteRefreshToken, deleteAllRefreshTokensForUser,
  assignOrphanedTrackersToUser, assignOrphanedSettingsToUser,
  getSafeUserById,
} from '../db/user-queries.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  display_name: z.string().min(1).max(100),
  invite_code: z.string().optional(),
  setup_token: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// In-memory setup token (generated on first run, cleared after use)
let setupToken: string | null = null;

export function getSetupToken(): string | null {
  return setupToken;
}

export function generateSetupToken(): string {
  setupToken = randomBytes(32).toString('hex');
  return setupToken;
}

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { email, password, display_name, invite_code, setup_token: reqSetupToken } = parsed.data;

  // Check if this is first-run setup
  const userCount = getUserCount();
  const isFirstUser = userCount === 0;

  if (isFirstUser) {
    // First user: requires valid setup token
    if (!reqSetupToken || reqSetupToken !== setupToken) {
      res.status(403).json({ error: 'Invalid setup token' });
      return;
    }
  } else {
    // Subsequent users: require valid invite code
    if (!invite_code) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const invite = getInviteByCode(invite_code);
    if (!invite) {
      res.status(400).json({ error: 'Invalid invite code' });
      return;
    }
    if (invite.used_by) {
      res.status(400).json({ error: 'Invite code has already been used' });
      return;
    }
    if (invite.expires_at && new Date(invite.expires_at + 'Z') < new Date()) {
      res.status(400).json({ error: 'Invite code has expired' });
      return;
    }
  }

  // Check email uniqueness
  if (getUserByEmail(email)) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = createUser({
    email,
    password_hash: passwordHash,
    display_name,
    role: isFirstUser ? 'admin' : 'user',
  });

  // Mark invite as used (if not first user)
  if (!isFirstUser && invite_code) {
    markInviteUsed(invite_code, user.id);
  }

  // Assign orphaned data to first user
  if (isFirstUser) {
    const trackers = assignOrphanedTrackersToUser(user.id);
    const settings = assignOrphanedSettingsToUser(user.id);
    logger.info({ userId: user.id, trackers, settings }, 'Assigned orphaned data to admin user');
    setupToken = null; // Invalidate setup token
  }

  // Issue tokens
  const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.jwtRefreshExpiryDays * 24 * 60 * 60 * 1000).toISOString();
  storeRefreshToken(user.id, refreshToken, expiresAt);

  setAuthCookies(res, accessToken, refreshToken);
  res.status(201).json({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid credentials' });
    return;
  }

  const { email, password } = parsed.data;
  const user = getUserByEmail(email);

  if (!user || !await verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  if (!user.is_active) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.jwtRefreshExpiryDays * 24 * 60 * 60 * 1000).toISOString();
  storeRefreshToken(user.id, refreshToken, expiresAt);

  setAuthCookies(res, accessToken, refreshToken);
  res.json({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  });
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refresh_token;
  if (refreshToken) {
    const tokenHash = hashToken(refreshToken);
    const stored = getRefreshTokenByHash(tokenHash);
    if (stored) {
      deleteRefreshToken(stored.id);
    }
  }
  clearAuthCookies(res);
  res.json({ success: true });
});

// POST /api/auth/refresh
router.post('/refresh', (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    res.status(401).json({ error: 'No refresh token' });
    return;
  }

  const tokenHash = hashToken(refreshToken);
  const stored = getRefreshTokenByHash(tokenHash);

  if (!stored) {
    // Possible token reuse: try to find which user this token belonged to
    // by checking if the token was recently rotated. If we can identify the user,
    // revoke ALL their tokens as a security measure.
    // Since we can't look up deleted tokens by hash, we simply clear cookies.
    // For stronger reuse detection, we would keep a "used_tokens" table.
    clearAuthCookies(res);
    res.status(401).json({ error: 'Invalid refresh token' });
    return;
  }

  // Check expiry
  if (new Date(stored.expires_at + 'Z') < new Date()) {
    deleteRefreshToken(stored.id);
    clearAuthCookies(res);
    res.status(401).json({ error: 'Refresh token expired' });
    return;
  }

  // Check user is still active
  const user = getUserById(stored.user_id);
  if (!user || !user.is_active) {
    deleteAllRefreshTokensForUser(stored.user_id);
    clearAuthCookies(res);
    res.status(401).json({ error: 'Account deactivated' });
    return;
  }

  // Rotate: delete old, issue new
  deleteRefreshToken(stored.id);
  const newAccessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });
  const newRefreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.jwtRefreshExpiryDays * 24 * 60 * 60 * 1000).toISOString();
  storeRefreshToken(user.id, newRefreshToken, expiresAt);

  setAuthCookies(res, newAccessToken, newRefreshToken);
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  const user = getSafeUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

// GET /api/auth/setup-status
// Public endpoint: tells the frontend if first-run setup is needed
router.get('/setup-status', (_req: Request, res: Response) => {
  const userCount = getUserCount();
  res.json({ needsSetup: userCount === 0, hasSetupToken: setupToken !== null });
});

export default router;
```

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add server/src/routes/auth.ts
git commit -m "feat: add auth routes (register, login, logout, refresh, me)"
```

---

## Task 9: Admin Routes

**Files:**
- Create: `server/src/routes/admin.ts`

- [ ] **Step 1: Create admin.ts**

```typescript
// server/src/routes/admin.ts
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getAllUsers, getSafeUserById, updateUser, deleteUser,
  getActiveAdminCount, resetUserPassword,
  createInviteCode, getAllInviteCodes, deleteInviteCode,
  deleteAllRefreshTokensForUser,
} from '../db/user-queries.js';
import { hashPassword } from '../auth/passwords.js';

const router = Router();

// --- Users ---

// GET /api/admin/users
router.get('/users', (_req: Request, res: Response) => {
  res.json(getAllUsers());
});

// PATCH /api/admin/users/:id
const updateUserSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  is_active: z.number().min(0).max(1).optional(),
});

router.patch('/users/:id', (req: Request, res: Response) => {
  const userId = Number(req.params.id);
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const existing = getSafeUserById(userId);
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Guard: cannot remove last active admin
  if (existing.role === 'admin' && existing.is_active === 1) {
    const wouldLoseAdmin =
      (parsed.data.role && parsed.data.role !== 'admin') ||
      (parsed.data.is_active === 0);

    if (wouldLoseAdmin && getActiveAdminCount() <= 1) {
      res.status(400).json({ error: 'Cannot remove the last active admin' });
      return;
    }
  }

  const updated = updateUser(userId, parsed.data);

  // If deactivated, revoke all their refresh tokens
  if (parsed.data.is_active === 0) {
    deleteAllRefreshTokensForUser(userId);
  }

  res.json(updated);
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req: Request, res: Response) => {
  const userId = Number(req.params.id);

  // Cannot delete yourself
  if (userId === req.user!.userId) {
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }

  const existing = getSafeUserById(userId);
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Guard: cannot delete last active admin
  if (existing.role === 'admin' && existing.is_active === 1 && getActiveAdminCount() <= 1) {
    res.status(400).json({ error: 'Cannot delete the last active admin' });
    return;
  }

  deleteUser(userId);
  res.status(204).send();
});

// POST /api/admin/users/:id/reset-password
const resetPasswordSchema = z.object({
  new_password: z.string().min(8),
});

router.post('/users/:id/reset-password', async (req: Request, res: Response) => {
  const userId = Number(req.params.id);
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const existing = getSafeUserById(userId);
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.new_password);
  resetUserPassword(userId, passwordHash);

  // Revoke all refresh tokens (force re-login)
  deleteAllRefreshTokensForUser(userId);

  res.json({ success: true });
});

// --- Invites ---

// POST /api/admin/invites
const createInviteSchema = z.object({
  expires_at: z.string().optional(),
});

router.post('/invites', (req: Request, res: Response) => {
  const parsed = createInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const invite = createInviteCode(req.user!.userId, parsed.data.expires_at);
  res.status(201).json(invite);
});

// GET /api/admin/invites
router.get('/invites', (_req: Request, res: Response) => {
  res.json(getAllInviteCodes());
});

// DELETE /api/admin/invites/:id
router.delete('/invites/:id', (req: Request, res: Response) => {
  const deleted = deleteInviteCode(Number(req.params.id));
  if (!deleted) {
    res.status(404).json({ error: 'Invite not found or already used' });
    return;
  }
  res.status(204).send();
});

export default router;
```

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add server/src/routes/admin.ts
git commit -m "feat: add admin routes for user and invite management"
```

---

## Task 10: Update Existing Queries for User Isolation

**Files:**
- Modify: `server/src/db/queries.ts`

- [ ] **Step 1: Add user_id to Tracker interface**

```typescript
export interface Tracker {
  // ... existing fields ...
  user_id: number | null;
}
```

- [ ] **Step 2: Update all tracker queries to accept userId**

Add `userId` parameter to these functions in `queries.ts`:

- `getAllTrackers(userId: number)` -- add `WHERE user_id = ?`
- `getTrackerById(id: number, userId?: number)` -- add `AND user_id = ?` when userId provided
- `createTracker(data)` -- add `user_id` to INSERT
- `updateTracker(id, data, userId?)` -- add `AND user_id = ?` to WHERE when userId provided
- `deleteTracker(id, userId)` -- add `AND user_id = ?` to WHERE
- `getRecentPricesForAllTrackers(userId, limit)` -- filter by user's trackers

```typescript
export function getAllTrackers(userId: number): Tracker[] {
  return getDb().prepare('SELECT * FROM trackers WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Tracker[];
}

export function getTrackerById(id: number, userId?: number): Tracker | undefined {
  if (userId !== undefined) {
    return getDb().prepare('SELECT * FROM trackers WHERE id = ? AND user_id = ?').get(id, userId) as Tracker | undefined;
  }
  return getDb().prepare('SELECT * FROM trackers WHERE id = ?').get(id) as Tracker | undefined;
}

export function createTracker(data: {
  name: string;
  url: string;
  threshold_price?: number | null;
  check_interval_minutes?: number;
  css_selector?: string | null;
  user_id: number;
}): Tracker {
  const stmt = getDb().prepare(`
    INSERT INTO trackers (name, url, threshold_price, check_interval_minutes, css_selector, user_id)
    VALUES (@name, @url, @threshold_price, @check_interval_minutes, @css_selector, @user_id)
  `);
  const result = stmt.run({
    name: data.name,
    url: data.url,
    threshold_price: data.threshold_price ?? null,
    check_interval_minutes: data.check_interval_minutes ?? 360,
    css_selector: data.css_selector ?? null,
    user_id: data.user_id,
  });
  return getTrackerById(Number(result.lastInsertRowid), data.user_id)!;
}

export function updateTracker(id: number, data: Partial<{
  name: string;
  url: string;
  threshold_price: number | null;
  check_interval_minutes: number;
  css_selector: string | null;
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  status: string;
}>, userId?: number): Tracker | undefined {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }

  if (fields.length === 0) return getTrackerById(id, userId);

  fields.push("updated_at = datetime('now')");

  let where = 'WHERE id = @id';
  if (userId !== undefined) {
    where += ' AND user_id = @userId';
    values.userId = userId;
  }

  getDb().prepare(`UPDATE trackers SET ${fields.join(', ')} ${where}`).run(values);
  return getTrackerById(id, userId);
}

export function deleteTracker(id: number, userId: number): boolean {
  const result = getDb().prepare('DELETE FROM trackers WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

export function getRecentPricesForAllTrackers(userId: number, limit: number = 10): Record<number, number[]> {
  const rows = getDb().prepare(`
    SELECT ph.tracker_id, ph.price FROM (
      SELECT tracker_id, price, ROW_NUMBER() OVER (PARTITION BY tracker_id ORDER BY scraped_at DESC) as rn
      FROM price_history
      WHERE tracker_id IN (SELECT id FROM trackers WHERE user_id = ?)
    ) ph WHERE ph.rn <= ?
    ORDER BY ph.tracker_id, ph.rn DESC
  `).all(userId, limit) as { tracker_id: number; price: number }[];

  const result: Record<number, number[]> = {};
  for (const row of rows) {
    if (!result[row.tracker_id]) result[row.tracker_id] = [];
    result[row.tracker_id].push(row.price);
  }
  return result;
}
```

- [ ] **Step 3: Update settings queries for per-user isolation**

```typescript
export function getSetting(key: string, userId?: number | null): string | undefined {
  if (userId !== undefined && userId !== null) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ? AND user_id = ?').get(key, userId) as { value: string } | undefined;
    return row?.value;
  }
  // NOTE: NULL user_id rows are legacy system settings — query with IS NULL
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ? AND user_id IS NULL').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string, userId?: number | null): void {
  if (userId !== undefined && userId !== null) {
    // Per-user settings: UPSERT works because user_id is non-NULL
    getDb().prepare(`
      INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
    `).run(userId, key, value);
  } else {
    // System settings with NULL user_id: SQLite treats NULLs as distinct in
    // composite PKs, so ON CONFLICT won't trigger. Use DELETE + INSERT instead.
    const db = getDb();
    db.prepare('DELETE FROM settings WHERE key = ? AND user_id IS NULL').run(key);
    db.prepare('INSERT INTO settings (user_id, key, value) VALUES (NULL, ?, ?)').run(key, value);
  }
}

export function getAllSettings(userId: number): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId) as { key: string; value: string }[];
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
```

- [ ] **Step 4: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

Expected: Will have errors in routes that still use old signatures -- fixed in Task 11.

- [ ] **Step 5: Commit**

```bash
cd /root/price-tracker && git add server/src/db/queries.ts
git commit -m "feat: add user isolation to all tracker and settings queries"
```

---

## Task 11: Update Existing Routes for User Isolation

**Files:**
- Modify: `server/src/routes/trackers.ts`
- Modify: `server/src/routes/prices.ts`
- Modify: `server/src/routes/settings.ts`

- [ ] **Step 1: Update trackers.ts**

Every route handler extracts `req.user!.userId` and passes it to queries:

```typescript
// GET / - list trackers
router.get('/', (req: Request, res: Response) => {
  const trackers = getAllTrackers(req.user!.userId);
  res.json(trackers);
});

// GET /sparklines
router.get('/sparklines', (req: Request, res: Response) => {
  const data = getRecentPricesForAllTrackers(req.user!.userId, 10);
  res.json(data);
});

// POST / - create tracker
router.post('/', (req: Request, res: Response) => {
  // ... validation ...
  const tracker = createTracker({ ...parsed.data, user_id: req.user!.userId });
  res.status(201).json(tracker);
});

// GET /:id
router.get('/:id', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  // ...
});

// PUT /:id
router.put('/:id', (req: Request, res: Response) => {
  // ...
  const tracker = updateTracker(Number(req.params.id), parsed.data, req.user!.userId);
  // ...
});

// DELETE /:id
router.delete('/:id', (req: Request, res: Response) => {
  const deleted = deleteTracker(Number(req.params.id), req.user!.userId);
  // ...
});

// POST /:id/check
router.post('/:id/check', async (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  // ...
});
```

- [ ] **Step 2: Update prices.ts**

Replace the import line to add `getTrackerById` and remove the unused `getRecentPricesForAllTrackers`:

```typescript
import { getPriceHistory, getTrackerById } from '../db/queries.js';

router.get('/:id/prices', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  const range = req.query.range as string | undefined;
  const prices = getPriceHistory(tracker.id, range);
  res.json(prices);
});
```

- [ ] **Step 3: Update settings.ts**

Update all three endpoints (GET, PUT, and test-webhook) to use per-user context:

```typescript
// GET / - per-user settings
router.get('/', (req: Request, res: Response) => {
  const settings = getAllSettings(req.user!.userId);
  res.json(settings);
});

// PUT / - per-user settings
router.put('/', (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(body)) {
    if (typeof key === 'string' && typeof value === 'string') {
      setSetting(key, value, req.user!.userId);
    }
  }
  const settings = getAllSettings(req.user!.userId);
  res.json(settings);
});

// POST /test-webhook - no changes needed (already takes URL from body, not DB)
// Auth middleware is applied at the router level in index.ts
```

- [ ] **Step 4: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
cd /root/price-tracker && git add server/src/routes/trackers.ts server/src/routes/prices.ts server/src/routes/settings.ts
git commit -m "feat: enforce user isolation in all API routes"
```

---

## Task 12: Update Scheduler & Notifications for Per-User Webhooks

**Files:**
- Modify: `server/src/notifications/discord.ts`
- Modify: `server/src/scheduler/cron.ts`

- [ ] **Step 1: Update discord.ts to accept webhookUrl parameter**

Change `sendPriceAlert` and `sendErrorAlert` to accept `webhookUrl` as a parameter instead of looking it up globally. Remove the `getWebhookUrl()` function.

```typescript
export async function sendPriceAlert(tracker: Tracker, currentPrice: number, webhookUrl: string | null): Promise<boolean> {
  if (!webhookUrl) {
    logger.debug({ trackerId: tracker.id }, 'No webhook URL configured for user, skipping notification');
    return false;
  }
  // ... rest stays the same, just use the passed-in webhookUrl instead of calling getWebhookUrl() ...
}

export async function sendErrorAlert(tracker: Tracker, error: string, webhookUrl: string | null): Promise<void> {
  if (!webhookUrl) return;
  // ... rest stays the same ...
}
```

Remove unused imports (`getSetting`, `config` if no longer needed).

- [ ] **Step 2: Update cron.ts to resolve per-user webhook**

In `checkTracker()`, after getting the tracker, look up the user's webhook URL:

```typescript
// Add import:
import { getSetting } from '../db/queries.js';

// In checkTracker(), after fetching the tracker:
  const webhookUrl = tracker.user_id
    ? getSetting('discord_webhook_url', tracker.user_id) || null
    : null;

  // Pass webhookUrl to notification calls:
  // await sendPriceAlert(tracker, result.price, webhookUrl);
  // await sendErrorAlert(tracker, errorMsg, webhookUrl);
```

Wrap the function body in try/catch for FK constraint errors (user deleted mid-scrape):

```typescript
try {
  // ... existing logic ...
} catch (err) {
  const errorMsg = err instanceof Error ? err.message : String(err);
  if (errorMsg.includes('FOREIGN KEY constraint failed')) {
    logger.warn({ trackerId }, 'Tracker was deleted during scrape, skipping');
    return;
  }
  throw err;
}
```

- [ ] **Step 3: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /root/price-tracker && git add server/src/notifications/discord.ts server/src/scheduler/cron.ts
git commit -m "feat: per-user webhook resolution in scheduler and notifications"
```

---

## Task 13: Wire Everything Into index.ts

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Update index.ts**

Add imports and wire auth into the Express app:

```typescript
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { authMiddleware, adminMiddleware } from './auth/middleware.js';
import authRoutes, { generateSetupToken } from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import { getUserCount, deleteExpiredRefreshTokens } from './db/user-queries.js';
```

After `initializeSchema()`, add first-run setup check:

```typescript
const userCount = getUserCount();
if (userCount === 0) {
  const token = generateSetupToken();
  const baseUrl = config.isProduction
    ? 'https://prices.schultzsolutions.tech'
    : `http://localhost:${config.port}`;
  logger.info('==========================================================');
  logger.info('FIRST-RUN SETUP: No users found. Create your admin account:');
  logger.info(`${baseUrl}/setup?token=${token}`);
  logger.info('==========================================================');
}
```

Replace `app.use(cors())` with credentialed CORS:

```typescript
app.use(cors({
  origin: config.isProduction ? 'https://prices.schultzsolutions.tech' : true,
  credentials: true,
}));
```

Add cookie parser before routes:

```typescript
app.use(cookieParser());
```

Add rate limiting on auth endpoints:

```typescript
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
```

Register routes with middleware:

```typescript
app.use('/api/auth', authRoutes);
app.use('/api/trackers', authMiddleware, trackerRoutes);
app.use('/api/trackers', authMiddleware, priceRoutes);
app.use('/api/settings', authMiddleware, settingsRoutes);
app.use('/api/admin', authMiddleware, adminMiddleware, adminRoutes);
```

Add periodic cleanup:

```typescript
setInterval(() => { deleteExpiredRefreshTokens(); }, 60 * 60 * 1000);
```

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/server && npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add server/src/index.ts
git commit -m "feat: wire auth middleware, rate limiting, and admin routes into server"
```

---

## Task 14: Frontend Types & API Layer

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`

- [ ] **Step 1: Add auth types to types.ts**

```typescript
export interface User {
  id: number;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface InviteCode {
  id: number;
  code: string;
  created_by: number;
  used_by: number | null;
  expires_at: string | null;
  created_at: string;
}

export interface SetupStatus {
  needsSetup: boolean;
  hasSetupToken: boolean;
}
```

- [ ] **Step 2: Update api.ts with credentials, 401 interceptor, and auth calls**

Update the `request` function to add `credentials: 'include'` and 401 refresh retry logic (only for non-auth endpoints). Add `authRequest` helper for auth endpoints (no retry). Add all auth and admin API functions.

See full code in the plan -- key points:
- `request()` adds `credentials: 'include'`, retries on 401 via refresh, redirects to `/login` on failure
- `authRequest()` for auth endpoints -- no retry logic to avoid infinite loops
- New exports: `login`, `register`, `logout`, `getMe`, `getSetupStatus`, `getUsers`, `updateUser`, `deleteUser`, `resetUserPassword`, `createInvite`, `getInvites`, `deleteInvite`

- [ ] **Step 3: Verify build**

```bash
cd /root/price-tracker/client && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
cd /root/price-tracker && git add client/src/types.ts client/src/api.ts
git commit -m "feat: add auth types and API layer with 401 refresh interceptor"
```

---

## Task 15: Auth Context

**Files:**
- Create: `client/src/context/AuthContext.tsx`

- [ ] **Step 1: Create AuthContext.tsx**

React context that holds user state, checks `/api/auth/me` on mount, and provides `login`/`logout`/`setUser` functions. Also checks `/api/auth/setup-status` to detect first-run.

- [ ] **Step 2: Verify build**

```bash
cd /root/price-tracker/client && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
cd /root/price-tracker && git add client/src/context/AuthContext.tsx
git commit -m "feat: add AuthContext for frontend auth state management"
```

---

## Task 16: Protected Route Components

**Files:**
- Create: `client/src/components/ProtectedRoute.tsx`
- Create: `client/src/components/AdminRoute.tsx`

- [ ] **Step 1: Create ProtectedRoute.tsx**

Redirects to `/setup` if `needsSetup`, to `/login` if no user, otherwise renders children.

- [ ] **Step 2: Create AdminRoute.tsx**

Redirects to `/` if user is not admin, otherwise renders children.

- [ ] **Step 3: Verify build and commit**

```bash
cd /root/price-tracker && git add client/src/components/ProtectedRoute.tsx client/src/components/AdminRoute.tsx
git commit -m "feat: add ProtectedRoute and AdminRoute wrappers"
```

---

## Task 17: Login Page

**Files:**
- Create: `client/src/pages/Login.tsx`

- [ ] **Step 1: Create Login.tsx**

Email + password form, calls `useAuth().login()`, navigates to `/` on success. Matches existing dark design theme.

- [ ] **Step 2: Verify build and commit**

```bash
cd /root/price-tracker && git add client/src/pages/Login.tsx
git commit -m "feat: add login page"
```

---

## Task 18: Register Page

**Files:**
- Create: `client/src/pages/Register.tsx`

- [ ] **Step 1: Create Register.tsx**

Reads `?code=` from URL params. If no code, shows "Invite Required" message. Otherwise shows registration form (display name, email, password). Calls `register()` API.

- [ ] **Step 2: Verify build and commit**

```bash
cd /root/price-tracker && git add client/src/pages/Register.tsx
git commit -m "feat: add registration page with invite code support"
```

---

## Task 19: Setup Page (First-Run)

**Files:**
- Create: `client/src/pages/Setup.tsx`

- [ ] **Step 1: Create Setup.tsx**

Reads `?token=` from URL params. Shows admin account creation form. Calls `register()` with `setup_token`.

- [ ] **Step 2: Verify build and commit**

```bash
cd /root/price-tracker && git add client/src/pages/Setup.tsx
git commit -m "feat: add first-run setup page for admin account creation"
```

---

## Task 20: Admin Page

**Files:**
- Create: `client/src/pages/Admin.tsx`

- [ ] **Step 1: Create Admin.tsx**

Two tabs: Users and Invites. Users tab shows table with name, email, role, status, and action buttons (toggle role, toggle active, delete). Invites tab has "Generate Invite" button and table of codes with copy-link and revoke actions.

- [ ] **Step 2: Verify build and commit**

```bash
cd /root/price-tracker && git add client/src/pages/Admin.tsx
git commit -m "feat: add admin page with user and invite management"
```

---

## Task 21: Update App.tsx & main.tsx

**Files:**
- Modify: `client/src/main.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Wrap app with AuthProvider in main.tsx**

Add `AuthProvider` inside `BrowserRouter`.

- [ ] **Step 2: Update App.tsx**

- Add public routes (`/login`, `/register`, `/setup`) that render without nav
- Wrap existing routes with `ProtectedRoute`
- Wrap `/admin` with `AdminRoute`
- Add user display name + logout button to nav
- Add Admin link for admin users

- [ ] **Step 3: Verify build**

```bash
cd /root/price-tracker/client && npx tsc --noEmit && npm run build
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
cd /root/price-tracker && git add client/src/main.tsx client/src/App.tsx
git commit -m "feat: wire auth into app shell with protected routes and nav"
```

---

## Task 22: End-to-End Verification

**Files:** None (testing only)

- [ ] **Step 1: Build server and client**

```bash
cd /root/price-tracker/server && npm run build
cd /root/price-tracker/client && npm run build
```

Expected: No errors.

- [ ] **Step 2: Start server and verify setup URL appears in logs**

- [ ] **Step 3: Test setup-status endpoint returns needsSetup: true**

- [ ] **Step 4: Test registration with setup token**

- [ ] **Step 5: Test login**

- [ ] **Step 6: Test authenticated endpoints return data**

- [ ] **Step 7: Test unauthenticated access returns 401**

- [ ] **Step 8: Stop test server**

- [ ] **Step 9: Final commit (if any unstaged files remain)**

```bash
cd /root/price-tracker && git status
# Stage only relevant files by name (no git add -A)
git commit -m "feat: complete user accounts and authentication system"
```

---

## Task 23: Deploy

- [ ] **Step 1: Add JWT_SECRET to CT 302 .env**

```bash
ssh root@192.168.1.166 "cd /opt/price-tracker && echo JWT_SECRET=$(openssl rand -hex 32) >> .env && echo NODE_ENV=production >> .env"
```

- [ ] **Step 2: Deploy**

```bash
cd /root/price-tracker && bash scripts/deploy.sh
```

- [ ] **Step 3: Check server logs for setup URL**

```bash
ssh root@192.168.1.166 "journalctl -u price-tracker -n 20 --no-pager"
```

- [ ] **Step 4: Visit setup URL and create admin account**

- [ ] **Step 5: Remove Cloudflare Zero Trust policy for prices.schultzsolutions.tech**

- [ ] **Step 6: Verify login page appears and existing trackers are present**
