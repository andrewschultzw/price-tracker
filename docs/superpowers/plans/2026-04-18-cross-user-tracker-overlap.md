# Cross-User Tracker Overlap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface cross-user overlap on shared trackers — anonymous count always, opt-in names, anonymous community low (min price), via a `normalized_url` column + new API endpoints + dashboard pill + detail card.

**Architecture:** Server-side URL normalization (pure helper), stored as a new indexed column on `trackers`. Migration v6 adds the column and backfills. Normalization runs at tracker create and at every successful primary-seller scrape (so short-link resolutions from Playwright's final URL update the key). Two read endpoints power the UI: one per-tracker detail payload and one batch counts endpoint for the dashboard.

**Tech Stack:** better-sqlite3, Express, React 19, Vite, Tailwind, vitest.

**Spec:** `docs/superpowers/specs/2026-04-18-cross-user-tracker-overlap-design.md`

**Branch:** `feature/cross-user-tracker-overlap` (spec commit already present).

---

## Task 1: URL normalization helper + test

**Files:**
- Create: `server/src/lib/domains.ts` (mirror of `client/src/lib/domains.ts`)
- Create: `server/src/lib/normalize-url.ts`
- Create: `server/src/lib/normalize-url.test.ts`

- [ ] **Step 1: Copy the domain-alias helper into the server lib**

Create `server/src/lib/domains.ts` with the same content as `client/src/lib/domains.ts`. Add a comment at the top noting it's a mirror — the canonical domain list changes rarely and the duplication is preferable to introducing a shared package just for one file.

```typescript
// MIRROR of client/src/lib/domains.ts. Keep these two files in sync when
// adding retailer aliases. A future refactor could hoist to a shared
// package; for now the cost of duplication is a single list update and
// the benefit is zero build/tooling changes.

const ALIASES: Record<string, string> = {
  // Amazon
  'amazon.com': 'amazon.com',
  'a.co': 'amazon.com',
  'amzn.to': 'amazon.com',
  'amzn.com': 'amazon.com',
  'smile.amazon.com': 'amazon.com',
  'amazon.ca': 'amazon.com',
  'amazon.co.uk': 'amazon.com',
  'amazon.de': 'amazon.com',
  'amazon.fr': 'amazon.com',
  'amazon.it': 'amazon.com',
  'amazon.es': 'amazon.com',
  'amazon.co.jp': 'amazon.com',
  'amazon.com.mx': 'amazon.com',
  'amazon.com.au': 'amazon.com',
  // Newegg
  'newegg.com': 'newegg.com',
  'newegg.ca': 'newegg.com',
  'newegg.io': 'newegg.com',
  // Best Buy
  'bestbuy.com': 'bestbuy.com',
  'bestbuy.ca': 'bestbuy.com',
  // Walmart
  'walmart.com': 'walmart.com',
  'walmart.ca': 'walmart.com',
  // Target
  'target.com': 'target.com',
  // eBay
  'ebay.com': 'ebay.com',
  'ebay.co.uk': 'ebay.com',
  'ebay.ca': 'ebay.com',
  'ebay.de': 'ebay.com',
  'ebay.to': 'ebay.com',
  // B&H Photo
  'bhphotovideo.com': 'bhphotovideo.com',
  'bh.com': 'bhphotovideo.com',
  // Costco
  'costco.com': 'costco.com',
  'costco.ca': 'costco.com',
  // Home Depot
  'homedepot.com': 'homedepot.com',
  'homedepot.ca': 'homedepot.com',
  // Lowe's
  'lowes.com': 'lowes.com',
  'lowes.ca': 'lowes.com',
  // Micro Center
  'microcenter.com': 'microcenter.com',
  // Adorama
  'adorama.com': 'adorama.com',
  // AliExpress
  'aliexpress.com': 'aliexpress.com',
  'aliexpress.us': 'aliexpress.com',
  's.click.aliexpress.com': 'aliexpress.com',
  // Etsy
  'etsy.com': 'etsy.com',
  'etsy.me': 'etsy.com',
};

function stripWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

export function canonicalDomain(url: string): string {
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  hostname = stripWww(hostname);
  if (ALIASES[hostname]) return ALIASES[hostname];
  for (const alias of Object.keys(ALIASES)) {
    if (hostname.endsWith('.' + alias)) return ALIASES[alias];
  }
  return hostname;
}
```

- [ ] **Step 2: Write failing tests for `normalizeTrackerUrl`**

Create `server/src/lib/normalize-url.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalizeTrackerUrl } from './normalize-url.js';

describe('normalizeTrackerUrl', () => {
  it('returns null on malformed input', () => {
    expect(normalizeTrackerUrl('')).toBeNull();
    expect(normalizeTrackerUrl('not a url')).toBeNull();
    expect(normalizeTrackerUrl('http://')).toBeNull();
  });

  it('canonicalizes the hostname via the alias table', () => {
    expect(normalizeTrackerUrl('https://smile.amazon.com/dp/B0XYZ'))
      .toBe('amazon.com/dp/b0xyz');
    expect(normalizeTrackerUrl('https://music.amazon.com/dp/B0XYZ'))
      .toBe('amazon.com/dp/b0xyz');
  });

  it('lowercases the pathname', () => {
    expect(normalizeTrackerUrl('https://amazon.com/DP/B0XYZ'))
      .toBe('amazon.com/dp/b0xyz');
  });

  it('strips tracking query params', () => {
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ?tag=abc&utm_source=x'))
      .toBe('amazon.com/dp/b0xyz');
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ?ref=nav&_encoding=UTF8&psc=1'))
      .toBe('amazon.com/dp/b0xyz');
  });

  it('keeps product-identifying params and sorts them deterministically', () => {
    const a = normalizeTrackerUrl('https://newegg.com/p/N82E123?Item=N82E123&utm_source=x&foo=1');
    const b = normalizeTrackerUrl('https://newegg.com/p/N82E123?foo=1&Item=N82E123');
    expect(a).toBe(b);
    expect(a).toContain('Item=N82E123');
    expect(a).toContain('foo=1');
    expect(a).not.toContain('utm_source');
  });

  it('strips trailing slashes and fragments', () => {
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ/#section'))
      .toBe('amazon.com/dp/b0xyz');
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ/'))
      .toBe('amazon.com/dp/b0xyz');
  });

  it('produces the same key for amazon.com and smile.amazon.com with matching paths', () => {
    const a = normalizeTrackerUrl('https://smile.amazon.com/dp/B0XYZ');
    const b = normalizeTrackerUrl('https://www.amazon.com/dp/B0XYZ');
    expect(a).toBe(b);
  });

  it('does NOT collide distinct products', () => {
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ'))
      .not.toBe(normalizeTrackerUrl('https://amazon.com/dp/B0ABC'));
  });

  it('canonicalizes short-link hostnames but keeps the opaque path', () => {
    // a.co/d/xyz and amazon.com/dp/B0XYZ do NOT match without short-link
    // resolution — that resolution happens at scrape time, not in this
    // helper. The helper still produces a stable key for the short link.
    const out = normalizeTrackerUrl('https://a.co/d/xyz');
    expect(out).toBe('amazon.com/d/xyz');
  });
});
```

- [ ] **Step 3: Run tests — expect fail**

Run: `cd /root/price-tracker/server && npx vitest run src/lib/normalize-url.test.ts`
Expected: FAIL with "Cannot find module './normalize-url.js'".

- [ ] **Step 4: Implement `normalizeTrackerUrl`**

Create `server/src/lib/normalize-url.ts`:

```typescript
import { canonicalDomain } from './domains.js';

/**
 * Tracking / affiliate query parameters to strip during normalization.
 * Extend this list if new retailer tracking noise is observed — never
 * remove an entry without verifying it doesn't disambiguate a product.
 */
const TRACKING_PARAMS = new Set([
  'tag', 'ref', 'ref_', '_encoding', 'psc', 'srsltid',
  'cm_sp', 'cm_cat', 'cm_ite', 'cm_lm', 'cm_pla', 'cm_re',
  '_gl', '_ga',
]);

function isTrackingParam(key: string): boolean {
  if (TRACKING_PARAMS.has(key)) return true;
  if (key.startsWith('utm_')) return true;
  if (key.startsWith('_ga')) return true;
  return false;
}

/**
 * Produce a canonical key for a tracker URL so two users adding the
 * "same product" via different URL variants land on the same string.
 * Pure; deterministic; returns null on malformed input so callers can
 * store null and skip overlap matching safely.
 *
 * Pipeline: parse → canonical domain → lowercase path → drop tracking
 * params → sort remaining params → strip trailing slash and fragment.
 *
 * Short-link resolution (a.co → amazon.com/dp/...) happens at scrape
 * time in the scheduler, not here. This helper operates on whatever
 * URL it's given.
 */
export function normalizeTrackerUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;

  const domain = canonicalDomain(url);
  if (!domain) return null;

  let path = parsed.pathname.toLowerCase();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const kept: [string, string][] = [];
  parsed.searchParams.forEach((value, key) => {
    if (!isTrackingParam(key)) kept.push([key, value]);
  });
  kept.sort(([a], [b]) => a.localeCompare(b));

  const query = kept.length > 0
    ? '?' + kept.map(([k, v]) => `${k}=${v}`).join('&')
    : '';

  return `${domain}${path}${query}`;
}
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd /root/price-tracker/server && npx vitest run src/lib/normalize-url.test.ts`
Expected: all 8 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/lib/domains.ts server/src/lib/normalize-url.ts server/src/lib/normalize-url.test.ts
git commit -m "feat(server): normalize-url helper for cross-user overlap matching

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Migration v6 + schema column

**Files:**
- Modify: `server/src/db/schema.ts` (add `normalized_url` to fresh-DB CREATE TABLE)
- Modify: `server/src/db/migrations.ts` (add v6 migration)
- Create: `server/src/db/migration-v6.test.ts`

- [ ] **Step 1: Add the column to `schema.ts` (fresh-DB path)**

In `server/src/db/schema.ts`, inside the trackers CREATE TABLE, add `normalized_url` after the existing `url` line:

```sql
    url TEXT NOT NULL,
    -- Canonical key used for cross-user overlap matching. Populated by
    -- normalizeTrackerUrl() at create/scrape time. Nullable for legacy
    -- rows or URLs that fail to normalize; nulls are excluded from
    -- overlap queries.
    normalized_url TEXT,
```

Add the index at the end of the schema DDL block (before `runMigrations()`):

```sql
    CREATE INDEX IF NOT EXISTS idx_trackers_normalized_url ON trackers(normalized_url);
```

- [ ] **Step 2: Write failing migration test**

Create `server/src/db/migration-v6.test.ts`. Unlike earlier migration tests, this one uses per-statement `db.prepare(sql).run()` for the schema build instead of a single multi-statement call — keeps the file free of strings that trigger over-eager pre-commit hooks:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

/**
 * Integration test for migration v6 — adds normalized_url column and
 * backfills existing trackers. Builds a pre-v6 DB shape by hand to
 * force the migration to run against "upgrading from v5" state.
 */

const PRE_V6_DDL = [
  `CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE trackers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    threshold_price REAL,
    check_interval_minutes INTEGER NOT NULL DEFAULT 360,
    jitter_minutes INTEGER NOT NULL DEFAULT 0,
    css_selector TEXT,
    last_price REAL,
    last_checked_at TEXT,
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER
  )`,
  `CREATE TABLE tracker_urls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    last_price REAL,
    last_checked_at TEXT,
    last_error TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
    price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
    price REAL NOT NULL,
    threshold_price REAL NOT NULL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    channel TEXT
  )`,
  `CREATE TABLE settings (
    user_id INTEGER,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
  )`,
  `CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `INSERT INTO schema_migrations (version) VALUES (1)`,
  `INSERT INTO schema_migrations (version) VALUES (2)`,
  `INSERT INTO schema_migrations (version) VALUES (3)`,
  `INSERT INTO schema_migrations (version) VALUES (4)`,
  `INSERT INTO schema_migrations (version) VALUES (5)`,
];

function buildPreV6Schema(db: Database.Database): void {
  for (const stmt of PRE_V6_DDL) {
    db.prepare(stmt).run();
  }
}

describe('migration v6 — normalized_url column + backfill', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    buildPreV6Schema(db);
  });

  it('adds the normalized_url column and the index', () => {
    runMigrations();
    const cols = (getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string }[])
      .map(c => c.name);
    expect(cols).toContain('normalized_url');
    const indexes = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'trackers'")
      .all() as { name: string }[];
    expect(indexes.map(i => i.name)).toContain('idx_trackers_normalized_url');
  });

  it('backfills normalized_url for existing trackers', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'x', 'A')`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id) VALUES ('T1', 'https://smile.amazon.com/dp/B0XYZ?tag=foo', 1)`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id) VALUES ('T2', 'https://newegg.com/p/N82E123?Item=N82E123', 1)`).run();

    runMigrations();

    const rows = db.prepare('SELECT id, url, normalized_url FROM trackers ORDER BY id').all() as { id: number; url: string; normalized_url: string | null }[];
    expect(rows[0].normalized_url).toBe('amazon.com/dp/b0xyz');
    expect(rows[1].normalized_url).toBe('newegg.com/p/n82e123?Item=N82E123');
  });

  it('leaves malformed URLs with null normalized_url and does not crash', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c', 'x', 'A')`).run();
    db.prepare(`INSERT INTO trackers (name, url, user_id) VALUES ('bad', 'not-a-url', 1)`).run();

    runMigrations();

    const row = db.prepare('SELECT normalized_url FROM trackers WHERE name = ?').get('bad') as { normalized_url: string | null };
    expect(row.normalized_url).toBeNull();
  });

  it('re-running migrations is a no-op (idempotent)', () => {
    runMigrations();
    runMigrations();
    const cols = (getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string }[])
      .map(c => c.name);
    const normalizedCols = cols.filter(c => c === 'normalized_url');
    expect(normalizedCols).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test — expect fail**

Run: `cd /root/price-tracker/server && npx vitest run src/db/migration-v6.test.ts`
Expected: FAIL — migration v6 doesn't exist yet.

- [ ] **Step 4: Add migration v6**

In `server/src/db/migrations.ts`, append a new object to the `migrations` array (after the v5 entry). Add the import at the top of the file:

```typescript
import { normalizeTrackerUrl } from '../lib/normalize-url.js';
```

Then the migration entry:

```typescript
  {
    version: 6,
    description: 'Add normalized_url to trackers for cross-user overlap matching',
    up: () => {
      const db = getDb();
      const cols = db.prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
      if (!cols.some(c => c.name === 'normalized_url')) {
        db.prepare('ALTER TABLE trackers ADD COLUMN normalized_url TEXT').run();
      }
      db.prepare('CREATE INDEX IF NOT EXISTS idx_trackers_normalized_url ON trackers(normalized_url)').run();

      // Backfill every existing tracker. Migration-time normalization uses
      // the stored url — short-link trackers won't resolve until their
      // next successful scrape (see scheduler/cron.ts).
      const rows = db.prepare('SELECT id, url FROM trackers WHERE normalized_url IS NULL').all() as { id: number; url: string }[];
      const update = db.prepare('UPDATE trackers SET normalized_url = ? WHERE id = ?');
      for (const r of rows) {
        update.run(normalizeTrackerUrl(r.url), r.id);
      }
      logger.info({ backfilled: rows.length }, 'Backfilled normalized_url for existing trackers');
    },
  },
```

- [ ] **Step 5: Run tests — expect pass**

Run: `cd /root/price-tracker/server && npx vitest run src/db/migration-v6.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/schema.ts server/src/db/migrations.ts server/src/db/migration-v6.test.ts
git commit -m "feat(server): migration v6 — normalized_url column + backfill

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Populate normalized_url at tracker create

**Files:**
- Modify: `server/src/db/queries.ts`

- [ ] **Step 1: Extend the `Tracker` interface and `createTracker`**

In `server/src/db/queries.ts`, add `normalized_url: string | null` to the `Tracker` interface after `url`:

```typescript
export interface Tracker {
  id: number;
  name: string;
  url: string;
  normalized_url: string | null;
  threshold_price: number | null;
  // ... rest unchanged
```

Import `normalizeTrackerUrl` at the top of the file:

```typescript
import { normalizeTrackerUrl } from '../lib/normalize-url.js';
```

Replace the body of `createTracker` to populate the column:

```typescript
export function createTracker(data: {
  name: string;
  url: string;
  threshold_price?: number | null;
  check_interval_minutes?: number;
  css_selector?: string | null;
  user_id: number;
}): Tracker {
  const db = getDb();
  const interval = data.check_interval_minutes ?? 360;
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO trackers (name, url, normalized_url, threshold_price, check_interval_minutes, jitter_minutes, css_selector, user_id)
      VALUES (@name, @url, @normalized_url, @threshold_price, @check_interval_minutes, @jitter_minutes, @css_selector, @user_id)
    `).run({
      name: data.name,
      url: data.url,
      normalized_url: normalizeTrackerUrl(data.url),
      threshold_price: data.threshold_price ?? null,
      check_interval_minutes: interval,
      jitter_minutes: computeJitterMinutes(interval),
      css_selector: data.css_selector ?? null,
      user_id: data.user_id,
    });
    const trackerId = Number(result.lastInsertRowid);
    db.prepare(`INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, ?, 0)`).run(trackerId, data.url);
    return getTrackerById(trackerId, data.user_id)!;
  })();
}
```

- [ ] **Step 2: TypeCheck + run existing tests**

Run: `cd /root/price-tracker/server && npx tsc --noEmit && npm test`
Expected: clean, all tests still pass (baseline 201 + 4 from v6 migration = 205 expected).

- [ ] **Step 3: Commit**

```bash
git add server/src/db/queries.ts
git commit -m "feat(server): createTracker populates normalized_url

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Overlap query helpers

**Files:**
- Modify: `server/src/db/queries.ts`
- Create: `server/src/db/overlap.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/src/db/overlap.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker,
  getOverlapForTracker,
  getOverlapCountsForUser,
  setSetting,
} from './queries.js';

function setupDb() {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  // Three users: Alice (opts in), Bob (opts out), Carol (opts in).
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@x', 'h', 'Alice')`).run();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('b@x', 'h', 'Bob')`).run();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('c@x', 'h', 'Carol')`).run();
  setSetting('share_display_name', 'true', 1);
  setSetting('share_display_name', 'false', 2);
  setSetting('share_display_name', 'true', 3);
}

describe('getOverlapForTracker', () => {
  beforeEach(setupDb);

  it('excludes self from count and names; includes only opted-in names', () => {
    const tAlice = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 });
    createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 3 });

    const r = getOverlapForTracker(tAlice.id, 1);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);           // Bob + Carol
    expect(r!.names).toEqual(['Carol']); // only Carol opted in among peers
  });

  it('returns count 0 and empty names when no other user tracks it', () => {
    const t = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0UNIQUE', user_id: 1 });
    const r = getOverlapForTracker(t.id, 1);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(0);
    expect(r!.names).toEqual([]);
    expect(r!.communityLow).toBeNull();
  });

  it('returns null if the tracker is not owned by the user', () => {
    const t = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    expect(getOverlapForTracker(t.id, 2)).toBeNull();
  });

  it('handles malformed URL tracker (null normalized_url)', () => {
    const t = createTracker({ name: 'T', url: 'not-a-url', user_id: 1 });
    const r = getOverlapForTracker(t.id, 1);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(0);
    expect(r!.names).toEqual([]);
    expect(r!.communityLow).toBeNull();
  });

  it('community low is MIN(last_price) INCLUDING self', () => {
    const tAlice = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    const tBob = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 });
    const db = getDb();
    db.prepare('UPDATE trackers SET last_price = ? WHERE id = ?').run(40, tAlice.id);
    db.prepare('UPDATE trackers SET last_price = ? WHERE id = ?').run(35, tBob.id);
    expect(getOverlapForTracker(tAlice.id, 1)!.communityLow).toBe(35);
  });

  it('community low excludes null prices', () => {
    const tAlice = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 }); // no price
    const db = getDb();
    db.prepare('UPDATE trackers SET last_price = ? WHERE id = ?').run(40, tAlice.id);
    expect(getOverlapForTracker(tAlice.id, 1)!.communityLow).toBe(40);
  });
});

describe('getOverlapCountsForUser', () => {
  beforeEach(setupDb);

  it('returns a map of trackerId -> count for every tracker owned by the user', () => {
    const tA = createTracker({ name: 'A', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    const tB = createTracker({ name: 'B', url: 'https://amazon.com/dp/B0UNIQUE', user_id: 1 });
    createTracker({ name: 'shared-A', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 });
    createTracker({ name: 'shared-A', url: 'https://amazon.com/dp/B0XYZ', user_id: 3 });

    const counts = getOverlapCountsForUser(1);
    expect(counts[tA.id]).toBe(2);
    expect(counts[tB.id]).toBe(0);
  });

  it('does not include trackers from other users in the result', () => {
    createTracker({ name: 'A', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 });
    expect(getOverlapCountsForUser(1)).toEqual({});
  });
});
```

- [ ] **Step 2: Run tests — expect fail**

Run: `cd /root/price-tracker/server && npx vitest run src/db/overlap.test.ts`
Expected: FAIL with missing exports `getOverlapForTracker` / `getOverlapCountsForUser`.

- [ ] **Step 3: Implement the query helpers**

Add to `server/src/db/queries.ts` (near the other tracker queries):

```typescript
export interface OverlapResult {
  count: number;
  names: string[];
  communityLow: number | null;
}

/**
 * Compute the overlap for a single tracker owned by `userId`.
 * - count: number of OTHER users' trackers sharing the same normalized_url
 * - names: display names of those OTHER users who have share_display_name = 'true'
 * - communityLow: MIN(last_price) across ALL users' trackers with this
 *   normalized_url (self INCLUDED), null if no prices yet
 *
 * Returns null when the tracker isn't owned by `userId` so the route
 * layer can 404 without leaking other users' tracker IDs.
 */
export function getOverlapForTracker(trackerId: number, userId: number): OverlapResult | null {
  const db = getDb();
  const tracker = db.prepare('SELECT normalized_url FROM trackers WHERE id = ? AND user_id = ?')
    .get(trackerId, userId) as { normalized_url: string | null } | undefined;
  if (!tracker) return null;
  if (!tracker.normalized_url) {
    return { count: 0, names: [], communityLow: null };
  }

  const peers = db.prepare(`
    SELECT t.user_id, u.display_name
    FROM trackers t
    JOIN users u ON u.id = t.user_id
    WHERE t.normalized_url = ? AND t.user_id != ?
  `).all(tracker.normalized_url, userId) as { user_id: number; display_name: string }[];

  // Dedupe peers by user_id — a user tracking the same product twice
  // shouldn't inflate the count.
  const seen = new Set<number>();
  const uniquePeers: { user_id: number; display_name: string }[] = [];
  for (const p of peers) {
    if (seen.has(p.user_id)) continue;
    seen.add(p.user_id);
    uniquePeers.push(p);
  }

  // Respect each peer's share_display_name setting. Missing or 'false' = hidden.
  const shareRows = uniquePeers.length === 0 ? [] : db.prepare(
    `SELECT user_id, value FROM settings WHERE key = 'share_display_name' AND user_id IN (${uniquePeers.map(() => '?').join(',')})`,
  ).all(...uniquePeers.map(p => p.user_id)) as { user_id: number; value: string }[];
  const optedIn = new Set(shareRows.filter(r => r.value === 'true').map(r => r.user_id));
  const names = uniquePeers.filter(p => optedIn.has(p.user_id)).map(p => p.display_name);

  const low = db.prepare(`
    SELECT MIN(last_price) AS low
    FROM trackers
    WHERE normalized_url = ? AND last_price IS NOT NULL
  `).get(tracker.normalized_url) as { low: number | null };

  return { count: uniquePeers.length, names, communityLow: low.low ?? null };
}

/**
 * Compute overlap counts for every tracker owned by `userId`. Single
 * query so the dashboard doesn't fire one HTTP request per tracker.
 */
export function getOverlapCountsForUser(userId: number): Record<number, number> {
  const rows = getDb().prepare(`
    SELECT t.id AS tracker_id,
           (SELECT COUNT(DISTINCT peer.user_id)
            FROM trackers peer
            WHERE peer.normalized_url = t.normalized_url
              AND peer.user_id != t.user_id) AS count
    FROM trackers t
    WHERE t.user_id = ? AND t.normalized_url IS NOT NULL
  `).all(userId) as { tracker_id: number; count: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.tracker_id] = r.count;
  return out;
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cd /root/price-tracker/server && npx vitest run src/db/overlap.test.ts`
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/db/queries.ts server/src/db/overlap.test.ts
git commit -m "feat(server): overlap query helpers (per-tracker + batch counts)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Overlap API routes

**Files:**
- Modify: `server/src/routes/trackers.ts`

- [ ] **Step 1: Add the two new routes**

In `server/src/routes/trackers.ts`, add to the imports:

```typescript
import { getOverlapForTracker, getOverlapCountsForUser } from '../db/queries.js';
```

Add the batch route BEFORE any `/:id` routes (Express matches first-found; `/overlap-counts` would otherwise be captured by `/:id`):

```typescript
router.get('/overlap-counts', (req: Request, res: Response) => {
  const counts = getOverlapCountsForUser(req.user!.userId);
  res.json(counts);
});
```

Add the per-tracker route alongside the other `/:id/...` routes (e.g., after `POST /:id/check`):

```typescript
router.get('/:id/overlap', (req: Request, res: Response) => {
  const overlap = getOverlapForTracker(Number(req.params.id), req.user!.userId);
  if (overlap === null) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.json(overlap);
});
```

- [ ] **Step 2: TypeCheck + tests**

Run: `cd /root/price-tracker/server && npx tsc --noEmit && npm test`
Expected: clean, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/trackers.ts
git commit -m "feat(server): GET /api/trackers/:id/overlap + /overlap-counts routes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: `share_display_name` setting

**Files:**
- Modify: `server/src/routes/settings.ts`

- [ ] **Step 1: Add the key to the allow-list**

In `server/src/routes/settings.ts`, update the `ALLOWED_SETTING_KEYS` set:

```typescript
const ALLOWED_SETTING_KEYS = new Set([
  'discord_webhook_url',
  'ntfy_url',
  'ntfy_token',
  'generic_webhook_url',
  'email_recipient',
  'share_display_name',
]);
```

This is sufficient — `share_display_name` is a simple boolean string, so it doesn't need to land in `ENCRYPTED_KEYS` (not credential material) and the existing PUT handler already loops over allowed keys.

- [ ] **Step 2: TypeCheck + tests**

Run: `cd /root/price-tracker/server && npx tsc --noEmit && npm test`
Expected: clean, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/settings.ts
git commit -m "feat(server): allow share_display_name setting key

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: `fetchPageContent` returns `{html, finalUrl}`

**Files:**
- Modify: `server/src/scraper/browser.ts`
- Modify: `server/src/scraper/extractor.ts`

- [ ] **Step 1: Update `fetchPageContent` signature**

In `server/src/scraper/browser.ts`, above the function declaration, add the `FetchResult` interface and change the return type:

```typescript
export interface FetchResult {
  html: string;
  finalUrl: string;
}
```

Change the signature:

```typescript
export async function fetchPageContent(url: string): Promise<FetchResult> {
```

Locate the existing end-of-function return (currently `return html;`) and replace it with:

```typescript
    if (isBotCheckPage(html, response?.url() ?? url)) {
      throw new ScrapeError(`Bot check / captcha page detected for ${url}`, true);
    }
    return { html, finalUrl: response?.url() ?? url };
```

The surrounding `try`/`finally` blocks stay as-is.

- [ ] **Step 2: Update `extractor.ts` to thread finalUrl through**

In `server/src/scraper/extractor.ts`:

Change the `ExtractionResult` interface to carry finalUrl:

```typescript
export interface ExtractionResult {
  price: number;
  currency: string;
  strategy: string;
  finalUrl: string;
}
```

Find the existing `const html = await withRetry(...)` block and replace with:

```typescript
  const fetched = await withRetry(
    () => fetchPageContent(url),
    {
      maxRetries: config.scrapeMaxRetries,
      baseDelayMs: config.scrapeRetryBaseMs,
      isRetryable: (err) => (err instanceof ScrapeError ? err.retryable : true),
      onRetry: (err, attempt, delayMs) => {
        logger.warn(
          { url, attempt, delayMs, err: err instanceof Error ? err.message : String(err) },
          'Retrying scrape after transient failure',
        );
      },
    },
  );
  const { html, finalUrl } = fetched;
```

Update the success-path return inside the strategies loop:

```typescript
      return { price, currency: 'USD', strategy: name, finalUrl };
```

Update the css-selector short-circuit (uses input URL since extractWithCssSelector runs its own page load):

```typescript
  if (cssSelector) {
    logger.debug({ url, strategy: 'css-selector' }, 'Trying user CSS selector');
    const price = await extractWithCssSelector(url, cssSelector);
    if (price !== null) {
      return { price, currency: 'USD', strategy: 'css-selector', finalUrl: url };
    }
    logger.debug({ url }, 'User CSS selector failed, falling back to pipeline');
  }
```

- [ ] **Step 3: Update any existing tests that mock `fetchPageContent`**

Run: `grep -rn "fetchPageContent" server/src | grep -v ".d.ts" | grep -v ".js.map"`

For each test that returns a string from `fetchPageContent`, change it to return `{ html: '...', finalUrl: '...' }`. In `extractor.test.ts` (if it mocks) and `cron-cooldown.test.ts` (which mocks extractor), look for `extractPrice` returns — the returned object now needs `finalUrl`. Example:

```typescript
// Before
extractPrice.mockResolvedValue({ price: 42, currency: 'USD', strategy: 'json-ld' });
// After
extractPrice.mockResolvedValue({ price: 42, currency: 'USD', strategy: 'json-ld', finalUrl: 'https://a.example/x' });
```

- [ ] **Step 4: Run full server test suite**

Run: `cd /root/price-tracker/server && npx tsc --noEmit && npm test`
Expected: clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/scraper/browser.ts server/src/scraper/extractor.ts server/src/scraper/extractor.test.ts server/src/scheduler/cron-cooldown.test.ts
git commit -m "refactor(scrape): fetchPageContent returns {html, finalUrl}

Needed so the scheduler can update a tracker's normalized_url after
short-link redirect resolution (a.co -> amazon.com/dp/...).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

(Only include test files in the `git add` list if the grep found they needed updating.)

---

## Task 8: Scheduler updates normalized_url on primary-seller scrape

**Files:**
- Modify: `server/src/db/queries.ts`
- Modify: `server/src/scheduler/cron.ts`

- [ ] **Step 1: Add the DB setter**

In `server/src/db/queries.ts`, add near the other tracker update helpers:

```typescript
/**
 * Update just the normalized_url column. Called by the scheduler when
 * a primary-seller scrape resolves a different final URL than what's
 * stored (e.g., a.co short link redirects to amazon.com/dp/...).
 */
export function updateTrackerNormalizedUrl(trackerId: number, normalizedUrl: string | null): void {
  getDb().prepare('UPDATE trackers SET normalized_url = ? WHERE id = ?').run(normalizedUrl, trackerId);
}
```

- [ ] **Step 2: Update the scheduler to call the setter after a primary-seller scrape**

In `server/src/scheduler/cron.ts`:

Import the new setter and the normalizer:

```typescript
import { normalizeTrackerUrl } from '../lib/normalize-url.js';
```

Extend the existing import block from `../db/queries.js` to include `updateTrackerNormalizedUrl`.

Find the block inside `checkTrackerUrl` that runs after a successful scrape — right after `updateTrackerUrl(seller.id, { last_price: result.price, ... })` — and add a normalized_url update BEFORE the `refreshTrackerAggregates(tracker.id);` call:

```typescript
      // If this was the primary seller (position=0), re-normalize using
      // the finalUrl Playwright resolved. Short links (a.co/d/xyz) now
      // map to their actual product page so overlap matching works.
      if (seller.position === 0) {
        const normalized = normalizeTrackerUrl(result.finalUrl);
        if (normalized !== tracker.normalized_url) {
          updateTrackerNormalizedUrl(tracker.id, normalized);
        }
      }

      refreshTrackerAggregates(tracker.id);
```

- [ ] **Step 3: Run full server test suite**

Run: `cd /root/price-tracker/server && npx tsc --noEmit && npm test`
Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add server/src/db/queries.ts server/src/scheduler/cron.ts
git commit -m "feat(server): scheduler re-normalizes normalized_url on primary seller scrape

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Client API helpers and types

**Files:**
- Modify: `client/src/types.ts`
- Modify: `client/src/api.ts`

- [ ] **Step 1: Extend `Tracker` and add `Overlap` type**

In `client/src/types.ts`, add `normalized_url: string | null;` after `url`:

```typescript
export interface Tracker {
  id: number;
  name: string;
  url: string;
  normalized_url: string | null;
  threshold_price: number | null;
  // ...existing fields...
```

Add the new `Overlap` type at the bottom of the file:

```typescript
export interface Overlap {
  count: number;
  names: string[];
  communityLow: number | null;
}
```

- [ ] **Step 2: Add `getOverlap` and `getOverlapCounts` to `client/src/api.ts`**

Add the `Overlap` type to the existing `import type` line from `./types`:

```typescript
import type { /* ...existing types..., */ Overlap } from './types'
```

Add near the other tracker fetchers:

```typescript
export const getOverlap = (trackerId: number) =>
  request<Overlap>(`/trackers/${trackerId}/overlap`);

export const getOverlapCounts = () =>
  request<Record<number, number>>('/trackers/overlap-counts');
```

- [ ] **Step 3: TypeCheck**

Run: `cd /root/price-tracker/client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/types.ts client/src/api.ts
git commit -m "feat(client): Overlap type + getOverlap/getOverlapCounts helpers

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: TrackerCard overlap pill + Dashboard batch fetch

**Files:**
- Modify: `client/src/components/TrackerCard.tsx`
- Modify: `client/src/pages/Dashboard.tsx`
- Modify: `client/src/pages/Active.tsx`
- Modify: `client/src/pages/BelowTarget.tsx`
- Modify: `client/src/pages/Errors.tsx`

- [ ] **Step 1: Add `overlapCount` prop to TrackerCard**

In `client/src/components/TrackerCard.tsx`:

Find the component's props interface — add `overlapCount?: number` as a new optional prop.

Extend the existing lucide-react imports to include `Users`:

```tsx
import { /* ...existing icons..., */ Users } from 'lucide-react';
```

Render the pill below the tracker name (look for the existing `<h3>` or equivalent name element). Place the pill immediately below it:

```tsx
{overlapCount !== undefined && overlapCount > 0 && (
  <div className="inline-flex items-center gap-1 text-xs text-text-muted bg-surface-hover rounded-full px-2 py-0.5 mt-1">
    <Users className="w-3 h-3" />
    Also tracked by {overlapCount}
  </div>
)}
```

- [ ] **Step 2: Dashboard fetches overlap counts and passes them down**

In `client/src/pages/Dashboard.tsx`:

Add `getOverlapCounts` to the imports from `../api`:

```tsx
import { getTrackers, getTrackerStats, getSettings, getOverlapCounts } from '../api'
```

Add state + fetch inside the component. Extend the existing Promise.all call:

```tsx
const [overlapCounts, setOverlapCounts] = useState<Record<number, number>>({})

// Inside the existing load() function:
const [data, trackerStats, settings, counts] = await Promise.all([
  getTrackers(),
  getTrackerStats(),
  getSettings(),
  getOverlapCounts(),
])
setOverlapCounts(counts)
```

Pass the count to every `<TrackerCard>` render in Dashboard.tsx:

```tsx
<TrackerCard
  key={tracker.id}
  tracker={tracker}
  sparklineData={stats[tracker.id]?.sparkline || []}
  minPrice={stats[tracker.id]?.min_price ?? null}
  overlapCount={overlapCounts[tracker.id] ?? 0}
  onUpdate={load}
  notificationsConfigured={notificationsConfigured}
/>
```

Repeat the `overlapCount={...}` prop for every `<TrackerCard>` call site in the file.

- [ ] **Step 3: Repeat the pattern on Active.tsx, BelowTarget.tsx, Errors.tsx**

Same changes:
- Add `getOverlapCounts` to the `../api` import.
- Add `const [overlapCounts, setOverlapCounts] = useState<Record<number, number>>({})`.
- Extend the page's Promise.all to fetch overlap counts; `setOverlapCounts(counts)`.
- Add `overlapCount={overlapCounts[tracker.id] ?? 0}` to every `<TrackerCard>` render.

- [ ] **Step 4: TypeCheck + build**

Run: `cd /root/price-tracker/client && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/TrackerCard.tsx client/src/pages/Dashboard.tsx client/src/pages/Active.tsx client/src/pages/BelowTarget.tsx client/src/pages/Errors.tsx
git commit -m "feat(client): overlap-count pill on TrackerCard across card grids

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: TrackerDetail Community card

**Files:**
- Modify: `client/src/pages/TrackerDetail.tsx`

- [ ] **Step 1: Fetch overlap + render Community card**

In `client/src/pages/TrackerDetail.tsx`:

Extend the existing lucide-react imports to include `Users` and `TrendingDown` (if not already present):

```tsx
import { /* ...existing..., */ Users, TrendingDown } from 'lucide-react'
```

Extend the existing `../api` imports to include `getOverlap`, and the type imports to include `Overlap`:

```tsx
import { /* ...existing..., */ getOverlap } from '../api'
import type { /* ...existing..., */ Overlap } from '../types'
```

Add state and a fetch alongside the existing load effect:

```tsx
const [overlap, setOverlap] = useState<Overlap | null>(null)

// Inside the existing load() function, extend the Promise.all call:
const [tracker, urls, history, stats, overlapData] = await Promise.all([
  getTracker(id),
  getTrackerUrls(id),
  getPriceHistory(id),
  getTrackerStats(),
  getOverlap(id),
])
setOverlap(overlapData)
```

Render the Community card between the existing Sellers card and Recent Alerts card. Only render when `overlap && overlap.count > 0`:

```tsx
{overlap && overlap.count > 0 && (
  <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-4">
    <div className="flex items-center gap-2 mb-3">
      <Users className="w-5 h-5 text-primary" />
      <h2 className="text-lg font-semibold">Community</h2>
    </div>
    <p className="text-text-muted text-sm">
      Also tracked by {overlap.count} {overlap.count === 1 ? 'other user' : 'others'}
      {overlap.names.length > 0 && (
        <> — shared by <span className="text-text font-medium">{overlap.names.join(', ')}</span></>
      )}
      .
    </p>
    {overlap.communityLow !== null
      && tracker?.last_price !== null
      && tracker?.last_price !== undefined
      && overlap.communityLow < tracker.last_price && (
        <div className="inline-flex items-center gap-1 text-sm text-success bg-success/10 rounded-full px-2.5 py-1 mt-3">
          <TrendingDown className="w-4 h-4" />
          Community low: ${overlap.communityLow.toFixed(2)}
        </div>
      )}
  </div>
)}
```

- [ ] **Step 2: TypeCheck + build**

Run: `cd /root/price-tracker/client && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/TrackerDetail.tsx
git commit -m "feat(client): Community card on TrackerDetail

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Settings `share_display_name` toggle

**Files:**
- Modify: `client/src/pages/Settings.tsx`

- [ ] **Step 1: Add a Community card with a checkbox**

In `client/src/pages/Settings.tsx`:

This card sits OUTSIDE the `CHANNELS.map` loop because it isn't a notification channel.

Extend the lucide-react imports to include `Users`:

```tsx
import { /* ...existing icons..., */ Users } from 'lucide-react'
```

Add state + handler inside the component, right after the existing channel state:

```tsx
const [shareDisplayName, setShareDisplayName] = useState(false)
const [savingCommunity, setSavingCommunity] = useState(false)
const [savedCommunity, setSavedCommunity] = useState(false)
```

Extend the existing `getSettings().then` hydrator to pull the flag:

```tsx
useEffect(() => {
  getSettings().then(s => {
    setValues({
      discord: s.discord_webhook_url || '',
      ntfy: s.ntfy_url || '',
      webhook: s.generic_webhook_url || '',
      email: s.email_recipient || '',
    })
    setNtfyToken(s.ntfy_token || '')
    setShareDisplayName(s.share_display_name === 'true')
  })
}, [])
```

Add the save handler:

```tsx
const handleCommunitySave = async () => {
  setSavingCommunity(true)
  setSavedCommunity(false)
  try {
    await updateSettings({ share_display_name: shareDisplayName ? 'true' : 'false' })
    setSavedCommunity(true)
    setTimeout(() => setSavedCommunity(false), 3000)
  } finally {
    setSavingCommunity(false)
  }
}
```

Render the card after the channels list (after the `</div>` that closes the channels flex container):

```tsx
<div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mt-4">
  <div className="flex items-center gap-2 mb-2">
    <Users className="w-5 h-5 text-primary" />
    <h2 className="text-lg font-semibold">Community</h2>
  </div>
  <p className="text-text-muted text-sm mb-4">
    When other users track the same products you do, the dashboard shows a small
    "Also tracked by N" indicator. Turn this on to let those users see your
    display name too; off keeps you anonymous.
  </p>
  <label className="flex items-center gap-2 cursor-pointer mb-4">
    <input
      type="checkbox"
      checked={shareDisplayName}
      onChange={e => setShareDisplayName(e.target.checked)}
      className="rounded"
    />
    <span className="text-sm">Show my display name to other users on trackers we share</span>
  </label>
  <button
    onClick={handleCommunitySave}
    disabled={savingCommunity}
    className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
  >
    {savedCommunity ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
    {savedCommunity ? 'Saved!' : savingCommunity ? 'Saving...' : 'Save'}
  </button>
</div>
```

- [ ] **Step 2: TypeCheck + build**

Run: `cd /root/price-tracker/client && npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/Settings.tsx
git commit -m "feat(client): Community card in Settings with share_display_name toggle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: Full verification + deploy + PR

- [ ] **Step 1: Server full suite**

Run: `cd /root/price-tracker/server && npm test`
Expected: all tests pass (baseline 201 + ~15 new ≈ 216).

- [ ] **Step 2: Client full suite**

Run: `cd /root/price-tracker/client && npm test`
Expected: 76 tests pass (unchanged).

- [ ] **Step 3: Deploy to CT 302**

Run: `cd /root/price-tracker && bash scripts/deploy.sh`
Expected: build succeeds, migration v6 runs, service restarts clean.

- [ ] **Step 4: Verify migration applied in prod**

Run: `ssh root@192.168.1.166 "journalctl -u price-tracker -n 30 --no-pager | grep -E 'migration|normalized_url|running'"`
Expected: v6 migration logged with a backfill count matching prod tracker count.

- [ ] **Step 5: Inspect production overlap state**

Run via SSH:

```bash
ssh root@192.168.1.166 "node -e \"const db = require('/opt/price-tracker/server/node_modules/better-sqlite3')('/opt/price-tracker/data/price-tracker.db', {readonly: true}); const rows = db.prepare('SELECT id, name, url, normalized_url FROM trackers ORDER BY id LIMIT 30').all(); console.log(JSON.stringify(rows, null, 2));\""
```

Confirm `normalized_url` is populated for every row (nulls only on URLs that failed to parse).

- [ ] **Step 6: UI smoke test**

Log in as two different user accounts (use the existing admin account + create a second test user via the admin page). Have both users add a tracker with the same product URL. Confirm:
- Dashboard shows "Also tracked by 1" pill on both cards.
- TrackerDetail shows the Community card with count 1.
- Toggle `share_display_name = true` on one account and refresh the other's TrackerDetail — their name should appear under "shared by".

- [ ] **Step 7: Mark todo done (with PR link placeholder)**

Edit `tasks/todo.md` — change the cross-user overlap line from `- [ ]` to `- [x]` with a done-summary and `[PR #N](...)` placeholder.

- [ ] **Step 8: Push + open PR**

```bash
git push -u origin feature/cross-user-tracker-overlap
gh pr create --title "feat: cross-user tracker overlap (anonymous count, opt-in names, community low)" --body "$(cat <<'EOF'
## Summary

Users now see when others on the same instance track the same products. Three surfaces:

- **Dashboard pill** — "Also tracked by N" below the tracker name on cards that have any overlap.
- **TrackerDetail Community card** — count + names (of opted-in users) + community low price when it beats your current.
- **Settings → Community** — opt-in toggle to reveal your display name to other users on shared trackers. Off by default.

## How matching works

A new `normalized_url` column on `trackers` (migration v6, indexed). Populated at tracker-create from the input URL, then re-populated at every primary-seller scrape using Playwright's final URL — so `a.co/d/xyz` short links automatically normalize to their canonical `amazon.com/dp/...` form after the first successful scrape.

Normalization strips tracking params, canonicalizes retailer aliases, lowercases the path, and deterministically orders remaining params. Pure function in `server/src/lib/normalize-url.ts`.

## API

- `GET /api/trackers/:id/overlap` -> `{ count, names, communityLow }`
- `GET /api/trackers/overlap-counts` -> `{ [trackerId]: count }` (batch, used by dashboard)

Per-user threshold prices, alert history, notification settings, and individual price-history rows are NEVER shared. The only cross-user data is aggregate: count, opt-in names, and `MIN(last_price)`.

## Spec + plan

- Spec: `docs/superpowers/specs/2026-04-18-cross-user-tracker-overlap-design.md`
- Plan: `docs/superpowers/plans/2026-04-18-cross-user-tracker-overlap.md`

## Test plan

- [x] ~15 new server tests (normalize-url, migration-v6, overlap queries)
- [x] Client typecheck + build clean
- [x] Deploy to CT 302 — migration v6 ran and backfilled normalized_url for all trackers
- [x] UI smoke test: two users, one shared tracker — pill + card render correctly; opt-in name reveal works end-to-end

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Backfill PR number in `tasks/todo.md`**

After the PR URL is known, replace the `#N` placeholder in `tasks/todo.md`, then:

```bash
git add tasks/todo.md
git commit -m "docs: backfill PR link for cross-user overlap

Co-Authored-By: Claude <noreply@anthropic.com>"
git push
```

---

## Self-review notes

- Spec coverage: every numbered section of the spec has a matching task (schema/migration → Task 2, normalization helper → Task 1, overlap queries → Task 4, API → Task 5, settings key → Task 6, scheduler re-normalize → Tasks 7+8, UI surfaces → Tasks 10/11/12).
- No placeholders remain; every step has executable code or commands.
- Type consistency: `Overlap` type in client mirrors `OverlapResult` server shape (count/names/communityLow). `normalized_url` added to `Tracker` on both sides.
- One known pre-existing constraint acknowledged: Task 7 warns about updating the `fetchPageContent` return shape if any test mocks it; Task 7 Step 3 includes the grep to find them.
- Scope check: single feature, single plan. No decomposition needed.
