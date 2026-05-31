# Autonomous Purchasing (Buy-on-Trigger) v1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tracker be "armed for purchase" so that when it crosses its price threshold the system creates a one-time, owner-approved buy intent, notifies the owner with a one-tap link, hands them into Amazon's native checkout, and — on confirmation — records the buy through the existing purchase-log ledger.

**Architecture:** A new `purchase_intents` table holds the armed→approved→resolved state machine (the audit log). Arming hooks into `firePriceAlerts` (cron) *after* the existing plausibility guard, branching eligible armed trackers to a purchase-arm notification + intent instead of the normal price alert. An auth-gated `/buy/:token` page approves the intent (returns an Amazon add-to-cart URL built from the existing `extractAmazonAsin`) and closes the loop, calling the existing `createPurchase()` on confirmation.

**Tech Stack:** TypeScript, Express, better-sqlite3, Zod, React + Vite + react-router, Vitest. Spec: `docs/superpowers/specs/2026-05-31-autonomous-purchasing-design.md`.

**Branch:** `feature/autonomous-purchasing` (already created).

**Test commands:** server — `cd server && npm test` (single file: `npx vitest run src/<path>.test.ts`); client — `cd client && npm test`.

---

## File Structure

**Create:**
- `server/src/lib/buy-arm.ts` — `buildAmazonCartUrl(asin, quantity)`; pure, reuses `affiliate.ts`.
- `server/src/db/purchase-intents.ts` — all `purchase_intents` queries + the state machine. Focused module (keeps `queries.ts` from growing further).
- `server/src/notifications/purchase-arm.ts` — `firePurchaseArm()` dispatcher + `purchaseArmContent()` shared text builder.
- `server/src/routes/buy.ts` — `/api/buy/*` router (auth-gated).
- `client/src/pages/Buy.tsx` — the Buy Confirmation page.

**Modify:**
- `server/src/config.ts` — add `armExpiryHours`, `reArmCooldownHours`.
- `server/src/db/migrations.ts` — append migration v19.
- `server/src/db/schema.ts` — fresh-install columns + table (kept in sync per the v17/v18 convention).
- `server/src/db/queries.ts` — extend `Tracker` type + `updateTracker` allow-list with `buy_armed`, `buy_quantity`.
- `server/src/notifications/{discord,ntfy,web-push}.ts` — add `sendXPurchaseArm` builders.
- `server/src/scheduler/cron.ts` — inject the arm branch at the top of `firePriceAlerts`; add `firePurchaseArm` import.
- `server/src/routes/trackers.ts` — extend `updateSchema` with `buy_armed`, `buy_quantity`.
- `server/src/index.ts` — register `buyRouter` at `/api/buy`.
- `client/src/api.ts` — `setTrackerArm`, `getBuyIntent`, `approveBuyIntent`, `resolveBuyIntent`.
- `client/src/types.ts` (or wherever `Tracker` is typed) — add `buy_armed`, `buy_quantity`.
- `client/src/App.tsx` — register `/buy/:token` ProtectedRoute.
- `client/src/pages/TrackerDetail.tsx` — "Arm for purchase" toggle + quantity.

**v1 notification scope:** Discord, ntfy, and web push (the interactive/mobile surfaces where "tap to approve" makes sense). Email/generic-webhook purchase-arm builders are a noted fast-follow — they add no new logic, just two more transport wrappers.

---

## Task 1: Config values

**Files:**
- Modify: `server/src/config.ts`

- [ ] **Step 1: Add config fields**

In the `config` object (after `amazonAffiliateTag`), add:

```typescript
  // Buy-on-trigger (autonomous purchasing v1). armExpiryHours: how long an
  // armed/approved intent stays actionable before the expiry sweep retires
  // it. reArmCooldownHours: after an intent expires or is marked
  // not-completed, suppress re-arming the same tracker for this long so a
  // deal sitting below threshold doesn't nag every cron tick.
  armExpiryHours: parseInt(process.env.ARM_EXPIRY_HOURS || '24', 10),
  reArmCooldownHours: parseInt(process.env.RE_ARM_COOLDOWN_HOURS || '24', 10),
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/src/config.ts
git commit -m "feat(config): add armExpiryHours + reArmCooldownHours for buy-on-trigger"
```

---

## Task 2: Migration v19 — columns + purchase_intents table

**Files:**
- Modify: `server/src/db/migrations.ts` (append to the migrations array)
- Modify: `server/src/db/schema.ts` (fresh-install parity)
- Test: `server/src/db/migration-v19.test.ts`

- [ ] **Step 1: Write the failing migration test**

Create `server/src/db/migration-v19.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
});

function seedTracker(): number {
  const db = getDb();
  db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
  ).run();
  return Number(db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes)
     VALUES ('T', 'https://amazon.com/dp/B000000000', 1, 100, 60, 0)`,
  ).run().lastInsertRowid);
}

describe('migration v19 — buy-arm columns + purchase_intents', () => {
  it('adds buy_armed and buy_quantity with safe defaults', () => {
    initializeSchema();
    const tId = seedTracker();
    const row = getDb().prepare(
      'SELECT buy_armed, buy_quantity FROM trackers WHERE id = ?',
    ).get(tId) as { buy_armed: number; buy_quantity: number };
    expect(row).toEqual({ buy_armed: 0, buy_quantity: 1 });
  });

  it('creates purchase_intents and accepts a valid armed row', () => {
    initializeSchema();
    const tId = seedTracker();
    expect(() => {
      getDb().prepare(
        `INSERT INTO purchase_intents
           (tracker_id, asin, price_at_arm, threshold_at_arm, quantity, token, status, expires_at)
         VALUES (?, 'B000000000', 79.99, 100, 1, 'tok123', 'armed', '2026-06-01 00:00:00')`,
      ).run(tId);
    }).not.toThrow();
    const intent = getDb().prepare(
      `SELECT status, asin FROM purchase_intents WHERE tracker_id = ?`,
    ).get(tId) as { status: string; asin: string };
    expect(intent).toEqual({ status: 'armed', asin: 'B000000000' });
  });

  it('rejects an unknown intent status via the CHECK', () => {
    initializeSchema();
    const tId = seedTracker();
    expect(() => {
      getDb().prepare(
        `INSERT INTO purchase_intents
           (tracker_id, asin, price_at_arm, threshold_at_arm, quantity, token, status, expires_at)
         VALUES (?, 'B000000000', 79.99, 100, 1, 'tok456', 'bogus', '2026-06-01 00:00:00')`,
      ).run(tId);
    }).toThrow();
  });

  it('enforces a unique token', () => {
    initializeSchema();
    const tId = seedTracker();
    const ins = (tok: string) => getDb().prepare(
      `INSERT INTO purchase_intents
         (tracker_id, asin, price_at_arm, threshold_at_arm, quantity, token, status, expires_at)
       VALUES (?, 'B000000000', 79.99, 100, 1, ?, 'armed', '2026-06-01 00:00:00')`,
    ).run(tId, tok);
    ins('dup');
    expect(() => ins('dup')).toThrow();
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/db/migration-v19.test.ts`
Expected: FAIL — `purchase_intents` doesn't exist / no `buy_armed` column.

- [ ] **Step 3: Append migration v19 to `migrations.ts`**

Add as the last element of the migrations array (after v18):

```typescript
  {
    version: 19,
    description: "Add buy_armed/buy_quantity to trackers + purchase_intents table",
    up: () => {
      const db = getDb();
      const run = (sql: string): void => { db.prepare(sql).run(); };

      // Idempotent ADD COLUMN — migrations run on fresh installs too (where
      // schema.ts already defines these), so guard on table_info.
      const cols = (db.pragma('table_info(trackers)') as { name: string }[]).map(c => c.name);
      if (!cols.includes('buy_armed')) {
        run(`ALTER TABLE trackers ADD COLUMN buy_armed INTEGER NOT NULL DEFAULT 0 CHECK(buy_armed IN (0,1))`);
      }
      if (!cols.includes('buy_quantity')) {
        run(`ALTER TABLE trackers ADD COLUMN buy_quantity INTEGER NOT NULL DEFAULT 1 CHECK(buy_quantity >= 1)`);
      }

      run(`CREATE TABLE IF NOT EXISTS purchase_intents (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        tracker_id       INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        tracker_url_id   INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
        asin             TEXT NOT NULL,
        price_at_arm     REAL NOT NULL CHECK(price_at_arm >= 0),
        threshold_at_arm REAL NOT NULL,
        quantity         INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
        token            TEXT NOT NULL UNIQUE,
        status           TEXT NOT NULL DEFAULT 'armed'
                           CHECK(status IN ('armed','approved','purchased','not_completed','expired','canceled')),
        purchase_id      INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        approved_at      TEXT,
        resolved_at      TEXT,
        expires_at       TEXT NOT NULL
      )`);
      run(`CREATE INDEX IF NOT EXISTS idx_purchase_intents_tracker_id ON purchase_intents(tracker_id)`);
      run(`CREATE INDEX IF NOT EXISTS idx_purchase_intents_status ON purchase_intents(status)`);
    },
  },
```

- [ ] **Step 4: Add the same shapes to `schema.ts` (fresh-install parity)**

In `schema.ts`, find the `CREATE TABLE ... trackers` definition and add the two columns (mirror the CHECK/defaults above). Then, after the `purchases` table definition, add the full `CREATE TABLE IF NOT EXISTS purchase_intents (...)` block + the two indexes (identical SQL to Step 3). Match the surrounding style in the file.

- [ ] **Step 5: Run the test to confirm it passes**

Run: `cd server && npx vitest run src/db/migration-v19.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Run the full server suite (no regressions in other migration tests)**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/migrations.ts server/src/db/schema.ts server/src/db/migration-v19.test.ts
git commit -m "feat(db): migration v19 — buy-arm columns + purchase_intents table"
```

---

## Task 3: `buildAmazonCartUrl` helper

**Files:**
- Create: `server/src/lib/buy-arm.ts`
- Test: `server/src/lib/buy-arm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/lib/buy-arm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildAmazonCartUrl } from './buy-arm.js';

describe('buildAmazonCartUrl', () => {
  it('builds an add-to-cart URL with ASIN and quantity', () => {
    const url = buildAmazonCartUrl('B07XYZ1234', 1, '');
    expect(url).toBe(
      'https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B07XYZ1234&Quantity.1=1',
    );
  });

  it('appends the affiliate tag when configured', () => {
    const url = buildAmazonCartUrl('B07XYZ1234', 2, 'schultzsoluti-20');
    expect(url).toBe(
      'https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B07XYZ1234&Quantity.1=2&AssociateTag=schultzsoluti-20',
    );
  });

  it('clamps quantity to a minimum of 1', () => {
    const url = buildAmazonCartUrl('B07XYZ1234', 0, '');
    expect(url).toContain('Quantity.1=1');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/lib/buy-arm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buy-arm.ts`**

```typescript
/**
 * Amazon add-to-cart handoff for the buy-on-trigger feature. We never
 * automate checkout or store payment in v1 — we just hand the owner into
 * Amazon's own cart with the item pre-loaded. The AssociateTag rides along
 * so armed buys route through Associates (same tag as lib/affiliate.ts).
 *
 * NB: the /gp/aws/cart/add.html endpoint is long-standing but partially
 * deprecated by Amazon. Validate against a live ASIN during rollout; if it
 * no longer pre-loads the cart, fall back to a /dp/<ASIN> deep-link here.
 */
export function buildAmazonCartUrl(asin: string, quantity: number, affiliateTag: string): string {
  const qty = Math.max(1, Math.floor(quantity) || 1);
  const params = new URLSearchParams();
  params.set('ASIN.1', asin);
  params.set('Quantity.1', String(qty));
  if (affiliateTag.trim() !== '') params.set('AssociateTag', affiliateTag.trim());
  // URLSearchParams encodes '.' safely as literal; build manually to keep
  // the ASIN.1/Quantity.1 keys readable and stable for tests.
  const query = Array.from(params.entries()).map(([k, v]) => `${k}=${v}`).join('&');
  return `https://www.amazon.com/gp/aws/cart/add.html?${query}`;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd server && npx vitest run src/lib/buy-arm.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/buy-arm.ts server/src/lib/buy-arm.test.ts
git commit -m "feat(buy): buildAmazonCartUrl handoff helper"
```

---

## Task 4: `purchase_intents` queries + state machine

**Files:**
- Create: `server/src/db/purchase-intents.ts`
- Test: `server/src/db/purchase-intents.test.ts`

This module owns the state machine. `resolveIntentPurchased` delegates to the existing `createPurchase` so the savings ledger + `'purchased'` status + scheduler exclusion are reused.

- [ ] **Step 1: Write the failing test**

Create `server/src/db/purchase-intents.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createIntent,
  getIntentByToken,
  getOpenIntentForTracker,
  getMostRecentTerminalIntent,
  approveIntent,
  resolveIntentPurchased,
  resolveIntentNotCompleted,
  expireStaleIntents,
} from './purchase-intents.js';

let trackerId: number;

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  db.prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
  ).run();
  trackerId = Number(db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes, buy_armed, last_price)
     VALUES ('T', 'https://amazon.com/dp/B000000000', 1, 100, 60, 0, 1, 79.99)`,
  ).run().lastInsertRowid);
});

const baseInput = () => ({
  tracker_id: trackerId,
  tracker_url_id: null,
  asin: 'B000000000',
  price_at_arm: 79.99,
  threshold_at_arm: 100,
  quantity: 1,
  expires_at: '2999-01-01 00:00:00',
});

describe('purchase_intents state machine', () => {
  it('creates an armed intent with a unique token and finds it as the open intent', () => {
    const intent = createIntent(baseInput());
    expect(intent.status).toBe('armed');
    expect(intent.token).toBeTruthy();
    expect(getOpenIntentForTracker(trackerId)?.id).toBe(intent.id);
    expect(getIntentByToken(intent.token)?.id).toBe(intent.id);
  });

  it('approve transitions armed -> approved and is idempotent', () => {
    const intent = createIntent(baseInput());
    const a1 = approveIntent(intent.id);
    expect(a1.status).toBe('approved');
    expect(a1.approved_at).toBeTruthy();
    const a2 = approveIntent(intent.id);
    expect(a2.status).toBe('approved');
    expect(a2.approved_at).toBe(a1.approved_at); // no re-stamp
  });

  it('resolve purchased logs a purchase, links it, disarms the tracker, flips status', () => {
    const intent = createIntent(baseInput());
    approveIntent(intent.id);
    const { intent: resolved, purchase } = resolveIntentPurchased(intent.id);
    expect(resolved.status).toBe('purchased');
    expect(resolved.purchase_id).toBe(purchase.id);
    expect(purchase.purchase_price).toBe(79.99);
    const tracker = getDb().prepare('SELECT status, buy_armed FROM trackers WHERE id = ?').get(trackerId) as { status: string; buy_armed: number };
    expect(tracker.status).toBe('purchased');
    expect(tracker.buy_armed).toBe(0);
    expect(getOpenIntentForTracker(trackerId)).toBeUndefined();
  });

  it('resolve not_completed leaves the tracker active and still armed', () => {
    const intent = createIntent(baseInput());
    approveIntent(intent.id);
    const resolved = resolveIntentNotCompleted(intent.id);
    expect(resolved.status).toBe('not_completed');
    const tracker = getDb().prepare('SELECT status, buy_armed FROM trackers WHERE id = ?').get(trackerId) as { status: string; buy_armed: number };
    expect(tracker.status).toBe('active');
    expect(tracker.buy_armed).toBe(1);
    expect(getMostRecentTerminalIntent(trackerId)?.id).toBe(intent.id);
  });

  it('expireStaleIntents retires armed/approved intents past expires_at', () => {
    const intent = createIntent({ ...baseInput(), expires_at: '2000-01-01 00:00:00' });
    const n = expireStaleIntents('2026-05-31 00:00:00');
    expect(n).toBe(1);
    expect(getIntentByToken(intent.token)?.status).toBe('expired');
    expect(getMostRecentTerminalIntent(trackerId)?.id).toBe(intent.id);
  });

  it('does not double-open: getOpenIntentForTracker returns the live one only', () => {
    const a = createIntent(baseInput());
    resolveIntentNotCompleted(a.id);
    const b = createIntent(baseInput());
    expect(getOpenIntentForTracker(trackerId)?.id).toBe(b.id);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/db/purchase-intents.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `purchase-intents.ts`**

```typescript
import { randomBytes } from 'crypto';
import { getDb } from './connection.js';
import { createPurchase, type Purchase } from './queries.js';
import { logger } from '../logger.js';

export type IntentStatus =
  | 'armed' | 'approved' | 'purchased' | 'not_completed' | 'expired' | 'canceled';

export interface PurchaseIntent {
  id: number;
  tracker_id: number;
  tracker_url_id: number | null;
  asin: string;
  price_at_arm: number;
  threshold_at_arm: number;
  quantity: number;
  token: string;
  status: IntentStatus;
  purchase_id: number | null;
  created_at: string;
  approved_at: string | null;
  resolved_at: string | null;
  expires_at: string;
}

export interface CreateIntentInput {
  tracker_id: number;
  tracker_url_id: number | null;
  asin: string;
  price_at_arm: number;
  threshold_at_arm: number;
  quantity: number;
  expires_at: string;
}

const byId = (id: number): PurchaseIntent =>
  getDb().prepare('SELECT * FROM purchase_intents WHERE id = ?').get(id) as PurchaseIntent;

export function createIntent(input: CreateIntentInput): PurchaseIntent {
  const token = randomBytes(24).toString('base64url');
  const row = getDb().prepare(
    `INSERT INTO purchase_intents
       (tracker_id, tracker_url_id, asin, price_at_arm, threshold_at_arm, quantity, token, status, expires_at)
     VALUES (@tracker_id, @tracker_url_id, @asin, @price_at_arm, @threshold_at_arm, @quantity, @token, 'armed', @expires_at)
     RETURNING *`,
  ).get({ ...input, token }) as PurchaseIntent;
  logger.info({ intent_id: row.id, tracker_id: input.tracker_id, asin: input.asin }, 'purchase_intent_created');
  return row;
}

export function getIntentByToken(token: string): PurchaseIntent | undefined {
  return getDb().prepare('SELECT * FROM purchase_intents WHERE token = ?').get(token) as PurchaseIntent | undefined;
}

/** The single live intent for a tracker, if any. Enforces one-open-per-tracker at the read layer. */
export function getOpenIntentForTracker(trackerId: number): PurchaseIntent | undefined {
  return getDb().prepare(
    `SELECT * FROM purchase_intents
      WHERE tracker_id = ? AND status IN ('armed','approved')
      ORDER BY id DESC LIMIT 1`,
  ).get(trackerId) as PurchaseIntent | undefined;
}

/** Most recent intent that reached a re-arm-cooling terminal state. */
export function getMostRecentTerminalIntent(trackerId: number): PurchaseIntent | undefined {
  return getDb().prepare(
    `SELECT * FROM purchase_intents
      WHERE tracker_id = ? AND status IN ('expired','not_completed')
      ORDER BY id DESC LIMIT 1`,
  ).get(trackerId) as PurchaseIntent | undefined;
}

/** armed -> approved. Idempotent: only stamps approved_at on the first transition. */
export function approveIntent(id: number): PurchaseIntent {
  getDb().prepare(
    `UPDATE purchase_intents SET status = 'approved', approved_at = datetime('now')
      WHERE id = ? AND status = 'armed'`,
  ).run(id);
  return byId(id);
}

/** approved -> purchased. Logs a real purchase, links it, disarms the tracker. */
export function resolveIntentPurchased(id: number): { intent: PurchaseIntent; purchase: Purchase } {
  const db = getDb();
  const intent = byId(id);
  const purchase = createPurchase(
    intent.tracker_id,
    {
      purchase_price: intent.price_at_arm,
      quantity: intent.quantity,
      tracker_url_id: intent.tracker_url_id,
    },
    { keep_watching: false }, // sets tracker.status = 'purchased' (scheduler excludes it)
  );
  db.prepare(`UPDATE trackers SET buy_armed = 0 WHERE id = ?`).run(intent.tracker_id);
  db.prepare(
    `UPDATE purchase_intents
        SET status = 'purchased', purchase_id = ?, resolved_at = datetime('now')
      WHERE id = ?`,
  ).run(purchase.id, id);
  logger.info({ intent_id: id, purchase_id: purchase.id }, 'purchase_intent_resolved_purchased');
  return { intent: byId(id), purchase };
}

/** approved -> not_completed. Tracker stays active + armed; re-arm cooldown begins. */
export function resolveIntentNotCompleted(id: number): PurchaseIntent {
  getDb().prepare(
    `UPDATE purchase_intents SET status = 'not_completed', resolved_at = datetime('now') WHERE id = ?`,
  ).run(id);
  logger.info({ intent_id: id }, 'purchase_intent_resolved_not_completed');
  return byId(id);
}

/** Sweep: armed/approved intents past expires_at -> expired. Returns count. */
export function expireStaleIntents(nowIso?: string): number {
  const now = nowIso ?? new Date().toISOString().replace('T', ' ').slice(0, 19);
  const res = getDb().prepare(
    `UPDATE purchase_intents
        SET status = 'expired', resolved_at = datetime('now')
      WHERE status IN ('armed','approved') AND expires_at <= ?`,
  ).run(now);
  if (res.changes > 0) logger.info({ count: res.changes }, 'purchase_intents_expired');
  return res.changes;
}
```

> If `createPurchase` / `Purchase` / `logger` import paths differ, match the imports already used in `queries.ts`.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd server && npx vitest run src/db/purchase-intents.test.ts`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/db/purchase-intents.ts server/src/db/purchase-intents.test.ts
git commit -m "feat(db): purchase_intents state machine queries"
```

---

## Task 5: Extend `Tracker` type + `updateTracker` allow-list + `updateSchema`

**Files:**
- Modify: `server/src/db/queries.ts`
- Modify: `server/src/routes/trackers.ts`
- Test: `server/src/routes/tracker-arm.test.ts`

- [ ] **Step 1: Extend the `Tracker` interface (queries.ts)**

Find the `Tracker` interface (near the top of `queries.ts`, sibling of the `status` union) and add:

```typescript
  buy_armed: number;     // 0/1 — opt-in to the buy-on-trigger flow
  buy_quantity: number;  // qty to pre-load into the Amazon cart
```

- [ ] **Step 2: Extend the `updateTracker` allow-list (queries.ts)**

In the `updateTracker(id, data: Partial<{ ... }>, userId?)` type literal, add (next to `is_wishlisted`):

```typescript
  buy_armed: number;
  buy_quantity: number;
```

(The dynamic `SET` loop already handles any allow-listed key — no body change needed.)

- [ ] **Step 3: Extend `updateSchema` (trackers.ts) + coerce boolean**

In `server/src/routes/trackers.ts`, add to the `updateSchema` object (next to `is_wishlisted`):

```typescript
    buy_armed: z.boolean().optional(),
    buy_quantity: z.number().int().min(1).optional(),
```

Then in the PUT handler, extend the boolean-coercion boundary (where `is_wishlisted` is converted to 0/1) to also coerce `buy_armed`:

```typescript
  const { is_wishlisted, buy_armed, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (is_wishlisted !== undefined) data.is_wishlisted = is_wishlisted ? 1 : 0;
  if (buy_armed !== undefined) data.buy_armed = buy_armed ? 1 : 0;
  const tracker = updateTracker(Number(req.params.id), data, req.user!.userId);
```

- [ ] **Step 4: Write the failing route test**

Create `server/src/routes/tracker-arm.test.ts` — follow the existing route-test harness in this folder (look at a sibling `*.test.ts` in `server/src/routes/` for how it builds an app + auth cookie + in-memory DB; reuse that setup verbatim). The assertion body:

```typescript
// PUT /api/trackers/:id { buy_armed: true, buy_quantity: 2 } persists as 1 / 2
it('arms a tracker and stores quantity', async () => {
  const res = await put(`/api/trackers/${trackerId}`, { buy_armed: true, buy_quantity: 2 });
  expect(res.status).toBe(200);
  const row = getDb().prepare('SELECT buy_armed, buy_quantity FROM trackers WHERE id = ?').get(trackerId) as { buy_armed: number; buy_quantity: number };
  expect(row).toEqual({ buy_armed: 1, buy_quantity: 2 });
});

it('rejects buy_quantity < 1', async () => {
  const res = await put(`/api/trackers/${trackerId}`, { buy_quantity: 0 });
  expect(res.status).toBe(400);
});
```

> Use the exact request helper (`put`/`request`) and setup the sibling route tests use; don't invent a new harness.

- [ ] **Step 5: Run the test (fail → implement covered above → pass)**

Run: `cd server && npx vitest run src/routes/tracker-arm.test.ts`
Expected: PASS after Steps 1-3.

- [ ] **Step 6: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/db/queries.ts server/src/routes/trackers.ts server/src/routes/tracker-arm.test.ts
git commit -m "feat(api): arm/disarm + buy_quantity via PUT /api/trackers/:id"
```

---

## Task 6: Purchase-arm notifications

**Files:**
- Create: `server/src/notifications/purchase-arm.ts`
- Modify: `server/src/notifications/discord.ts`, `ntfy.ts`, `web-push.ts`
- Test: `server/src/notifications/purchase-arm.test.ts`

- [ ] **Step 1: Write the failing test for the shared content builder**

Create `server/src/notifications/purchase-arm.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { purchaseArmContent } from './purchase-arm.js';

describe('purchaseArmContent', () => {
  it('builds title + body with price, threshold, and buy link', () => {
    const { title, body } = purchaseArmContent('LG 27" Monitor', 219.99, 250, 'https://prices.example/buy/tok');
    expect(title).toContain('LG 27" Monitor');
    expect(body).toContain('$219.99');
    expect(body).toContain('$250.00');
    expect(body).toContain('https://prices.example/buy/tok');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/notifications/purchase-arm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Add per-channel builders**

In `discord.ts` (mirror `sendDiscordPriceAlert`'s transport):

```typescript
export async function sendDiscordPurchaseArm(
  trackerName: string, currentPrice: number, threshold: number, buyUrl: string, webhookUrl: string,
): Promise<boolean> {
  const embed = {
    title: `🛒 Ready to buy: ${trackerName}`,
    color: 0xff9900,
    description: `Hit **$${currentPrice.toFixed(2)}** (your limit $${threshold.toFixed(2)}).`,
    fields: [{ name: 'Approve', value: `[Review & buy →](${buyUrl})` }],
  };
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return resp.ok;
  } catch (err) {
    logger.error({ err }, 'Discord purchase-arm failed');
    return false;
  }
}
```

In `ntfy.ts` (mirror `sendNtfyPriceAlert` — ntfy uses headers for title/click/actions):

```typescript
export async function sendNtfyPurchaseArm(
  trackerName: string, currentPrice: number, threshold: number, buyUrl: string, ntfyUrl: string, ntfyToken?: string,
): Promise<boolean> {
  const headers: Record<string, string> = {
    Title: `Ready to buy: ${trackerName}`,
    Tags: 'shopping_cart',
    Click: buyUrl,
    Actions: `view, Review & buy, ${buyUrl}`,
  };
  if (ntfyToken) headers.Authorization = `Bearer ${ntfyToken}`;
  try {
    const resp = await fetch(ntfyUrl, {
      method: 'POST', headers,
      body: `${trackerName} hit $${currentPrice.toFixed(2)} (limit $${threshold.toFixed(2)}).`,
    });
    return resp.ok;
  } catch (err) {
    logger.error({ err }, 'ntfy purchase-arm failed');
    return false;
  }
}
```

In `web-push.ts` (mirror `sendWebPushPriceAlert`; reuse its per-device send + 410/404 cleanup helper — call the same internal you'll find there):

```typescript
export async function sendWebPushPurchaseArm(
  trackerName: string, currentPrice: number, threshold: number, buyUrl: string, userId: number,
): Promise<boolean> {
  const payload = JSON.stringify({
    title: `🛒 Ready to buy: ${trackerName}`,
    body: `Hit $${currentPrice.toFixed(2)} (limit $${threshold.toFixed(2)}). Tap to review & buy.`,
    url: buyUrl,
  });
  return sendWebPushToUser(userId, payload); // reuse the existing fan-out+cleanup used by sendWebPushPriceAlert
}
```

> If `web-push.ts` doesn't already expose a `sendWebPushToUser(userId, payload)` internal, factor the per-user fan-out out of `sendWebPushPriceAlert` into one and call it from both. Keep behavior identical.

- [ ] **Step 4: Implement the dispatcher `purchase-arm.ts`**

```typescript
import { sendDiscordPurchaseArm } from './discord.js';
import { sendNtfyPurchaseArm } from './ntfy.js';
import { sendWebPushPurchaseArm } from './web-push.js';
import type { EnabledChannels } from './channels.js'; // match the type used by firePriceAlerts
import { logger } from '../logger.js';

export function purchaseArmContent(trackerName: string, currentPrice: number, threshold: number, buyUrl: string) {
  return {
    title: `🛒 Ready to buy: ${trackerName}`,
    body: `${trackerName} hit $${currentPrice.toFixed(2)} (your buy limit $${threshold.toFixed(2)}). Approve → ${buyUrl}`,
  };
}

/** Fan out a purchase-arm to the interactive channels. Mirrors fireErrorAlerts. */
export async function firePurchaseArm(
  trackerName: string, currentPrice: number, threshold: number, buyUrl: string,
  channels: EnabledChannels, userId: number,
): Promise<string[]> {
  const tasks: { name: string; p: Promise<boolean> }[] = [];
  if (channels.discord) tasks.push({ name: 'discord', p: sendDiscordPurchaseArm(trackerName, currentPrice, threshold, buyUrl, channels.discord) });
  if (channels.ntfy) tasks.push({ name: 'ntfy', p: sendNtfyPurchaseArm(trackerName, currentPrice, threshold, buyUrl, channels.ntfy, channels.ntfyToken) });
  if (channels.webPush) tasks.push({ name: 'web_push', p: sendWebPushPurchaseArm(trackerName, currentPrice, threshold, buyUrl, userId) });
  const results = await Promise.all(tasks.map(t => t.p));
  const sent = tasks.filter((_, i) => results[i]).map(t => t.name);
  logger.info({ trackerName, sent }, 'purchase_arm_dispatched');
  return sent;
}
```

> `EnabledChannels`' property names (`webPush` vs `web_push`) must match the type `firePriceAlerts` already uses — copy them exactly from `cron.ts`'s `EnabledChannels`.

- [ ] **Step 5: Run the content test to confirm it passes**

Run: `cd server && npx vitest run src/notifications/purchase-arm.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full server suite (web-push refactor didn't break price alerts)**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/notifications/purchase-arm.ts server/src/notifications/purchase-arm.test.ts server/src/notifications/discord.ts server/src/notifications/ntfy.ts server/src/notifications/web-push.ts
git commit -m "feat(notifications): purchase-arm builders + dispatcher"
```

---

## Task 7: Arm decision + cron injection

**Files:**
- Modify: `server/src/scheduler/cron.ts`
- Test: `server/src/scheduler/arm-decision.test.ts`

The arm decision lives in `maybeArmPurchase`, called at the very top of `firePriceAlerts`. Returning `true` means "armed — suppress the normal price alert"; `firePriceAlerts` then returns `[]` so the caller's `addNotification` loop records nothing (the intent row is the event's record).

- [ ] **Step 1: Write the failing test**

Create `server/src/scheduler/arm-decision.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { maybeArmPurchase } from './cron.js';
import { getOpenIntentForTracker, createIntent } from '../db/purchase-intents.js';

let trackerId: number;
let sellerId: number;

function seed(opts: { buy_armed: number; url: string }) {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active) VALUES ('t@x.com','h','T','user',1)`).run();
  trackerId = Number(db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, check_interval_minutes, jitter_minutes, buy_armed, buy_quantity, normalized_url)
     VALUES ('T', ?, 1, 100, 60, 0, ?, 1, ?)`,
  ).run(opts.url, opts.buy_armed, opts.url).lastInsertRowid);
  sellerId = Number(db.prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position, status) VALUES (?, ?, 0, 'active')`,
  ).run(trackerId, opts.url).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

// channels arg with everything off → no real network calls
const noChannels = {} as never;

describe('maybeArmPurchase', () => {
  it('arms an Amazon tracker with an ASIN and creates exactly one intent', async () => {
    seed({ buy_armed: 1, url: 'https://www.amazon.com/dp/B07XYZ1234' });
    const armed = await maybeArmPurchase(trackerId, 79.99, getDb().prepare('SELECT * FROM tracker_urls WHERE id = ?').get(sellerId) as never, noChannels);
    expect(armed).toBe(true);
    const intent = getOpenIntentForTracker(trackerId);
    expect(intent?.asin).toBe('B07XYZ1234');
    expect(intent?.price_at_arm).toBe(79.99);
  });

  it('does not arm an unarmed tracker', async () => {
    seed({ buy_armed: 0, url: 'https://www.amazon.com/dp/B07XYZ1234' });
    const armed = await maybeArmPurchase(trackerId, 79.99, getDb().prepare('SELECT * FROM tracker_urls WHERE id = ?').get(sellerId) as never, noChannels);
    expect(armed).toBe(false);
  });

  it('does not arm a non-Amazon seller', async () => {
    seed({ buy_armed: 1, url: 'https://www.newegg.com/p/N82E16819' });
    const armed = await maybeArmPurchase(trackerId, 79.99, getDb().prepare('SELECT * FROM tracker_urls WHERE id = ?').get(sellerId) as never, noChannels);
    expect(armed).toBe(false);
  });

  it('does not arm twice when an open intent exists', async () => {
    seed({ buy_armed: 1, url: 'https://www.amazon.com/dp/B07XYZ1234' });
    createIntent({ tracker_id: trackerId, tracker_url_id: sellerId, asin: 'B07XYZ1234', price_at_arm: 80, threshold_at_arm: 100, quantity: 1, expires_at: '2999-01-01 00:00:00' });
    const armed = await maybeArmPurchase(trackerId, 79.99, getDb().prepare('SELECT * FROM tracker_urls WHERE id = ?').get(sellerId) as never, noChannels);
    expect(armed).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd server && npx vitest run src/scheduler/arm-decision.test.ts`
Expected: FAIL — `maybeArmPurchase` not exported.

- [ ] **Step 3: Implement `maybeArmPurchase` and wire it into `firePriceAlerts`**

At the top of `cron.ts`, add imports:

```typescript
import { isAmazonStorefrontUrl, extractAmazonAsin } from '../lib/affiliate.js';
import { buildAmazonCartUrl } from '../lib/buy-arm.js';
import { getOpenIntentForTracker, getMostRecentTerminalIntent, createIntent } from '../db/purchase-intents.js';
import { firePurchaseArm } from '../notifications/purchase-arm.js';
import { config } from '../config.js';
import { PUBLIC_ORIGIN } from '../<same module wishlist.ts imports it from>.js';
```

Add the function (above `firePriceAlerts`):

```typescript
/**
 * Buy-on-trigger arm decision. Runs AFTER the plausibility guard (all
 * firePriceAlerts call sites are post-guard), so a $0/implausible misread
 * never arms a purchase. Returns true when it armed (caller suppresses the
 * normal price alert); false to fall through to normal alerting.
 */
export async function maybeArmPurchase(
  trackerId: number,
  currentPrice: number,
  seller: TrackerUrl,
  channels: EnabledChannels,
): Promise<boolean> {
  const tracker = getTrackerById(trackerId);
  if (!tracker || tracker.buy_armed !== 1 || !tracker.threshold_price) return false;
  if (!isAmazonStorefrontUrl(seller.url)) return false;

  const asin =
    extractAmazonAsin(seller.url) ??
    (tracker.normalized_url ? extractAmazonAsin(tracker.normalized_url) : null);
  if (!asin) return false;

  if (getOpenIntentForTracker(trackerId)) return false; // one-open-intent invariant

  // Re-arm cooldown: don't immediately re-arm after expired/not_completed.
  const recent = getMostRecentTerminalIntent(trackerId);
  if (recent) {
    const ref = recent.resolved_at ?? recent.expires_at;
    const elapsedMs = Date.now() - new Date(ref.replace(' ', 'T') + 'Z').getTime();
    if (elapsedMs < config.reArmCooldownHours * 3600 * 1000) return false;
  }

  const expires_at = new Date(Date.now() + config.armExpiryHours * 3600 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
  const intent = createIntent({
    tracker_id: trackerId,
    tracker_url_id: seller.id,
    asin,
    price_at_arm: currentPrice,
    threshold_at_arm: tracker.threshold_price,
    quantity: tracker.buy_quantity ?? 1,
    expires_at,
  });

  const buyUrl = `${PUBLIC_ORIGIN}/buy/${intent.token}`;
  await firePurchaseArm(tracker.name, currentPrice, tracker.threshold_price, buyUrl, channels, tracker.user_id!);
  logger.info({ tracker_id: trackerId, intent_id: intent.id, asin }, 'purchase_armed');
  return true;
}
```

Then at the **very top** of `firePriceAlerts` (first lines of the body):

```typescript
  // Buy-on-trigger: an eligible armed tracker arms a purchase instead of a
  // price alert. Returning [] means the caller's addNotification loop
  // records nothing — the purchase_intents row is this event's record.
  if (await maybeArmPurchase(alertTracker.id, currentPrice, seller, channels)) {
    return [];
  }
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd server && npx vitest run src/scheduler/arm-decision.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Run the full server suite**

Run: `cd server && npm test`
Expected: PASS (existing cron/cooldown tests unaffected — unarmed trackers still take the normal path).

- [ ] **Step 6: Commit**

```bash
git add server/src/scheduler/cron.ts server/src/scheduler/arm-decision.test.ts
git commit -m "feat(cron): arm purchase intent on threshold cross for armed Amazon trackers"
```

---

## Task 8: `/api/buy/*` routes

**Files:**
- Create: `server/src/routes/buy.ts`
- Modify: `server/src/index.ts`
- Test: `server/src/routes/buy.test.ts`

- [ ] **Step 1: Implement the router `buy.ts`**

```typescript
import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getTrackerById } from '../db/queries.js';
import {
  getIntentByToken, approveIntent, resolveIntentPurchased, resolveIntentNotCompleted,
} from '../db/purchase-intents.js';
import { buildAmazonCartUrl } from '../lib/buy-arm.js';
import { config } from '../config.js';

export const buyRouter = Router();

// Resolve the intent + assert the logged-in user owns its tracker, else 404
// (don't reveal existence). Returns the intent or null.
function ownedIntent(token: string, userId: number) {
  const intent = getIntentByToken(token);
  if (!intent) return null;
  const tracker = getTrackerById(intent.tracker_id, userId);
  if (!tracker) return null;
  return { intent, tracker };
}

// GET /api/buy/:token — order summary for the Buy Confirmation page.
buyRouter.get('/:token', (req: Request, res: Response) => {
  const found = ownedIntent(req.params.token, req.user!.userId);
  if (!found) return res.status(404).json({ error: 'not found' });
  const { intent, tracker } = found;
  res.json({
    intent: {
      status: intent.status, asin: intent.asin, price_at_arm: intent.price_at_arm,
      threshold_at_arm: intent.threshold_at_arm, quantity: intent.quantity, expires_at: intent.expires_at,
    },
    tracker: { id: tracker.id, name: tracker.name },
    // Only expose the cart URL once approvable/approved.
    cartUrl: intent.status === 'approved'
      ? buildAmazonCartUrl(intent.asin, intent.quantity, config.amazonAffiliateTag)
      : null,
  });
});

// POST /api/buy/:token/approve — armed -> approved, returns the cart URL.
buyRouter.post('/:token/approve', (req: Request, res: Response) => {
  const found = ownedIntent(req.params.token, req.user!.userId);
  if (!found) return res.status(404).json({ error: 'not found' });
  if (!['armed', 'approved'].includes(found.intent.status)) {
    return res.status(409).json({ error: `cannot approve a ${found.intent.status} intent` });
  }
  const intent = approveIntent(found.intent.id);
  res.json({ cartUrl: buildAmazonCartUrl(intent.asin, intent.quantity, config.amazonAffiliateTag) });
});

const resolveSchema = z.object({ outcome: z.enum(['purchased', 'not_completed']) });

// POST /api/buy/:token/resolve — close the loop after native checkout.
buyRouter.post('/:token/resolve', (req: Request, res: Response) => {
  const found = ownedIntent(req.params.token, req.user!.userId);
  if (!found) return res.status(404).json({ error: 'not found' });
  if (found.intent.status !== 'approved') {
    return res.status(409).json({ error: `cannot resolve a ${found.intent.status} intent` });
  }
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid body' });

  if (parsed.data.outcome === 'purchased') {
    const { intent, purchase } = resolveIntentPurchased(found.intent.id);
    return res.json({ intent: { status: intent.status }, purchase });
  }
  const intent = resolveIntentNotCompleted(found.intent.id);
  res.json({ intent: { status: intent.status } });
});
```

- [ ] **Step 2: Register the router (index.ts)**

After the `/api/purchases` registration (line ~125), add:

```typescript
app.use('/api/buy', apiKeyMiddleware, authMiddleware, buyRouter);
```

And add the import near the other route imports:

```typescript
import { buyRouter } from './routes/buy.js';
```

- [ ] **Step 3: Write the route test**

Create `server/src/routes/buy.test.ts` using the same in-memory-app harness as the sibling route tests. Cases:

```typescript
// happy path: approve returns a cartUrl containing the ASIN; resolve purchased logs a purchase + flips tracker
it('approves then resolves purchased', async () => {
  // seed armed tracker + intent (use createIntent), authenticate as owner
  const approve = await post(`/api/buy/${token}/approve`, {});
  expect(approve.status).toBe(200);
  expect(approve.body.cartUrl).toContain('B07XYZ1234');
  const resolve = await post(`/api/buy/${token}/resolve`, { outcome: 'purchased' });
  expect(resolve.status).toBe(200);
  expect(resolve.body.intent.status).toBe('purchased');
});

// authorization: a different user gets 404
it('hides another user\'s intent', async () => {
  const res = await asOtherUser.get(`/api/buy/${token}`);
  expect(res.status).toBe(404);
});

// resolve before approve is 409
it('rejects resolving an armed (un-approved) intent', async () => {
  const res = await post(`/api/buy/${token}/resolve`, { outcome: 'purchased' });
  expect(res.status).toBe(409);
});
```

> Mirror the auth-cookie + second-user setup from an existing owner-authorization route test (e.g. the purchases or wishlist route test).

- [ ] **Step 4: Run the test (fail → it now passes with the router in place)**

Run: `cd server && npx vitest run src/routes/buy.test.ts`
Expected: PASS.

- [ ] **Step 5: Full server suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/buy.ts server/src/index.ts server/src/routes/buy.test.ts
git commit -m "feat(api): /api/buy/* approve + resolve endpoints (auth-gated, owner-only)"
```

---

## Task 9: Client API helpers + Buy Confirmation page + route

**Files:**
- Modify: `client/src/api.ts`, `client/src/types.ts` (or wherever `Tracker` is typed), `client/src/App.tsx`
- Create: `client/src/pages/Buy.tsx`
- Test: `client/src/pages/Buy.test.tsx`

- [ ] **Step 1: Add the `Tracker` client fields**

In the client `Tracker` type, add:

```typescript
  buy_armed?: number;
  buy_quantity?: number;
```

- [ ] **Step 2: Add API helpers (api.ts)**

```typescript
export const setTrackerArm = (id: number, buy_armed: boolean, buy_quantity?: number) =>
  request<Tracker>(`/trackers/${id}`, {
    method: 'PUT',
    body: JSON.stringify(buy_quantity === undefined ? { buy_armed } : { buy_armed, buy_quantity }),
  });

export interface BuyIntentView {
  intent: { status: string; asin: string; price_at_arm: number; threshold_at_arm: number; quantity: number; expires_at: string };
  tracker: { id: number; name: string };
  cartUrl: string | null;
}

export async function getBuyIntent(token: string): Promise<BuyIntentView> {
  const r = await fetch(`/api/buy/${encodeURIComponent(token)}`, { credentials: 'include' });
  if (r.status === 404) throw new Error('NOT_FOUND');
  if (!r.ok) throw new Error(`getBuyIntent failed: ${r.status}`);
  return r.json();
}

export async function approveBuyIntent(token: string): Promise<{ cartUrl: string }> {
  const r = await fetch(`/api/buy/${encodeURIComponent(token)}/approve`, { method: 'POST', credentials: 'include' });
  if (!r.ok) throw new Error(`approve failed: ${r.status}`);
  return r.json();
}

export async function resolveBuyIntent(token: string, outcome: 'purchased' | 'not_completed'): Promise<void> {
  const r = await fetch(`/api/buy/${encodeURIComponent(token)}/resolve`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome }),
  });
  if (!r.ok) throw new Error(`resolve failed: ${r.status}`);
}
```

> If `request()` already injects `credentials`/headers, prefer it over raw `fetch` to match the file's convention; the `getPublicWishlist` helper is the closest precedent for the explicit-fetch style.

- [ ] **Step 3: Create `Buy.tsx`**

Model the load state machine on `WishlistPublic.tsx`. The page: loads the intent, shows the order summary, an **Approve → Open in Amazon** button (calls `approveBuyIntent`, then `window.open(cartUrl, '_blank')`), and after approval a **Did it go through? Yes / No** pair (calls `resolveBuyIntent`). Terminal statuses render read-only.

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getBuyIntent, approveBuyIntent, resolveBuyIntent, type BuyIntentView } from '../api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: BuyIntentView }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

export default function Buy() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!token) { setState({ kind: 'not-found' }); return; }
    setState({ kind: 'loading' });
    getBuyIntent(token)
      .then(data => setState({ kind: 'ready', data }))
      .catch(err => setState(err.message === 'NOT_FOUND'
        ? { kind: 'not-found' }
        : { kind: 'error', message: String(err.message ?? err) }));
  };
  useEffect(load, [token]);

  if (state.kind === 'loading') return <div className="p-6">Loading…</div>;
  if (state.kind === 'not-found') return <div className="p-6">This purchase link isn’t valid anymore.</div>;
  if (state.kind === 'error') return <div className="p-6 text-red-600">Error: {state.message}</div>;

  const { intent, tracker, cartUrl } = state.data;
  const isOpen = intent.status === 'armed' || intent.status === 'approved';

  const onApprove = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const { cartUrl: url } = await approveBuyIntent(token);
      window.open(url, '_blank', 'noopener');
      load();
    } finally { setBusy(false); }
  };
  const onResolve = async (outcome: 'purchased' | 'not_completed') => {
    if (!token) return;
    setBusy(true);
    try { await resolveBuyIntent(token, outcome); load(); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-md mx-auto p-6 space-y-4">
      <h1 className="text-xl font-semibold">🛒 {tracker.name}</h1>
      <div className="rounded-lg border p-4 space-y-1">
        <div>Price: <strong>${intent.price_at_arm.toFixed(2)}</strong></div>
        <div className="text-sm text-gray-500">Your limit: ${intent.threshold_at_arm.toFixed(2)} · Qty {intent.quantity}</div>
        <div className="text-sm text-gray-500">Status: {intent.status}</div>
      </div>

      {intent.status === 'armed' && (
        <button disabled={busy} onClick={onApprove}
          className="w-full rounded-lg bg-amber-500 text-white py-3 font-medium disabled:opacity-50">
          Approve → Open in Amazon
        </button>
      )}

      {intent.status === 'approved' && (
        <div className="space-y-3">
          {cartUrl && (
            <a href={cartUrl} target="_blank" rel="noopener" className="block text-center underline">
              Re-open Amazon cart
            </a>
          )}
          <div className="text-sm font-medium">Did it go through?</div>
          <div className="flex gap-3">
            <button disabled={busy} onClick={() => onResolve('purchased')}
              className="flex-1 rounded-lg bg-green-600 text-white py-2 disabled:opacity-50">Yes, bought it</button>
            <button disabled={busy} onClick={() => onResolve('not_completed')}
              className="flex-1 rounded-lg border py-2 disabled:opacity-50">No</button>
          </div>
        </div>
      )}

      {!isOpen && <div className="text-sm text-gray-500">This purchase is closed ({intent.status}).</div>}
    </div>
  );
}
```

- [ ] **Step 4: Register the route (App.tsx)**

In the **ProtectedRoute** `<Routes>` block (the authenticated one, ~line 181), add — and add the lazy import next to the other page imports:

```tsx
<Route path="/buy/:token" element={<ProtectedRoute><Buy /></ProtectedRoute>} />
```

- [ ] **Step 5: Write a component test**

Create `client/src/pages/Buy.test.tsx` (mirror `Savings.test.tsx` / `Purchased.test.tsx` setup — mock `../api`, render with a `MemoryRouter` at `/buy/tok`). Assert:

```tsx
// renders the price + an Approve button for an armed intent
it('shows Approve for an armed intent', async () => {
  vi.mocked(getBuyIntent).mockResolvedValue({
    intent: { status: 'armed', asin: 'B0', price_at_arm: 79.99, threshold_at_arm: 100, quantity: 1, expires_at: '' },
    tracker: { id: 1, name: 'Widget' }, cartUrl: null,
  });
  render(<MemoryRouter initialEntries={['/buy/tok']}><Routes><Route path="/buy/:token" element={<Buy />} /></Routes></MemoryRouter>);
  expect(await screen.findByText(/Approve/)).toBeInTheDocument();
  expect(screen.getByText(/\$79\.99/)).toBeInTheDocument();
});

// renders the closed state for a terminal intent
it('shows closed for a purchased intent', async () => {
  vi.mocked(getBuyIntent).mockResolvedValue({
    intent: { status: 'purchased', asin: 'B0', price_at_arm: 79.99, threshold_at_arm: 100, quantity: 1, expires_at: '' },
    tracker: { id: 1, name: 'Widget' }, cartUrl: null,
  });
  render(<MemoryRouter initialEntries={['/buy/tok']}><Routes><Route path="/buy/:token" element={<Buy />} /></Routes></MemoryRouter>);
  expect(await screen.findByText(/closed/)).toBeInTheDocument();
});
```

- [ ] **Step 6: Run client tests + typecheck**

Run: `cd client && npx vitest run src/pages/Buy.test.tsx` then `cd client && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add client/src/api.ts client/src/types.ts client/src/App.tsx client/src/pages/Buy.tsx client/src/pages/Buy.test.tsx
git commit -m "feat(client): Buy Confirmation page + buy API helpers + route"
```

---

## Task 10: TrackerDetail arm toggle + quantity

**Files:**
- Modify: `client/src/pages/TrackerDetail.tsx`
- Test: extend the existing `TrackerDetail` test if present, else a focused new one.

- [ ] **Step 1: Add the arm UI + handler**

Following the existing pause/doorbuster pattern (local state → `await setTrackerArm(...)` → `await load()`), add an "Arm for purchase" section. Only enable when the primary seller is Amazon (reuse the host check already used for affiliate/condition display, or check the tracker's primary URL host).

```tsx
const [armQuantity, setArmQuantity] = useState('1');

const handleToggleArm = async () => {
  if (!tracker) return;
  const next = tracker.buy_armed ? false : true;
  await setTrackerArm(trackerId, next, Math.max(1, parseInt(armQuantity) || 1));
  await load();
};
```

```tsx
<section className="rounded-lg border p-4 space-y-2">
  <div className="flex items-center justify-between">
    <div>
      <div className="font-medium">Arm for purchase</div>
      <div className="text-sm text-gray-500">
        When this hits your target, you’ll get a one-tap approval to buy on Amazon.
        Nothing is purchased without your tap.
      </div>
    </div>
    <button onClick={handleToggleArm}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tracker.buy_armed ? 'bg-amber-500 text-white' : 'border'}`}>
      {tracker.buy_armed ? '🛒 Armed' : 'Arm'}
    </button>
  </div>
  {tracker.buy_armed ? null : (
    <label className="text-sm flex items-center gap-2">
      Quantity
      <input type="number" min={1} value={armQuantity} onChange={e => setArmQuantity(e.target.value)}
        className="w-20 rounded border px-2 py-1" />
    </label>
  )}
</section>
```

> Import `setTrackerArm` from `../api`. If the seller isn't Amazon, render the button `disabled` with a hint ("Amazon only in v1").

- [ ] **Step 2: Typecheck + client tests**

Run: `cd client && npx tsc --noEmit && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/TrackerDetail.tsx
git commit -m "feat(client): Arm for purchase toggle on TrackerDetail"
```

---

## Task 11: Expiry sweep wiring + final verification

**Files:**
- Modify: wherever nightly crons are registered (the AI summary/verdict backfill cron — search `cron.schedule` / nightly sweep in `server/src/scheduler/`).

- [ ] **Step 1: Call `expireStaleIntents` from the existing nightly sweep**

Find the nightly backfill cron (the one that backfills AI summaries/verdicts) and add a call to `expireStaleIntents()` inside it. Add the import:

```typescript
import { expireStaleIntents } from '../db/purchase-intents.js';
```

```typescript
// Retire armed/approved intents whose window elapsed.
const expired = expireStaleIntents();
if (expired > 0) logger.info({ expired }, 'nightly_purchase_intent_expiry');
```

- [ ] **Step 2: Full build + both test suites (Definition of Done)**

```bash
cd server && npm test && npx tsc --noEmit
cd client && npm test && npx tsc --noEmit
```
Expected: all green, zero type errors.

- [ ] **Step 3: Manual smoke (document what you observed)**

With `AI_ENABLED` unset and a dev server: create an Amazon tracker, set threshold above current price (so it "drops"), arm it via TrackerDetail, run a manual check, confirm: (a) a `purchase_intents` row appears `armed`, (b) the `/buy/<token>` page loads the summary, (c) Approve flips to `approved` and opens an Amazon cart URL, (d) "Yes, bought it" creates a `purchases` row and flips the tracker to `purchased`. Record the observations in the commit/PR body.

- [ ] **Step 4: Commit**

```bash
git add server/src/scheduler/
git commit -m "feat(cron): nightly expiry sweep for stale purchase intents"
```

- [ ] **Step 5: Update `tasks/todo.md`**

Mark the autonomous-purchasing item done with a one-line summary + PR link, mirroring the existing "Done" entry style.

---

## Self-Review (completed by plan author)

- **Spec coverage:** schema/migration (T2) ✓; one-open-intent invariant (T4/T7) ✓; re-arm cooldown (T7) ✓; plausibility-guard ordering (T7) ✓; Amazon handoff URL + affiliate tag + fallback note (T3) ✓; auth-gated owner-only `/buy` (T8) ✓; purchase-arm notifications (T6) ✓; reuse `createPurchase` terminal state (T4) ✓; arm toggle + quantity UI (T10) ✓; expiry sweep (T11) ✓; testing plan (every task) ✓.
- **Notification scope deviation from spec:** spec says "across the existing channels"; this plan ships Discord + ntfy + web push in v1 and defers email/generic-webhook purchase-arm (noted, zero new logic). Flag for the reviewer — easy to add if they want all five.
- **Type consistency:** `EnabledChannels` field names (`webPush`/`ntfyToken`) must be copied verbatim from `cron.ts` (flagged in T6/T7). `PUBLIC_ORIGIN` import path must match `wishlist.ts` (flagged in T7). `createPurchase`/`Purchase`/`logger` import paths must match `queries.ts` (flagged in T4).
- **Placeholder scan:** route/component test harnesses point at named sibling files to copy rather than inlining a full app-bootstrap — deliberate (the harness already exists in-repo); assertion bodies are concrete.
