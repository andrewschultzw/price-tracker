# Purchased Tracking & Savings Rollup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-tracker "Purchased" logging, savings rollup, admin log view, and public footer + `/savings` page.

**Architecture:** New `purchases` table (many-to-one with `trackers`) joined to existing tables. Tracker `status` enum gains `'purchased'`. Backend: CRUD endpoints for purchases + one public aggregate endpoint with no PII. Client: a modal on tracker detail, a banner once purchased, a Dashboard toggle, a `/purchased` admin page, footer line, and a `/savings` public page. The feature is fully additive — no existing endpoints, scrape paths, or notification paths change shape.

**Tech Stack:** Node.js 22, TypeScript, Express, better-sqlite3, Playwright; React 19 + Vite + Tailwind v4 + Recharts; vitest on both sides.

**Spec:** `docs/superpowers/specs/2026-05-20-purchased-tracking-design.md` — read before starting.

---

## File Structure

**Created:**
- `server/src/routes/purchases.ts` — authenticated CRUD endpoints
- `server/src/routes/purchases.test.ts`
- `server/src/routes/public-savings.ts` — public `/api/public/savings` endpoint
- `server/src/routes/public-savings.test.ts`
- `server/src/db/queries.purchases.test.ts`
- `client/src/components/PurchaseModal.tsx`
- `client/src/components/PurchaseModal.test.tsx`
- `client/src/components/PurchasedBanner.tsx`
- `client/src/pages/Purchased.tsx`
- `client/src/pages/Purchased.test.tsx`
- `client/src/pages/Savings.tsx`
- `client/src/pages/Savings.test.tsx`

**Modified:**
- `server/src/db/migrations.ts` — append migration v18
- `server/src/db/schema.ts` — add `purchases` table to fresh-install schema; extend `trackers.status` CHECK
- `server/src/db/queries.ts` — add purchase functions; add `'purchased'` to scheduler-excluded statuses; extend `TrackerStatus` union
- `server/src/index.ts` — wire new routers
- `client/src/types.ts` — add `Purchase` type; extend status union
- `client/src/api.ts` — purchase API methods + savings fetch
- `client/src/pages/TrackerDetail.tsx` — Purchased button + banner
- `client/src/pages/Dashboard.tsx` — hide purchased by default + "Show purchased" toggle
- `client/src/App.tsx` — register `/purchased` (auth'd) and `/savings` (public) routes; add `/savings` to `PUBLIC_PATH_PREFIXES`
- `client/src/components/AffiliateDisclosure.tsx` — add savings line above the disclosure text

**Conventions to follow:**
- Migration v18 uses the same `db.unsafeMode(true)` + `PRAGMA writable_schema` pattern as v17 for the CHECK widening (see `server/src/db/migrations.ts:530-579`) — do NOT use the rebuild-the-table approach; it cascades through FKs and silently loses data (see `tasks/lessons.md`).
- DDL goes through the better-sqlite3 multi-statement helper used by every other migration in this file. Mirror the call shape used in v1.
- All money is REAL (SQLite) — match existing `price_history.price` storage.
- Tests use vitest. Server test files sit beside the source (`foo.ts` → `foo.test.ts`). Client follows the same pattern.
- Logger is `pino`; access via `import { logger } from '../logger.js'`.

---

## Task 1: Migration v18 — purchases table + status CHECK extension

**Files:**
- Modify: `server/src/db/migrations.ts` (append to the `migrations` array, before the closing `];`)

- [ ] **Step 1: Write the migration**

Append after the v17 entry. Mirror the call shape used by other migrations in this file (e.g. v1 uses the multi-statement DDL helper on the better-sqlite3 instance).

DDL block for the new table:

```sql
CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
  purchase_price REAL NOT NULL CHECK(purchase_price >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
  first_price REAL NOT NULL,
  purchased_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_tracker_id ON purchases(tracker_id);
CREATE INDEX IF NOT EXISTS idx_purchases_purchased_at ON purchases(purchased_at);
```

Then widen the `trackers.status` CHECK using the v17 pattern. Old → new strings:

- old: `CHECK(status IN ('active', 'paused', 'error', 'blocked'))`
- new: `CHECK(status IN ('active', 'paused', 'error', 'blocked', 'purchased'))`

Apply only to the `trackers` table (NOT `tracker_urls` — `'purchased'` is a tracker-level state).

Use this `up()` body shape (read v17's body for the surrounding boilerplate and copy it verbatim, only changing the table name in the WHERE clause and the old/new CHECK strings):

Structure of the migration body:

1. **Create the `purchases` table** — call better-sqlite3's multi-statement DDL runner on the `db` handle (the same one v1 uses; see `migrations.ts:18-56` for the call shape). Pass the SQL block above verbatim as a template literal.
2. **Widen the `trackers.status` CHECK** — copy v17's `writable_schema` block (`migrations.ts:548-578`) verbatim, but narrow the WHERE clause to `name = 'trackers'` (drop `tracker_urls`) and swap the old/new CHECK strings shown above.

Boilerplate to copy from v17: `db.unsafeMode(true)`, the `try`/`finally` blocks, `PRAGMA writable_schema = ON/OFF`, the `UPDATE sqlite_schema` statement, the `PRAGMA schema_version` bump, and `db.unsafeMode(false)`.

- [ ] **Step 2: Verify migration applies cleanly on a fresh DB**

Run: `cd server && npm test -- --run db/migrations` (or the closest existing migration test file — if none exists, do an ad-hoc check: `npm run dev` and watch logs for `Migration applied version=18`)
Expected: no errors, schema_version advances.

- [ ] **Step 3: Verify migration is idempotent**

Re-running the server should not re-apply v18. Inspect `schema_migrations` — exactly one row with `version = 18`.

- [ ] **Step 4: Commit**

```bash
git add server/src/db/migrations.ts
git commit -m "feat(db): migration v18 — purchases table + 'purchased' status"
```

---

## Task 2: Update fresh-install schema in `schema.ts`

**Files:**
- Modify: `server/src/db/schema.ts`

- [ ] **Step 1: Extend the `trackers.status` CHECK**

Find:
```ts
status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'error', 'blocked')),
```
Change to:
```ts
status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'error', 'blocked', 'purchased')),
```

Leave `tracker_urls.status` unchanged.

- [ ] **Step 2: Append the `purchases` table to the fresh-install DDL**

Add the same DDL block from Task 1 to the existing `CREATE TABLE IF NOT EXISTS` group, after `notifications`.

- [ ] **Step 3: Verify a fresh DB matches the migrated DB**

```bash
cd server
rm -f /tmp/fresh.db && DATABASE_PATH=/tmp/fresh.db npm run db:setup
sqlite3 /tmp/fresh.db ".schema purchases"
sqlite3 /tmp/fresh.db ".schema trackers" | grep CHECK
```
Expected: `purchases` table present with both indexes; `trackers` CHECK includes `'purchased'`.

- [ ] **Step 4: Commit**

```bash
git add server/src/db/schema.ts
git commit -m "feat(db): purchases table in fresh-install schema"
```

---

## Task 3: TypeScript types — Purchase + extended TrackerStatus

**Files:**
- Modify: `server/src/db/queries.ts` (TS types near lines 31 and 110, plus aggStatus at 589)

- [ ] **Step 1: Extend the existing TrackerStatus unions**

Both occurrences read:
```ts
status: 'active' | 'paused' | 'error' | 'blocked';
```
Change to:
```ts
status: 'active' | 'paused' | 'error' | 'blocked' | 'purchased';
```
Also extend the `aggStatus` union the same way.

- [ ] **Step 2: Add Purchase types**

Append after the existing interface block in `queries.ts`:

```ts
export interface Purchase {
  id: number;
  tracker_id: number;
  tracker_url_id: number | null;
  purchase_price: number;
  quantity: number;
  first_price: number;
  purchased_at: string;
  created_at: string;
}

export interface PurchaseWithTracker extends Purchase {
  tracker_name: string;
  tracker_url: string;
  seller_label: string | null;
}

export interface PurchaseInput {
  purchase_price: number;
  quantity?: number;
  purchased_at?: string;
  tracker_url_id?: number | null;
}

export interface SavingsSummary {
  total_saved: number;
  purchase_count: number;
  since: string | null;
  monthly: Array<{ month: string; saved: number }>;
}

export function savingsForPurchase(p: Pick<Purchase, 'first_price' | 'purchase_price' | 'quantity'>): number {
  return Math.max(0, (p.first_price - p.purchase_price) * p.quantity);
}
```

- [ ] **Step 3: Build the server**

Run: `cd server && npm run build`
Expected: compiles clean. Fix downstream errors from the widened union with a no-op `case 'purchased':` branch in any `switch (status)` block whose function is purely about active scrape lifecycle.

- [ ] **Step 4: Commit**

```bash
git add server/src/db/queries.ts
git commit -m "feat(types): Purchase types and extend TrackerStatus with 'purchased'"
```

---

## Task 4: Purchase queries (TDD)

**Files:**
- Create: `server/src/db/queries.purchases.test.ts`
- Modify: `server/src/db/queries.ts`

- [ ] **Step 1: Write failing tests**

Mirror the harness used by `server/src/db/queries.project.test.ts` (in-memory DB, run migrations, seed a tracker, then test).

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { initTestDb } from './test-helpers.js';
import {
  createPurchase,
  listPurchases,
  getPurchase,
  updatePurchase,
  deletePurchase,
  getSavingsSummary,
  createTracker,
  addPriceHistory,
  getTrackerById,
} from './queries.js';

describe('purchase queries', () => {
  beforeEach(() => { initTestDb(); });

  describe('createPurchase', () => {
    it('snapshots first_price from earliest price_history row', () => {
      const t = createTracker({ url: 'https://example.com/a', user_id: 1, name: 'Widget' });
      addPriceHistory(t.id, null, 100, new Date('2026-01-01T00:00:00Z').toISOString());
      addPriceHistory(t.id, null, 80,  new Date('2026-02-01T00:00:00Z').toISOString());
      addPriceHistory(t.id, null, 60,  new Date('2026-03-01T00:00:00Z').toISOString());

      const p = createPurchase(t.id, { purchase_price: 50 }, { keep_watching: false });

      expect(p.first_price).toBe(100);
      expect(p.purchase_price).toBe(50);
      expect(p.quantity).toBe(1);
      expect(getTrackerById(t.id)?.status).toBe('purchased');
    });

    it('falls back to tracker.last_price when no price history exists', () => {
      const t = createTracker({ url: 'https://example.com/b', user_id: 1, name: 'NoHistory', last_price: 42 });
      const p = createPurchase(t.id, { purchase_price: 30 }, { keep_watching: false });
      expect(p.first_price).toBe(42);
    });

    it('last-resort first_price = purchase_price when no history and no last_price', () => {
      const t = createTracker({ url: 'https://example.com/c', user_id: 1, name: 'Empty' });
      const p = createPurchase(t.id, { purchase_price: 25 }, { keep_watching: false });
      expect(p.first_price).toBe(25);
    });

    it('leaves tracker active when keep_watching=true', () => {
      const t = createTracker({ url: 'https://example.com/d', user_id: 1, name: 'Repeat', last_price: 50 });
      createPurchase(t.id, { purchase_price: 40 }, { keep_watching: true });
      expect(getTrackerById(t.id)?.status).toBe('active');
    });

    it('appends a second purchase to an already-purchased tracker', () => {
      const t = createTracker({ url: 'https://example.com/e', user_id: 1, name: 'Multi', last_price: 50 });
      createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
      createPurchase(t.id, { purchase_price: 35 }, { keep_watching: false });
      const all = listPurchases({ user_id: 1 });
      expect(all.purchases.filter(p => p.tracker_id === t.id)).toHaveLength(2);
    });
  });

  describe('getSavingsSummary', () => {
    it('sums savings clamped at $0 for negative deltas', () => {
      const t = createTracker({ url: 'https://example.com/f', user_id: 1, name: 'Bad Deal', last_price: 50 });
      addPriceHistory(t.id, null, 100, new Date('2026-01-01').toISOString());
      createPurchase(t.id, { purchase_price: 120, quantity: 1 }, { keep_watching: false });
      const s = getSavingsSummary();
      expect(s.total_saved).toBe(0);
      expect(s.purchase_count).toBe(1);
    });

    it('multiplies savings by quantity', () => {
      const t = createTracker({ url: 'https://example.com/g', user_id: 1, name: 'Bulk', last_price: 100 });
      addPriceHistory(t.id, null, 100, new Date('2026-01-01').toISOString());
      createPurchase(t.id, { purchase_price: 50, quantity: 3 }, { keep_watching: false });
      const s = getSavingsSummary();
      expect(s.total_saved).toBe(150);
    });
  });

  describe('deletePurchase', () => {
    it('reverts tracker to active when deleting the only purchase', () => {
      const t = createTracker({ url: 'https://example.com/h', user_id: 1, name: 'Solo', last_price: 50 });
      const p = createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
      expect(getTrackerById(t.id)?.status).toBe('purchased');
      deletePurchase(p.id);
      expect(getTrackerById(t.id)?.status).toBe('active');
    });

    it('leaves tracker purchased when other purchases remain', () => {
      const t = createTracker({ url: 'https://example.com/i', user_id: 1, name: 'Many', last_price: 50 });
      createPurchase(t.id, { purchase_price: 45 }, { keep_watching: false });
      const second = createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
      deletePurchase(second.id);
      expect(getTrackerById(t.id)?.status).toBe('purchased');
    });
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd server && npm test -- --run queries.purchases`
Expected: ALL fail with "createPurchase is not a function" / similar.

- [ ] **Step 3: Implement the purchase query functions**

Append to `server/src/db/queries.ts`:

```ts
export function createPurchase(
  tracker_id: number,
  input: PurchaseInput,
  opts: { keep_watching: boolean },
): Purchase {
  const db = getDb();
  const tracker = getTrackerById(tracker_id);
  if (!tracker) throw new Error(`tracker not found: ${tracker_id}`);

  const earliest = db.prepare(
    `SELECT price FROM price_history WHERE tracker_id = ? ORDER BY recorded_at ASC LIMIT 1`,
  ).get(tracker_id) as { price: number } | undefined;
  let first_price: number;
  if (earliest) {
    first_price = earliest.price;
  } else if (tracker.last_price != null) {
    first_price = tracker.last_price;
  } else {
    first_price = input.purchase_price;
  }

  const purchased_at = input.purchased_at ?? new Date().toISOString();
  const quantity = input.quantity ?? 1;
  const tracker_url_id = input.tracker_url_id ?? null;

  const row = db.prepare(
    `INSERT INTO purchases (tracker_id, tracker_url_id, purchase_price, quantity, first_price, purchased_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
  ).get(tracker_id, tracker_url_id, input.purchase_price, quantity, first_price, purchased_at) as Purchase;

  const newStatus = opts.keep_watching ? 'active' : 'purchased';
  db.prepare(`UPDATE trackers SET status = ? WHERE id = ?`).run(newStatus, tracker_id);

  const saved = savingsForPurchase(row);
  logger.info({ tracker_id, purchase_id: row.id, saved, keep_watching: opts.keep_watching }, 'purchase_logged');

  return row;
}

export function getPurchase(id: number): Purchase | undefined {
  return getDb().prepare(`SELECT * FROM purchases WHERE id = ?`).get(id) as Purchase | undefined;
}

export function listPurchases(
  args: { user_id: number; limit?: number; offset?: number },
): { purchases: PurchaseWithTracker[]; total: number } {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const db = getDb();

  const rows = db.prepare(
    `SELECT p.*, t.name AS tracker_name, t.url AS tracker_url, tu.seller_label
     FROM purchases p
     JOIN trackers t ON t.id = p.tracker_id
     LEFT JOIN tracker_urls tu ON tu.id = p.tracker_url_id
     WHERE t.user_id = ?
     ORDER BY p.purchased_at DESC, p.id DESC
     LIMIT ? OFFSET ?`,
  ).all(args.user_id, limit, offset) as PurchaseWithTracker[];

  const { total } = db.prepare(
    `SELECT COUNT(*) AS total FROM purchases p JOIN trackers t ON t.id = p.tracker_id WHERE t.user_id = ?`,
  ).get(args.user_id) as { total: number };

  return { purchases: rows, total };
}

export function updatePurchase(
  id: number,
  patch: Partial<Pick<Purchase, 'purchase_price' | 'quantity' | 'purchased_at' | 'tracker_url_id'>>,
): Purchase {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.purchase_price !== undefined) { sets.push('purchase_price = ?'); values.push(patch.purchase_price); }
  if (patch.quantity       !== undefined) { sets.push('quantity = ?');       values.push(patch.quantity); }
  if (patch.purchased_at   !== undefined) { sets.push('purchased_at = ?');   values.push(patch.purchased_at); }
  if (patch.tracker_url_id !== undefined) { sets.push('tracker_url_id = ?'); values.push(patch.tracker_url_id); }
  if (sets.length === 0) return getPurchase(id)!;
  values.push(id);
  return db.prepare(`UPDATE purchases SET ${sets.join(', ')} WHERE id = ? RETURNING *`).get(...values) as Purchase;
}

export function deletePurchase(id: number): void {
  const db = getDb();
  const p = getPurchase(id);
  if (!p) return;
  db.prepare(`DELETE FROM purchases WHERE id = ?`).run(id);
  const remaining = db.prepare(
    `SELECT COUNT(*) AS n FROM purchases WHERE tracker_id = ?`,
  ).get(p.tracker_id) as { n: number };
  if (remaining.n === 0) {
    db.prepare(`UPDATE trackers SET status = 'active' WHERE id = ? AND status = 'purchased'`).run(p.tracker_id);
  }
}

export function getSavingsSummary(): SavingsSummary {
  const db = getDb();
  const rows = db.prepare(
    `SELECT first_price, purchase_price, quantity, purchased_at FROM purchases`,
  ).all() as Array<Pick<Purchase, 'first_price' | 'purchase_price' | 'quantity' | 'purchased_at'>>;

  let total_saved = 0;
  let earliest: string | null = null;
  const byMonth = new Map<string, number>();

  for (const r of rows) {
    const saved = savingsForPurchase(r);
    total_saved += saved;
    const month = r.purchased_at.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + saved);
    if (earliest === null || r.purchased_at < earliest) earliest = r.purchased_at;
  }

  const monthly = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, saved]) => ({ month, saved }));

  return {
    total_saved: Math.round(total_saved * 100) / 100,
    purchase_count: rows.length,
    since: earliest,
    monthly,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npm test -- --run queries.purchases`
Expected: all pass.

- [ ] **Step 5: Run full server suite**

Run: `cd server && npm test`
Expected: 123 baseline + ~10 new tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.purchases.test.ts
git commit -m "feat(db): purchase queries with snapshot first_price + savings summary"
```

---

## Task 5: Scheduler — exclude 'purchased' from scrape candidates

**Files:**
- Modify: `server/src/db/queries.ts` (`getDueTrackerUrls` at line 366)

- [ ] **Step 1: Add failing scheduler tests**

Append to `server/src/db/queries.purchases.test.ts`:

```ts
import { getDueTrackers, getDueTrackerUrls } from './queries.js';

describe('scheduler excludes purchased trackers', () => {
  it('getDueTrackers does not return purchased trackers', () => {
    const t = createTracker({ url: 'https://example.com/sched-a', user_id: 1, name: 'A', last_price: 50 });
    createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
    const due = getDueTrackers();
    expect(due.find(d => d.id === t.id)).toBeUndefined();
  });

  it('keep_watching trackers DO appear in due-list', () => {
    const t = createTracker({ url: 'https://example.com/sched-b', user_id: 1, name: 'B', last_price: 50 });
    createPurchase(t.id, { purchase_price: 40 }, { keep_watching: true });
    const due = getDueTrackers();
    expect(due.find(d => d.id === t.id)).toBeDefined();
  });

  it('getDueTrackerUrls excludes purchased trackers', () => {
    const t = createTracker({ url: 'https://example.com/sched-c', user_id: 1, name: 'C', last_price: 50 });
    createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
    const due = getDueTrackerUrls();
    expect(due.find(d => d.tracker_id === t.id)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests; `getDueTrackerUrls` should fail (the others may already pass)**

Run: `cd server && npm test -- --run queries.purchases`
Expected: `getDueTrackerUrls` test FAILS because that query only excludes `'paused'`. `getDueTrackers` may already pass (it uses `WHERE status = 'active'`).

- [ ] **Step 3: Update `getDueTrackerUrls`**

In `server/src/db/queries.ts:366`, change:
```sql
WHERE t.status != 'paused' AND tu.status NOT IN ('paused', 'blocked')
```
to:
```sql
WHERE t.status NOT IN ('paused', 'purchased') AND tu.status NOT IN ('paused', 'blocked')
```

- [ ] **Step 4: Run tests, verify pass**

Expected: all scheduler tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.purchases.test.ts
git commit -m "feat(scheduler): exclude 'purchased' trackers from scrape candidates"
```

---

## Task 6: POST /api/trackers/:id/purchases — auth'd endpoint

**Files:**
- Create: `server/src/routes/purchases.ts`
- Create: `server/src/routes/purchases.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write failing tests**

Mirror `server/src/routes/trackers.test.ts` structure. Use supertest if the project uses it; otherwise match the existing route-test pattern.

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from '../app.js';
import { initTestDb, seedUser, seedTracker, seedPriceHistory, authHeader } from '../test-helpers.js';

describe('POST /api/trackers/:id/purchases', () => {
  beforeEach(() => { initTestDb(); });

  it('creates a purchase, snapshots first_price, sets status=purchased', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, last_price: 50 });
    seedPriceHistory(tracker.id, [{ price: 100, at: '2026-01-01' }, { price: 80, at: '2026-02-01' }]);

    const res = await request(app)
      .post(`/api/trackers/${tracker.id}/purchases`)
      .set(authHeader(user))
      .send({ purchase_price: 40, quantity: 2 });

    expect(res.status).toBe(201);
    expect(res.body.purchase.first_price).toBe(100);
    expect(res.body.purchase.purchase_price).toBe(40);
    expect(res.body.purchase.quantity).toBe(2);
    expect(res.body.tracker.status).toBe('purchased');
  });

  it('keep_watching=true leaves tracker active', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, last_price: 50 });
    const res = await request(app)
      .post(`/api/trackers/${tracker.id}/purchases`)
      .set(authHeader(user))
      .send({ purchase_price: 40, keep_watching: true });
    expect(res.body.tracker.status).toBe('active');
  });

  it('defaults purchase_price to tracker.last_price', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, last_price: 73 });
    const res = await request(app)
      .post(`/api/trackers/${tracker.id}/purchases`)
      .set(authHeader(user))
      .send({});
    expect(res.body.purchase.purchase_price).toBe(73);
  });

  it('rejects 404 when tracker does not belong to the user', async () => {
    const app = buildApp();
    const owner = await seedUser({ email: 'owner@b.com' });
    const intruder = await seedUser({ email: 'evil@b.com' });
    const tracker = seedTracker({ user_id: owner.id });
    const res = await request(app)
      .post(`/api/trackers/${tracker.id}/purchases`)
      .set(authHeader(intruder))
      .send({ purchase_price: 10 });
    expect(res.status).toBe(404);
  });

  it('rejects 400 for negative purchase_price', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id });
    const res = await request(app)
      .post(`/api/trackers/${tracker.id}/purchases`)
      .set(authHeader(user))
      .send({ purchase_price: -5 });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run tests, verify failure.**

- [ ] **Step 3: Implement the route**

Create `server/src/routes/purchases.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthedRequest } from '../auth/middleware.js';
import {
  createPurchase,
  getTrackerById,
  listPurchases,
  getPurchase,
  updatePurchase,
  deletePurchase,
} from '../db/queries.js';

export const purchasesRouter = Router();

const createSchema = z.object({
  purchase_price: z.number().nonnegative().optional(),
  quantity: z.number().int().min(1).optional(),
  purchased_at: z.string().datetime().optional(),
  tracker_url_id: z.number().int().nullable().optional(),
  keep_watching: z.boolean().optional(),
});

purchasesRouter.post('/api/trackers/:id/purchases', requireAuth, (req: AuthedRequest, res) => {
  const tracker_id = Number(req.params.id);
  const tracker = getTrackerById(tracker_id);
  if (!tracker || tracker.user_id !== req.user.id) {
    return res.status(404).json({ error: 'tracker not found' });
  }
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', details: parsed.error.format() });
  }
  const purchase_price = parsed.data.purchase_price ?? tracker.last_price;
  if (purchase_price == null) {
    return res.status(400).json({ error: 'purchase_price required when tracker has no last_price' });
  }
  const purchase = createPurchase(
    tracker_id,
    {
      purchase_price,
      quantity: parsed.data.quantity,
      purchased_at: parsed.data.purchased_at,
      tracker_url_id: parsed.data.tracker_url_id ?? null,
    },
    { keep_watching: parsed.data.keep_watching === true },
  );
  const updatedTracker = getTrackerById(tracker_id)!;
  res.status(201).json({ purchase, tracker: updatedTracker });
});
```

(Use the project's actual auth middleware import path — adjust `'../auth/middleware.js'` if different.)

- [ ] **Step 4: Mount in `server/src/index.ts`**

Find where other routers are mounted and add:
```ts
import { purchasesRouter } from './routes/purchases.js';
app.use(purchasesRouter);
```

- [ ] **Step 5: Run tests, verify pass.**

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/purchases.ts server/src/routes/purchases.test.ts server/src/index.ts
git commit -m "feat(api): POST /api/trackers/:id/purchases"
```

---

## Task 7: GET /api/purchases (list, auth'd)

**Files:**
- Modify: `server/src/routes/purchases.ts`, `server/src/routes/purchases.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `server/src/routes/purchases.test.ts`:

```ts
describe('GET /api/purchases', () => {
  it('returns purchases for the authed user, newest first', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, last_price: 50 });
    await request(app).post(`/api/trackers/${tracker.id}/purchases`).set(authHeader(user)).send({ purchase_price: 45 });
    await request(app).post(`/api/trackers/${tracker.id}/purchases`).set(authHeader(user)).send({ purchase_price: 40 });
    const res = await request(app).get('/api/purchases').set(authHeader(user));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.purchases[0].purchase_price).toBe(40);
  });

  it("does not return another user's purchases", async () => {
    const app = buildApp();
    const a = await seedUser({ email: 'a@b.com' });
    const b = await seedUser({ email: 'b@b.com' });
    const tA = seedTracker({ user_id: a.id, last_price: 50 });
    await request(app).post(`/api/trackers/${tA.id}/purchases`).set(authHeader(a)).send({ purchase_price: 40 });
    const res = await request(app).get('/api/purchases').set(authHeader(b));
    expect(res.body.purchases).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests, verify failure.**

- [ ] **Step 3: Implement**

Append to `server/src/routes/purchases.ts`:

```ts
purchasesRouter.get('/api/purchases', requireAuth, (req: AuthedRequest, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50), 500);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  res.json(listPurchases({ user_id: req.user.id, limit, offset }));
});
```

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/purchases.ts server/src/routes/purchases.test.ts
git commit -m "feat(api): GET /api/purchases list endpoint"
```

---

## Task 8: PATCH /api/purchases/:id (edit, auth'd)

**Files:**
- Modify: `server/src/routes/purchases.ts`, `server/src/routes/purchases.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe('PATCH /api/purchases/:id', () => {
  it('updates price and quantity', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, last_price: 50 });
    const created = await request(app).post(`/api/trackers/${tracker.id}/purchases`).set(authHeader(user)).send({ purchase_price: 40 });
    const id = created.body.purchase.id;
    const res = await request(app).patch(`/api/purchases/${id}`).set(authHeader(user)).send({ purchase_price: 35, quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body.purchase.purchase_price).toBe(35);
    expect(res.body.purchase.quantity).toBe(2);
  });

  it('rejects 404 when the purchase belongs to another user', async () => {
    const app = buildApp();
    const a = await seedUser({ email: 'a@b.com' });
    const b = await seedUser({ email: 'b@b.com' });
    const tA = seedTracker({ user_id: a.id, last_price: 50 });
    const created = await request(app).post(`/api/trackers/${tA.id}/purchases`).set(authHeader(a)).send({ purchase_price: 40 });
    const res = await request(app).patch(`/api/purchases/${created.body.purchase.id}`).set(authHeader(b)).send({ purchase_price: 1 });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests, verify failure.**

- [ ] **Step 3: Implement**

Append to `server/src/routes/purchases.ts`:

```ts
const patchSchema = z.object({
  purchase_price: z.number().nonnegative().optional(),
  quantity: z.number().int().min(1).optional(),
  purchased_at: z.string().datetime().optional(),
  tracker_url_id: z.number().int().nullable().optional(),
});

purchasesRouter.patch('/api/purchases/:id', requireAuth, (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = getPurchase(id);
  if (!existing) return res.status(404).json({ error: 'purchase not found' });
  const tracker = getTrackerById(existing.tracker_id);
  if (!tracker || tracker.user_id !== req.user.id) return res.status(404).json({ error: 'purchase not found' });
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid body', details: parsed.error.format() });
  const updated = updatePurchase(id, parsed.data);
  res.json({ purchase: updated });
});
```

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/purchases.ts server/src/routes/purchases.test.ts
git commit -m "feat(api): PATCH /api/purchases/:id"
```

---

## Task 9: DELETE /api/purchases/:id (with auto re-activate)

**Files:**
- Modify: `server/src/routes/purchases.ts`, `server/src/routes/purchases.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
describe('DELETE /api/purchases/:id', () => {
  it('removes the purchase and re-activates the tracker if it was the last one', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, last_price: 50 });
    const created = await request(app).post(`/api/trackers/${tracker.id}/purchases`).set(authHeader(user)).send({ purchase_price: 40 });
    expect(created.body.tracker.status).toBe('purchased');

    const del = await request(app).delete(`/api/purchases/${created.body.purchase.id}`).set(authHeader(user));
    expect(del.status).toBe(200);
    expect(del.body.tracker.status).toBe('active');
  });

  it('keeps tracker purchased if other purchases remain', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, last_price: 50 });
    await request(app).post(`/api/trackers/${tracker.id}/purchases`).set(authHeader(user)).send({ purchase_price: 45 });
    const second = await request(app).post(`/api/trackers/${tracker.id}/purchases`).set(authHeader(user)).send({ purchase_price: 40 });
    const del = await request(app).delete(`/api/purchases/${second.body.purchase.id}`).set(authHeader(user));
    expect(del.body.tracker.status).toBe('purchased');
  });
});
```

- [ ] **Step 2: Run tests, verify failure.**

- [ ] **Step 3: Implement**

```ts
purchasesRouter.delete('/api/purchases/:id', requireAuth, (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = getPurchase(id);
  if (!existing) return res.status(404).json({ error: 'purchase not found' });
  const tracker = getTrackerById(existing.tracker_id);
  if (!tracker || tracker.user_id !== req.user.id) return res.status(404).json({ error: 'purchase not found' });
  deletePurchase(id);
  const updatedTracker = getTrackerById(existing.tracker_id)!;
  res.json({ ok: true, tracker: updatedTracker });
});
```

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/purchases.ts server/src/routes/purchases.test.ts
git commit -m "feat(api): DELETE /api/purchases/:id with auto re-activate"
```

---

## Task 10: GET /api/public/savings (public, no auth)

**Files:**
- Create: `server/src/routes/public-savings.ts`
- Create: `server/src/routes/public-savings.test.ts`
- Modify: `server/src/index.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from '../app.js';
import { initTestDb, seedUser, seedTracker, seedPriceHistory } from '../test-helpers.js';
import { createPurchase } from '../db/queries.js';

describe('GET /api/public/savings', () => {
  beforeEach(() => { initTestDb(); });

  it('returns aggregate without requiring auth', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, last_price: 50 });
    seedPriceHistory(tracker.id, [{ price: 100, at: '2026-01-01T00:00:00Z' }]);
    createPurchase(tracker.id, { purchase_price: 40, quantity: 2 }, { keep_watching: false });

    const res = await request(app).get('/api/public/savings');
    expect(res.status).toBe(200);
    expect(res.body.total_saved).toBe(120);
    expect(res.body.purchase_count).toBe(1);
    expect(res.body.since).toMatch(/^2026-/);
    expect(Array.isArray(res.body.monthly)).toBe(true);
  });

  it('payload contains no product or retailer fields', async () => {
    const app = buildApp();
    const user = await seedUser({ email: 'a@b.com' });
    const tracker = seedTracker({ user_id: user.id, name: 'Secret Widget', url: 'https://supersecret.example/abc', last_price: 50 });
    createPurchase(tracker.id, { purchase_price: 40 }, { keep_watching: false });

    const res = await request(app).get('/api/public/savings');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Secret Widget');
    expect(body).not.toContain('supersecret');
  });

  it('returns zeros when no purchases exist', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/public/savings');
    expect(res.status).toBe(200);
    expect(res.body.total_saved).toBe(0);
    expect(res.body.purchase_count).toBe(0);
    expect(res.body.since).toBeNull();
    expect(res.body.monthly).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, verify failure.**

- [ ] **Step 3: Implement**

Create `server/src/routes/public-savings.ts`:

```ts
import { Router } from 'express';
import { getSavingsSummary } from '../db/queries.js';

export const publicSavingsRouter = Router();

publicSavingsRouter.get('/api/public/savings', (_req, res) => {
  res.json(getSavingsSummary());
});
```

Mount in `server/src/index.ts` alongside other public routers:
```ts
import { publicSavingsRouter } from './routes/public-savings.js';
app.use(publicSavingsRouter);
```

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Manual smoke**

```bash
cd server && npm run dev &
sleep 3
curl -s http://localhost:3100/api/public/savings | jq
```
Expected: matches the documented shape; no product/retailer fields.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/public-savings.ts server/src/routes/public-savings.test.ts server/src/index.ts
git commit -m "feat(api): public GET /api/public/savings (no PII)"
```

---

## Task 11: Client — types + API methods

**Files:**
- Modify: `client/src/types.ts`, `client/src/api.ts`

- [ ] **Step 1: Extend types**

In `client/src/types.ts`, find the existing tracker status union and extend it (mirror server-side). Add:

```ts
export type TrackerStatus = 'active' | 'paused' | 'error' | 'blocked' | 'purchased';

export interface Purchase {
  id: number;
  tracker_id: number;
  tracker_url_id: number | null;
  purchase_price: number;
  quantity: number;
  first_price: number;
  purchased_at: string;
  created_at: string;
}

export interface PurchaseWithTracker extends Purchase {
  tracker_name: string;
  tracker_url: string;
  seller_label: string | null;
}

export interface SavingsSummary {
  total_saved: number;
  purchase_count: number;
  since: string | null;
  monthly: Array<{ month: string; saved: number }>;
}

export function savedAmount(p: Pick<Purchase, 'first_price' | 'purchase_price' | 'quantity'>): number {
  return Math.max(0, (p.first_price - p.purchase_price) * p.quantity);
}
```

- [ ] **Step 2: Add API methods**

In `client/src/api.ts`, append (use the project's existing `apiFetch` helper — do NOT introduce a new client; match the import path used by sibling methods):

```ts
export async function createPurchase(
  trackerId: number,
  body: { purchase_price?: number; quantity?: number; purchased_at?: string; tracker_url_id?: number | null; keep_watching?: boolean },
): Promise<{ purchase: Purchase; tracker: Tracker }> {
  return apiFetch(`/api/trackers/${trackerId}/purchases`, { method: 'POST', body: JSON.stringify(body) });
}

export async function listPurchases(params: { limit?: number; offset?: number } = {}): Promise<{ purchases: PurchaseWithTracker[]; total: number }> {
  const q = new URLSearchParams();
  if (params.limit  !== undefined) q.set('limit',  String(params.limit));
  if (params.offset !== undefined) q.set('offset', String(params.offset));
  const qs = q.toString();
  return apiFetch(`/api/purchases${qs ? '?' + qs : ''}`);
}

export async function patchPurchase(
  id: number,
  body: { purchase_price?: number; quantity?: number; purchased_at?: string; tracker_url_id?: number | null },
): Promise<{ purchase: Purchase }> {
  return apiFetch(`/api/purchases/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
}

export async function deletePurchase(id: number): Promise<{ ok: true; tracker: Tracker }> {
  return apiFetch(`/api/purchases/${id}`, { method: 'DELETE' });
}

export async function getPublicSavings(): Promise<SavingsSummary> {
  return apiFetch('/api/public/savings');
}
```

- [ ] **Step 3: Build the client**

Run: `cd client && npm run build`
Expected: clean TS build. Fix any unions broken by the new `'purchased'` value (likely StatusBadge or Dashboard filter switches).

- [ ] **Step 4: Commit**

```bash
git add client/src/types.ts client/src/api.ts
git commit -m "feat(client): purchase + savings types and API methods"
```

---

## Task 12: PurchaseModal component (TDD)

**Files:**
- Create: `client/src/components/PurchaseModal.tsx`, `client/src/components/PurchaseModal.test.tsx`

- [ ] **Step 1: Write failing tests**

Mirror the testing-library + vitest pattern from `client/src/components/WelcomeModal.test.tsx`.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PurchaseModal from './PurchaseModal';

const tracker = {
  id: 1, name: 'Widget', url: 'https://e.com', last_price: 47.99,
} as any;

describe('PurchaseModal', () => {
  it('prefills price with tracker.last_price', () => {
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={() => Promise.resolve()} />);
    const priceInput = screen.getByLabelText(/price paid/i) as HTMLInputElement;
    expect(priceInput.value).toBe('47.99');
  });

  it('shows live estimated savings based on price × quantity', () => {
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={() => Promise.resolve()} />);
    expect(screen.getByText(/estimated savings/i).textContent).toMatch(/\$32\.00/);
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '2' } });
    expect(screen.getByText(/estimated savings/i).textContent).toMatch(/\$64\.00/);
  });

  it('clamps savings at $0 when price exceeds first_price', () => {
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={() => Promise.resolve()} />);
    fireEvent.change(screen.getByLabelText(/price paid/i), { target: { value: '100' } });
    expect(screen.getByText(/estimated savings/i).textContent).toMatch(/\$0\.00/);
  });

  it('calls onSubmit with form values including keep_watching', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText(/keep watching/i));
    fireEvent.click(screen.getByText(/confirm purchase/i));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      purchase_price: 47.99, quantity: 1, keep_watching: true,
    }));
  });
});
```

- [ ] **Step 2: Run tests, verify failure.**

- [ ] **Step 3: Implement the modal**

```tsx
import { useMemo, useState } from 'react';
import type { Tracker } from '../types';

type Props = {
  tracker: Tracker;
  firstPrice: number;
  sellers?: Array<{ id: number; label: string }>;
  onClose: () => void;
  onSubmit: (values: {
    purchase_price: number;
    quantity: number;
    purchased_at: string;
    tracker_url_id: number | null;
    keep_watching: boolean;
  }) => Promise<void>;
};

export default function PurchaseModal({ tracker, firstPrice, sellers, onClose, onSubmit }: Props) {
  const [price, setPrice] = useState(tracker.last_price ?? 0);
  const [qty, setQty] = useState(1);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [sellerId, setSellerId] = useState<number | null>(sellers?.[0]?.id ?? null);
  const [keepWatching, setKeepWatching] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const estimated = useMemo(() => Math.max(0, (firstPrice - price) * qty), [firstPrice, price, qty]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit({
        purchase_price: price,
        quantity: qty,
        purchased_at: new Date(date).toISOString(),
        tracker_url_id: sellerId,
        keep_watching: keepWatching,
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form onSubmit={submit} className="bg-bg-card p-6 rounded-lg w-96" onClick={e => e.stopPropagation()}>
        <h2 className="text-xl font-semibold mb-4">Log Purchase</h2>

        <label className="block text-sm mb-1">Price paid
          <input type="number" step="0.01" min="0" required value={price}
                 onChange={e => setPrice(Number(e.target.value))}
                 aria-label="price paid"
                 className="w-full mt-1 px-2 py-1 bg-bg-input rounded" />
        </label>

        <label className="block text-sm mt-3 mb-1">Quantity
          <input type="number" min="1" step="1" value={qty}
                 onChange={e => setQty(Math.max(1, Number(e.target.value)))}
                 aria-label="quantity"
                 className="w-full mt-1 px-2 py-1 bg-bg-input rounded" />
        </label>

        <label className="block text-sm mt-3 mb-1">Date
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
                 aria-label="date" className="w-full mt-1 px-2 py-1 bg-bg-input rounded" />
        </label>

        {sellers && sellers.length > 1 && (
          <label className="block text-sm mt-3 mb-1">Seller
            <select value={sellerId ?? ''} onChange={e => setSellerId(Number(e.target.value))}
                    className="w-full mt-1 px-2 py-1 bg-bg-input rounded">
              {sellers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        )}

        <div className="mt-4 text-sm">
          Estimated savings: <span className="font-semibold">${estimated.toFixed(2)}</span>
        </div>

        <label className="flex items-center gap-2 mt-3 text-sm">
          <input type="checkbox" checked={keepWatching} onChange={e => setKeepWatching(e.target.checked)} aria-label="keep watching" />
          Keep watching after purchase
        </label>

        <div className="flex gap-2 mt-5 justify-end">
          <button type="button" onClick={onClose} className="px-3 py-1 text-sm">Cancel</button>
          <button type="submit" disabled={submitting} className="px-3 py-1 bg-accent rounded text-sm">
            {submitting ? 'Saving…' : 'Confirm Purchase'}
          </button>
        </div>
      </form>
    </div>
  );
}
```

Style classes — match the project's Tailwind tokens (`bg-bg-card`, `bg-accent`, etc.). If a shared `<Modal>` shell exists (check `WelcomeModal.tsx`), use it.

- [ ] **Step 4: Run tests, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add client/src/components/PurchaseModal.tsx client/src/components/PurchaseModal.test.tsx
git commit -m "feat(client): PurchaseModal with live savings estimate"
```

---

## Task 13: TrackerDetail — button + banner

**Files:**
- Create: `client/src/components/PurchasedBanner.tsx`
- Modify: `client/src/pages/TrackerDetail.tsx`

- [ ] **Step 1: Create the PurchasedBanner**

```tsx
import type { Purchase } from '../types';
import { savedAmount } from '../types';

export default function PurchasedBanner({ purchase, totalPurchases, onViewAll }: {
  purchase: Purchase;
  totalPurchases: number;
  onViewAll?: () => void;
}) {
  const saved = savedAmount(purchase);
  const date = new Date(purchase.purchased_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="bg-green-900/30 border border-green-700 rounded-md px-4 py-3 mb-4 flex items-center justify-between">
      <div className="text-sm">
        ✓ Purchased on {date} — saved <span className="font-semibold">${saved.toFixed(2)}</span> ({purchase.quantity} × ${purchase.purchase_price.toFixed(2)})
      </div>
      {totalPurchases > 1 && (
        <button onClick={onViewAll} className="text-xs underline text-green-300">View all {totalPurchases} purchases</button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire into TrackerDetail**

In `client/src/pages/TrackerDetail.tsx`:

1. Add state and load purchases:
```tsx
const [showPurchaseModal, setShowPurchaseModal] = useState(false);
const [purchases, setPurchases] = useState<Purchase[]>([]);
// Load on mount via listPurchases (filter client-side by tracker.id) or
// add a per-tracker server query in a follow-up.
```

2. Derive firstPrice from price history (earliest record) or fall back to `tracker.last_price`:
```tsx
const firstPrice = priceHistory.length > 0 ? priceHistory[0].price : (tracker.last_price ?? 0);
```

3. In the actions row (next to Edit / Pause / Delete), add:
```tsx
<button onClick={() => setShowPurchaseModal(true)}
        className="px-3 py-1 bg-green-700 hover:bg-green-600 rounded text-sm">
  {purchases.length > 0 ? 'Log Another Purchase' : 'Purchased'}
</button>
```

4. Above the price chart, render the banner when `tracker.status === 'purchased'`:
```tsx
{tracker.status === 'purchased' && purchases[0] && (
  <PurchasedBanner
    purchase={purchases[0]}
    totalPurchases={purchases.length}
    onViewAll={() => navigate(`/purchased?tracker=${tracker.id}`)}
  />
)}
```

5. Render the modal when open:
```tsx
{showPurchaseModal && (
  <PurchaseModal
    tracker={tracker}
    firstPrice={firstPrice}
    sellers={trackerUrls.map(u => ({ id: u.id, label: u.seller_label ?? 'Default' }))}
    onClose={() => setShowPurchaseModal(false)}
    onSubmit={async (values) => {
      const { purchase, tracker: updated } = await createPurchase(tracker.id, values);
      setPurchases([purchase, ...purchases]);
      setTracker(updated);
      toast.success(`Purchase logged — saved $${savedAmount(purchase).toFixed(2)}`);
    }}
  />
)}
```

(Use the project's actual toast mechanism — match the pattern used in TrackerCard or Dashboard.)

- [ ] **Step 3: Manual exercise**

```bash
cd server && npm run dev &
cd client && npm run dev &
# Open the local URL, log a purchase
```
Verify: modal opens, savings updates live, submit closes the modal, banner appears, tracker disappears from dashboard.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/PurchasedBanner.tsx client/src/pages/TrackerDetail.tsx
git commit -m "feat(client): Purchased button + banner on tracker detail"
```

---

## Task 14: Dashboard — "Show purchased" toggle

**Files:**
- Modify: `client/src/pages/Dashboard.tsx`, `client/src/components/TrackerCard.tsx`

- [ ] **Step 1: Filter purchased trackers out by default**

Find where the tracker list is rendered. Add:

```tsx
const [showPurchased, setShowPurchased] = useState(false);
const visibleTrackers = useMemo(
  () => trackers.filter(t => showPurchased ? true : t.status !== 'purchased'),
  [trackers, showPurchased],
);
```

Render the toggle near the existing filter bar:
```tsx
<label className="flex items-center gap-2 text-sm text-text-muted">
  <input type="checkbox" checked={showPurchased} onChange={e => setShowPurchased(e.target.checked)} />
  Show purchased
</label>
```

When `showPurchased` is on, pass an `isPurchased` prop to TrackerCard and apply muted styling (reduced opacity + ✓ icon).

- [ ] **Step 2: Manual smoke**

Verify: dashboard hides purchased trackers by default; toggle on shows them with muted styling; toggle off hides them again.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Dashboard.tsx client/src/components/TrackerCard.tsx
git commit -m "feat(client): hide purchased trackers by default with show-purchased toggle"
```

---

## Task 15: /purchased admin page (TDD)

**Files:**
- Create: `client/src/pages/Purchased.tsx`, `client/src/pages/Purchased.test.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Purchased from './Purchased';
import * as api from '../api';

vi.mock('../api');

describe('Purchased admin page', () => {
  it('renders header stats and purchase rows', async () => {
    vi.mocked(api.listPurchases).mockResolvedValue({
      purchases: [{
        id: 1, tracker_id: 1, tracker_name: 'Widget', tracker_url: 'https://e.com', seller_label: 'Amazon',
        purchase_price: 40, first_price: 100, quantity: 2,
        purchased_at: '2026-05-12T00:00:00Z', created_at: '2026-05-12T00:00:00Z', tracker_url_id: null,
      }],
      total: 1,
    });
    render(<MemoryRouter><Purchased /></MemoryRouter>);
    await waitFor(() => screen.getByText('Widget'));
    expect(screen.getByText(/\$120\.00/)).toBeInTheDocument();
    expect(screen.getByText(/TOTAL SAVED/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests, verify failure.**

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listPurchases, deletePurchase as apiDeletePurchase } from '../api';
import type { PurchaseWithTracker } from '../types';
import { savedAmount } from '../types';

export default function Purchased() {
  const [rows, setRows] = useState<PurchaseWithTracker[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { listPurchases({ limit: 200 }).then(r => { setRows(r.purchases); setLoading(false); }); }, []);

  if (loading) return <div>Loading…</div>;

  const totalSaved = rows.reduce((acc, r) => acc + savedAmount(r), 0);
  const avg = rows.length === 0 ? 0 : totalSaved / rows.length;

  async function onDelete(id: number) {
    if (!confirm('Delete this purchase? Tracker status will be restored if this was its only purchase.')) return;
    await apiDeletePurchase(id);
    setRows(rows.filter(r => r.id !== id));
  }

  return (
    <div className="max-w-6xl mx-auto p-4">
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Stat label="TOTAL SAVED" value={`$${totalSaved.toFixed(2)}`} />
        <Stat label="PURCHASES" value={String(rows.length)} />
        <Stat label="AVG PER PURCHASE" value={`$${avg.toFixed(2)}`} />
      </div>
      <table className="w-full text-sm">
        <thead><tr className="text-text-muted">
          <th>Product</th><th>Seller</th><th>Paid</th><th>First seen</th><th>Saved</th><th>Qty</th><th>Date</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className="border-t border-bg-border">
              <td><Link to={`/tracker/${r.tracker_id}`} className="underline">{r.tracker_name}</Link></td>
              <td>{r.seller_label ?? '—'}</td>
              <td>${r.purchase_price.toFixed(2)}</td>
              <td>${r.first_price.toFixed(2)}</td>
              <td>${savedAmount(r).toFixed(2)}</td>
              <td>{r.quantity}</td>
              <td>{new Date(r.purchased_at).toLocaleDateString()}</td>
              <td><button onClick={() => onDelete(r.id)} className="text-xs underline text-red-300">delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-card p-4 rounded-md">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}
```

(Inline edit can be deferred to a follow-up; delete is in this task.)

- [ ] **Step 4: Register route + nav link in `App.tsx`**

In the lazy imports:
```tsx
const Purchased = lazy(() => import('./pages/Purchased'));
```
In the protected routes block:
```tsx
<Route path="/purchased" element={<ProtectedRoute><Purchased /></ProtectedRoute>} />
```
Add a nav link near the existing `/projects` link, using a `lucide-react` icon (`Package` is already imported).

- [ ] **Step 5: Run tests + manual smoke**

```bash
cd client && npm test -- --run Purchased
cd client && npm run dev   # browse to /purchased
```

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Purchased.tsx client/src/pages/Purchased.test.tsx client/src/App.tsx
git commit -m "feat(client): /purchased admin page with totals and delete"
```

---

## Task 16: Footer savings line

**Files:**
- Modify: `client/src/components/AffiliateDisclosure.tsx`

- [ ] **Step 1: Add a SavingsLine sub-component inside the existing footer**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getPublicSavings } from '../api';
import type { SavingsSummary } from '../types';

function SavingsLine() {
  const [data, setData] = useState<SavingsSummary | null>(null);
  useEffect(() => { getPublicSavings().then(setData).catch(() => {}); }, []);
  if (!data || data.total_saved <= 0 || !data.since) return null;

  const sinceLabel = new Date(data.since).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  return (
    <div className="text-xs text-text-muted mb-2">
      <Link to="/savings" className="hover:underline">
        Saved ${data.total_saved.toFixed(2)} since {sinceLabel} →
      </Link>
    </div>
  );
}
```

Render `<SavingsLine />` above the affiliate disclosure paragraph inside the same `<footer>` element.

- [ ] **Step 2: Manual smoke**

Verify footer line shows on logged-in and public pages, links to `/savings`, hides cleanly when there are no purchases.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/AffiliateDisclosure.tsx
git commit -m "feat(client): footer savings line linking to /savings"
```

---

## Task 17: /savings public page

**Files:**
- Create: `client/src/pages/Savings.tsx`, `client/src/pages/Savings.test.tsx`
- Modify: `client/src/App.tsx`

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Savings from './Savings';
import * as api from '../api';

vi.mock('../api');

describe('Savings public page', () => {
  it('renders the hero number from the public endpoint', async () => {
    vi.mocked(api.getPublicSavings).mockResolvedValue({
      total_saved: 1247.83, purchase_count: 23, since: '2026-04-01T00:00:00Z',
      monthly: [{ month: '2026-04', saved: 200 }, { month: '2026-05', saved: 1047.83 }],
    });
    render(<MemoryRouter><Savings /></MemoryRouter>);
    await waitFor(() => screen.getByText(/\$1,247\.83/));
    expect(screen.getByText(/23 purchases/i)).toBeInTheDocument();
  });

  it('renders gracefully when no purchases exist', async () => {
    vi.mocked(api.getPublicSavings).mockResolvedValue({
      total_saved: 0, purchase_count: 0, since: null, monthly: [],
    });
    render(<MemoryRouter><Savings /></MemoryRouter>);
    await waitFor(() => screen.getByText(/no purchases yet/i));
  });
});
```

- [ ] **Step 2: Run tests, verify failure.**

- [ ] **Step 3: Implement**

```tsx
import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { getPublicSavings } from '../api';
import type { SavingsSummary } from '../types';

export default function Savings() {
  const [data, setData] = useState<SavingsSummary | null>(null);
  useEffect(() => { getPublicSavings().then(setData); }, []);
  if (!data) return <div className="p-8">Loading…</div>;

  if (data.purchase_count === 0) {
    return <div className="max-w-3xl mx-auto p-8 text-center text-text-muted">No purchases yet — check back soon.</div>;
  }

  const since = new Date(data.since!).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  let running = 0;
  const series = data.monthly.map(m => ({ month: m.month, cumulative: (running += m.saved) }));

  return (
    <div className="max-w-3xl mx-auto p-8 text-center">
      <div className="text-6xl font-semibold">
        ${data.total_saved.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
      </div>
      <div className="text-text-muted mt-2">saved across {data.purchase_count} purchases since {since}</div>

      <div className="mt-10 h-64">
        <ResponsiveContainer>
          <AreaChart data={series}>
            <XAxis dataKey="month" />
            <YAxis />
            <Tooltip formatter={(v: number) => `$${v.toFixed(2)}`} />
            <Area type="monotone" dataKey="cumulative" stroke="#22c55e" fill="#22c55e33" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Register the route and mark it public in `App.tsx`**

```tsx
const Savings = lazy(() => import('./pages/Savings'));
```

Extend the public prefix list:
```tsx
const PUBLIC_PATH_PREFIXES = ['/login', '/register', '/setup', '/p/', '/deals', '/wishlist/', '/savings'];
```

Inside the public routes block:
```tsx
<Route path="/savings" element={<Savings />} />
```

- [ ] **Step 5: Run tests + manual smoke (logged-out browser).**

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/Savings.tsx client/src/pages/Savings.test.tsx client/src/App.tsx
git commit -m "feat(client): /savings public page with cumulative sparkline"
```

---

## Task 18: Full verification + PR

- [ ] **Step 1: Full server test suite**

Run: `cd server && npm test`
Expected: ~135 tests pass (123 baseline + ~12 new).

- [ ] **Step 2: Full client test suite**

Run: `cd client && npm test`
Expected: ~67 tests pass (61 baseline + ~6 new).

- [ ] **Step 3: Type-check both sides**

Run: `cd server && npm run build && cd ../client && npm run build`
Expected: zero TS errors, zero warnings.

- [ ] **Step 4: Manual exercise checklist**

From a fresh `npm run dev` on both sides:
- Log a purchase (default keep_watching=false) → tracker disappears from dashboard, banner appears on detail
- Log a "keep watching" purchase on another tracker → tracker stays on dashboard, banner still shows
- Open `/purchased` → both purchases listed with correct savings math
- Delete the keep-watching purchase → tracker re-activates if it was the only one
- View `/savings` from a logged-out browser → hero number matches `/purchased` total
- `curl http://localhost:3100/api/public/savings | jq` → confirm shape, no product/retailer names
- Log a purchase on a tracker with no `price_history` → savings = $0, no crash
- Restart the server → migrations idempotent, app starts clean

- [ ] **Step 5: Push & open PR**

```bash
git push -u origin feature/purchased-tracking
gh pr create --title "feat: purchased tracking + savings rollup" --body "$(cat <<'EOF'
## Summary
- Adds "Purchased" button on tracker detail with editable price/qty/date/seller modal
- New purchases table (many-to-one with trackers), 'purchased' tracker status
- Admin /purchased page with totals + per-purchase log
- Public footer line + /savings page with cumulative sparkline (no PII)
- Migration v18 widens trackers.status CHECK and creates purchases table

## Test plan
- [x] Server suite (~135 tests, all pass)
- [x] Client suite (~67 tests, all pass)
- [x] Type-check passes both sides
- [x] Manual exercise (purchase, keep_watching, delete, public endpoint, no-history fallback)

Spec: docs/superpowers/specs/2026-05-20-purchased-tracking-design.md
Plan: docs/superpowers/plans/2026-05-20-purchased-tracking.md

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Deploy after merge**

```bash
bash scripts/deploy.sh
```

Verify on CT 302:
- `/api/public/savings` returns expected JSON
- Migration v18 logged once in the server journal
- Footer line shows on `prices.schultzsolutions.tech`
- `/savings` loads from a logged-out browser
