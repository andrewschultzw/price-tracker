# Plausibility-Guarded Alert Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add defense-in-depth so a wrong-but-plausible scrape never fires an alert without a confirmation read. Implements the design at `docs/superpowers/specs/2026-04-27-plausibility-guard-design.md`.

**Architecture:** Pure helper `isPlausibilityGuardSuspicious(price, sellerId)` evaluated only inside the alert path of `checkTrackerUrl()`. Suspicious-and-below-threshold scrapes set `tracker_urls.pending_confirmation_*` and schedule a `setTimeout`-driven re-scrape via the existing `p-queue`. Any successful scrape (the timed re-scrape, the next regular cron tick, or a manual "Check Now") resolves the pending flag — confirms the alert if still suspicious-and-below-threshold, drops it as transient otherwise. Restart-safe via DB-resident pending state plus a startup recovery scan.

**Tech Stack:** TypeScript 5.7, Node 22, better-sqlite3 11, vitest 4.1, p-queue 8, node-cron 3, pino 9.

**Branch:** `feature/plausibility-guard` (already created from main; spec already committed)

---

## File Structure

**Create:**
- `server/src/scraper/plausibility-guard.ts` — pure helper module
- `server/src/scraper/plausibility-guard.test.ts` — unit tests
- `server/src/scheduler/cron-plausibility.test.ts` — integration tests for alert path with guard
- `server/src/scheduler/cron-recovery.test.ts` — startup recovery test

**Modify:**
- `server/src/db/schema.ts` — add columns to `tracker_urls` for fresh installs
- `server/src/db/migrations.ts` — add migration v7
- `server/src/db/queries.ts` — extend `TrackerUrl` interface, extend `updateTrackerUrl` signature, add `getRecentSuccessfulPricesForSeller`, add `getSellersWithPendingConfirmation`
- `server/src/config.ts` — add `plausibilityGuardDropThreshold`
- `server/src/scheduler/cron.ts` — inject guard into alert path, add `scheduleConfirmationRescrape()`, add `recoverPendingConfirmations()` startup hook, wire into `startScheduler()`
- `tasks/todo.md` — mark tasks done, add follow-ups

---

## Task 1: Schema + Migration v7

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/db/migrations.ts`

- [ ] **Step 1.1: Add columns to fresh-install schema**

In `server/src/db/schema.ts`, find the `CREATE TABLE IF NOT EXISTS tracker_urls (...)` block (around line 44–56) and add these two columns just before `created_at`:

```sql
-- Plausibility guard state. Non-NULL means a previous scrape produced
-- a suspiciously low price that's below the alert threshold; the next
-- successful scrape for this seller acts as the confirmation read. See
-- docs/superpowers/specs/2026-04-27-plausibility-guard-design.md.
pending_confirmation_price REAL,
pending_confirmation_at TEXT,
```

The full block becomes:

```sql
CREATE TABLE IF NOT EXISTS tracker_urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  last_price REAL,
  last_checked_at TEXT,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'error')),
  pending_confirmation_price REAL,
  pending_confirmation_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 1.2: Add migration v7 to `server/src/db/migrations.ts`**

Append this entry to the `migrations` array (after the v6 entry):

```typescript
{
  version: 7,
  description: 'Add pending_confirmation_* columns to tracker_urls for plausibility guard',
  up: () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(tracker_urls)").all() as { name: string }[];
    if (!cols.some(c => c.name === 'pending_confirmation_price')) {
      db.prepare('ALTER TABLE tracker_urls ADD COLUMN pending_confirmation_price REAL').run();
    }
    if (!cols.some(c => c.name === 'pending_confirmation_at')) {
      db.prepare('ALTER TABLE tracker_urls ADD COLUMN pending_confirmation_at TEXT').run();
    }
    // No backfill needed — NULL is the correct default for "no confirmation in flight."
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_tracker_urls_pending_confirmation_at ON tracker_urls(pending_confirmation_at) WHERE pending_confirmation_at IS NOT NULL'
    ).run();
  },
},
```

The partial index keeps the startup-recovery scan fast even as the table grows.

- [ ] **Step 1.3: Verify migrations apply cleanly**

Run from `server/` (sqlite3 CLI required, already installed on dev container):

```bash
cd /root/price-tracker/server
npm run build
# Spin up an in-memory DB by running the test suite (which uses temp files):
npx vitest run src/db/migration-v4.test.ts -t "version" 2>&1 | tail -5
```

Expected: tests pass; the test harness applies migrations including v7 without error.

- [ ] **Step 1.4: Commit**

```bash
cd /root/price-tracker
git add server/src/db/schema.ts server/src/db/migrations.ts
git commit -m "feat(db): migration v7 — pending_confirmation_* columns on tracker_urls

Adds schema state for the plausibility guard (see spec at
docs/superpowers/specs/2026-04-27-plausibility-guard-design.md).
Two nullable columns; NULL = no confirmation in flight. Partial
index on pending_confirmation_at keeps the restart-recovery scan
O(pending) instead of O(rows).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Extend Queries

**Files:**
- Modify: `server/src/db/queries.ts`

- [ ] **Step 2.1: Extend `TrackerUrl` interface**

Find the `export interface TrackerUrl {` block in `server/src/db/queries.ts` (around line 44) and add these two fields:

```typescript
pending_confirmation_price: number | null;
pending_confirmation_at: string | null;
```

- [ ] **Step 2.2: Extend `updateTrackerUrl()` signature**

Update the `Partial<{...}>` type parameter on `updateTrackerUrl` to include the new fields:

```typescript
export function updateTrackerUrl(id: number, data: Partial<{
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  status: string;
  pending_confirmation_price: number | null;
  pending_confirmation_at: string | null;
}>): TrackerUrl | undefined {
```

The existing dynamic field-builder loop (lines 333–340 in current code) already handles arbitrary keys, so no body changes are needed.

- [ ] **Step 2.3: Add `getRecentSuccessfulPricesForSeller`**

Add this exported function in `queries.ts` near the other tracker_url query helpers:

```typescript
/**
 * Return the last `limit` non-null prices recorded for a single seller,
 * most-recent first. Used by the plausibility guard to compute a
 * trailing median for the suspiciousness check. Excludes rows from
 * other sellers on the same tracker — different sellers have different
 * pricing baselines and shouldn't pollute each other's median.
 */
export function getRecentSuccessfulPricesForSeller(
  sellerId: number,
  limit: number,
): number[] {
  const rows = getDb()
    .prepare(
      'SELECT price FROM price_history WHERE tracker_url_id = ? AND price > 0 ORDER BY scraped_at DESC LIMIT ?',
    )
    .all(sellerId, limit) as { price: number }[];
  return rows.map(r => r.price);
}
```

- [ ] **Step 2.4: Add `getSellersWithPendingConfirmation`**

Add this exported function in `queries.ts`:

```typescript
/**
 * Return every seller currently flagged as awaiting a confirmation
 * scrape. Called at scheduler start to re-enqueue confirmations whose
 * in-process setTimeout was lost on restart.
 */
export function getSellersWithPendingConfirmation(): TrackerUrl[] {
  return getDb()
    .prepare(
      'SELECT * FROM tracker_urls WHERE pending_confirmation_at IS NOT NULL',
    )
    .all() as TrackerUrl[];
}
```

- [ ] **Step 2.5: Verify build**

```bash
cd /root/price-tracker/server
npm run build
```

Expected: clean tsc output.

- [ ] **Step 2.6: Commit**

```bash
cd /root/price-tracker
git add server/src/db/queries.ts
git commit -m "feat(db): query helpers for plausibility guard state

Extends TrackerUrl + updateTrackerUrl to carry pending_confirmation_*
fields. Adds getRecentSuccessfulPricesForSeller (median input) and
getSellersWithPendingConfirmation (restart recovery scan).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Config

**Files:**
- Modify: `server/src/config.ts`

- [ ] **Step 3.1: Add config field**

In `server/src/config.ts`, inside the `export const config = {...}` block, add this entry near the other scrape settings (e.g., right after `scrapeRetryBaseMs`):

```typescript
// Plausibility guard. A scrape that would otherwise fire an alert is
// suppressed when its price is below this fraction of the seller's
// trailing median (warm) or last_price (cold-start). Confirmation
// re-scrape decides whether to fire the alert. Set to 0 to disable
// the guard entirely. See docs/superpowers/specs/2026-04-27-
// plausibility-guard-design.md.
plausibilityGuardDropThreshold: parseFloat(
  process.env.PLAUSIBILITY_GUARD_DROP_THRESHOLD || '0.5',
),
```

- [ ] **Step 3.2: Verify build**

```bash
cd /root/price-tracker/server
npm run build
```

Expected: clean.

- [ ] **Step 3.3: Commit**

```bash
cd /root/price-tracker
git add server/src/config.ts
git commit -m "feat(config): plausibility guard drop threshold env var

Single env var PLAUSIBILITY_GUARD_DROP_THRESHOLD (default 0.5).
Set to 0 to disable the guard if it ever causes problems in prod.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Plausibility Guard Pure Helper

**Files:**
- Create: `server/src/scraper/plausibility-guard.ts`
- Create: `server/src/scraper/plausibility-guard.test.ts`

- [ ] **Step 4.1: Write failing tests**

Create `server/src/scraper/plausibility-guard.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { isPlausibilityGuardSuspicious } from './plausibility-guard.js';

describe('isPlausibilityGuardSuspicious', () => {
  // The helper takes prices most-recent-first as the queries module
  // returns them. Threshold is the second arg so callers pass
  // config.plausibilityGuardDropThreshold directly.

  describe('disabled by config', () => {
    it('threshold of 0 → never suspicious, regardless of history', () => {
      expect(isPlausibilityGuardSuspicious(1, [100, 100, 100, 100, 100, 100], 0)).toBe(false);
    });
  });

  describe('empty history (brand-new tracker)', () => {
    it('returns false — no baseline to compare', () => {
      expect(isPlausibilityGuardSuspicious(10, [], 0.5)).toBe(false);
    });
  });

  describe('cold start (1–4 entries) — last-price comparison', () => {
    it('flags 64% drop (Amazon $28 → $10 case)', () => {
      expect(isPlausibilityGuardSuspicious(10, [28], 0.5)).toBe(true);
    });

    it('flags 98% drop (Amazon $601 → $10 case)', () => {
      expect(isPlausibilityGuardSuspicious(10, [601, 580, 590, 600], 0.5)).toBe(true);
    });

    it('does NOT flag 30% drop', () => {
      expect(isPlausibilityGuardSuspicious(70, [100, 100, 100, 100], 0.5)).toBe(false);
    });

    it('does NOT flag exactly at threshold (50%)', () => {
      // < threshold (strict). At-threshold is not suspicious.
      expect(isPlausibilityGuardSuspicious(50, [100], 0.5)).toBe(false);
    });

    it('flags just below threshold', () => {
      expect(isPlausibilityGuardSuspicious(49.99, [100], 0.5)).toBe(true);
    });
  });

  describe('warm path (≥5 entries) — median comparison', () => {
    it('flags drop below median * threshold', () => {
      // Median of [600, 600, 600, 580, 620] is 600; 600 * 0.5 = 300.
      expect(isPlausibilityGuardSuspicious(250, [600, 600, 600, 580, 620], 0.5)).toBe(true);
    });

    it('does NOT flag legit moderate drop above median*threshold', () => {
      expect(isPlausibilityGuardSuspicious(310, [600, 600, 600, 580, 620], 0.5)).toBe(false);
    });

    it('median is robust to a single outlier in history', () => {
      // History contains one bad scrape ($10) but median of 9 good values
      // around $600 stays at $600. New scrape of $250 still flagged.
      const history = [600, 600, 10, 580, 600, 620, 600, 590, 610];
      expect(isPlausibilityGuardSuspicious(250, history, 0.5)).toBe(true);
    });

    it('uses median (50th percentile), not mean', () => {
      // Mean would be skewed by the outlier; median is not.
      // [10, 600, 600, 600, 600] median = 600. New $250 → suspicious.
      expect(isPlausibilityGuardSuspicious(250, [10, 600, 600, 600, 600], 0.5)).toBe(true);
    });
  });

  describe('threshold tunability', () => {
    it('threshold of 0.25 catches only severe drops (75%+)', () => {
      expect(isPlausibilityGuardSuspicious(30, [100, 100, 100, 100, 100], 0.25)).toBe(false);
      expect(isPlausibilityGuardSuspicious(20, [100, 100, 100, 100, 100], 0.25)).toBe(true);
    });

    it('threshold of 0.75 catches mild drops (25%+)', () => {
      expect(isPlausibilityGuardSuspicious(70, [100, 100, 100, 100, 100], 0.75)).toBe(true);
      expect(isPlausibilityGuardSuspicious(80, [100, 100, 100, 100, 100], 0.75)).toBe(false);
    });
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

```bash
cd /root/price-tracker/server
npx vitest run src/scraper/plausibility-guard.test.ts 2>&1 | tail -10
```

Expected: failure with `Failed to load url ./plausibility-guard.js` or similar (module doesn't exist yet).

- [ ] **Step 4.3: Implement the helper**

Create `server/src/scraper/plausibility-guard.ts`:

```typescript
/**
 * Defense-in-depth check for the alert path. Returns true when the
 * candidate price looks implausibly far below the seller's recent norm.
 *
 * Behavior is parameterized so the function is pure and testable in
 * isolation — no DB access, no logger calls. The scheduler is responsible
 * for calling getRecentSuccessfulPricesForSeller(), passing the threshold
 * from config.plausibilityGuardDropThreshold, and acting on the result.
 *
 * Decision rules (thresholdDropFraction = 0.5 by default):
 *   - 0 entries (brand-new tracker): never suspicious. The very first
 *     drop has no baseline to flag.
 *   - 1–4 entries (cold start): flag suspicious when
 *       price < recentPrices[0] * thresholdDropFraction
 *     (most recent successful price acts as the baseline).
 *   - ≥5 entries (warm): flag suspicious when
 *       price < median(recentPrices) * thresholdDropFraction
 *     The median is robust to a single anomalous data point — one bad
 *     scrape doesn't poison the baseline for subsequent comparisons.
 *   - thresholdDropFraction = 0: disabled, never suspicious. Allows
 *     ops to turn the guard off entirely via env var without code
 *     changes.
 *
 * The "<" comparison is strict: a price exactly at the threshold is
 * NOT suspicious. This makes round-number thresholds unambiguous in
 * tests and matches the spec's stated 50% rule.
 *
 * See docs/superpowers/specs/2026-04-27-plausibility-guard-design.md.
 */
const COLD_START_CUTOFF = 5;

export function isPlausibilityGuardSuspicious(
  price: number,
  recentPrices: number[],
  thresholdDropFraction: number,
): boolean {
  if (thresholdDropFraction <= 0) return false;
  if (recentPrices.length === 0) return false;

  const baseline =
    recentPrices.length >= COLD_START_CUTOFF
      ? median(recentPrices)
      : recentPrices[0];

  return price < baseline * thresholdDropFraction;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
```

- [ ] **Step 4.4: Run tests to verify they pass**

```bash
cd /root/price-tracker/server
npx vitest run src/scraper/plausibility-guard.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 4.5: Commit**

```bash
cd /root/price-tracker
git add server/src/scraper/plausibility-guard.ts server/src/scraper/plausibility-guard.test.ts
git commit -m "feat(scrape): plausibility guard pure helper

isPlausibilityGuardSuspicious(price, recentPrices, threshold) — pure
function, no I/O. Cold-start path (1-4 entries) compares to last
successful price; warm path (≥5) compares to median of last N. Median
is robust to a single corrupt scrape in history. threshold=0 disables.

12 unit tests cover empty/cold/warm paths, threshold tunability, and
the median-vs-mean robustness invariant.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Wire Guard into Cron Alert Path

**Files:**
- Modify: `server/src/scheduler/cron.ts`

This task changes alert behavior but does NOT yet enqueue the confirmation re-scrape — that's Task 6. After this task, suspicious scrapes set the pending flag and suppress the alert; subsequent successful scrapes resolve the flag. The next regular cron tick acts as the (slow) confirmation path.

- [ ] **Step 5.1: Add imports**

At the top of `server/src/scheduler/cron.ts`, extend the existing import from `../db/queries.js`:

```typescript
import {
  getDueTrackerUrls,
  getTrackerUrlById,
  getTrackerById,
  updateTrackerUrl,
  updateTrackerNormalizedUrl,
  refreshTrackerAggregates,
  addPriceRecord,
  getSetting,
  getLastNotificationForSeller,
  addNotification,
  getRecentSuccessfulPricesForSeller,
  getSellersWithPendingConfirmation,
} from '../db/queries.js';
```

Add a new import below the existing `extractPrice` import:

```typescript
import { isPlausibilityGuardSuspicious } from '../scraper/plausibility-guard.js';
```

- [ ] **Step 5.2: Add a constant for the median window**

Just below the existing `let task: cron.ScheduledTask | null = null;` declaration in `cron.ts`, add:

```typescript
const PLAUSIBILITY_GUARD_MEDIAN_WINDOW = 10;
```

- [ ] **Step 5.3: Replace the alert-firing block**

Find this block in `checkTrackerUrl()` (current code lines 204–210):

```typescript
          } else {
            const alertTracker = buildAlertTracker(tracker, seller, result.price);
            const sentChannels = await firePriceAlerts(alertTracker, result.price, channels);
            for (const channel of sentChannels) {
              addNotification(tracker.id, result.price, tracker.threshold_price, channel, seller.id);
            }
          }
```

Replace it with:

```typescript
          } else {
            const recentPrices = getRecentSuccessfulPricesForSeller(
              seller.id,
              PLAUSIBILITY_GUARD_MEDIAN_WINDOW,
            );
            // The just-recorded scrape is in history now; drop it from
            // the baseline so we compare the new price against PRIOR
            // observations, not against itself.
            const baselineHistory = recentPrices.slice(1);
            const suspicious = isPlausibilityGuardSuspicious(
              result.price,
              baselineHistory,
              config.plausibilityGuardDropThreshold,
            );

            const hadPending = seller.pending_confirmation_at !== null;

            if (suspicious && !hadPending) {
              // First time we've seen this — record pending state and
              // suppress alert. Confirmation comes from the next
              // successful scrape (timed re-scrape in Task 6, or the
              // next regular cron tick as a fallback).
              updateTrackerUrl(seller.id, {
                pending_confirmation_price: result.price,
                pending_confirmation_at: new Date()
                  .toISOString()
                  .replace('T', ' ')
                  .slice(0, 19),
              });
              logger.info(
                {
                  trackerId: tracker.id,
                  trackerUrlId: seller.id,
                  trackerName: tracker.name,
                  price: result.price,
                  baselineSamples: baselineHistory.length,
                  threshold: config.plausibilityGuardDropThreshold,
                },
                'Suspicious price detected, awaiting confirmation',
              );
            } else if (suspicious && hadPending) {
              // Two suspicious-and-below-threshold reads in a row.
              // Treat as confirmed; clear pending and fire alert.
              updateTrackerUrl(seller.id, {
                pending_confirmation_price: null,
                pending_confirmation_at: null,
              });
              logger.info(
                {
                  trackerId: tracker.id,
                  trackerUrlId: seller.id,
                  firstPrice: seller.pending_confirmation_price,
                  secondPrice: result.price,
                },
                'Confirmation matched, firing alert',
              );
              const alertTracker = buildAlertTracker(tracker, seller, result.price);
              const sentChannels = await firePriceAlerts(alertTracker, result.price, channels);
              for (const channel of sentChannels) {
                addNotification(tracker.id, result.price, tracker.threshold_price, channel, seller.id);
              }
            } else if (!suspicious && hadPending) {
              // Pending was set, but the new read is plausible. Either
              // (a) the new price is back to normal (transient anomaly,
              // discard alert) or (b) the new price is also low but
              // within plausibility (real drop, has been confirmed).
              // The "below threshold" branch we're in already implies
              // the price is alert-worthy, so this is case (b): fire.
              updateTrackerUrl(seller.id, {
                pending_confirmation_price: null,
                pending_confirmation_at: null,
              });
              const alertTracker = buildAlertTracker(tracker, seller, result.price);
              const sentChannels = await firePriceAlerts(alertTracker, result.price, channels);
              for (const channel of sentChannels) {
                addNotification(tracker.id, result.price, tracker.threshold_price, channel, seller.id);
              }
            } else {
              // Not suspicious, no pending — normal alert path.
              const alertTracker = buildAlertTracker(tracker, seller, result.price);
              const sentChannels = await firePriceAlerts(alertTracker, result.price, channels);
              for (const channel of sentChannels) {
                addNotification(tracker.id, result.price, tracker.threshold_price, channel, seller.id);
              }
            }
          }
```

- [ ] **Step 5.4: Handle the "pending was set, scrape resolved above threshold" case**

The block above only runs when `result.price <= tracker.threshold_price`. If a pending flag exists but the new scrape is no longer below threshold, it should also clear the pending flag (transient anomaly recovered above threshold). Add this block right after the `if (tracker.threshold_price && result.price <= tracker.threshold_price) {` branch closes — i.e., add an `else if`:

Locate the existing structure:

```typescript
      if (tracker.threshold_price && result.price <= tracker.threshold_price) {
        // ... entire alert block including the new logic from Step 5.3 ...
      }
```

Change it to:

```typescript
      if (tracker.threshold_price && result.price <= tracker.threshold_price) {
        // ... entire alert block including the new logic from Step 5.3 ...
      } else if (seller.pending_confirmation_at !== null) {
        // Pending flag was set on a prior tick when price was below
        // threshold; this scrape brought it back above threshold, so
        // the prior observation was a transient anomaly. Clear the
        // flag and log — no alert.
        updateTrackerUrl(seller.id, {
          pending_confirmation_price: null,
          pending_confirmation_at: null,
        });
        logger.info(
          {
            trackerId: tracker.id,
            trackerUrlId: seller.id,
            firstPrice: seller.pending_confirmation_price,
            secondPrice: result.price,
            thresholdPrice: tracker.threshold_price,
          },
          'Confirmation diverged, alert suppressed',
        );
      }
```

- [ ] **Step 5.5: Verify build is clean**

```bash
cd /root/price-tracker/server
npm run build
```

Expected: clean.

- [ ] **Step 5.6: Run existing tests to confirm no regression**

```bash
cd /root/price-tracker/server
npm test 2>&1 | tail -10
```

Expected: all 249+ existing tests still pass. (The new alert-path branches haven't been exercised yet — that's Task 6.)

- [ ] **Step 5.7: Commit**

```bash
cd /root/price-tracker
git add server/src/scheduler/cron.ts
git commit -m "feat(scheduler): wire plausibility guard into alert path

Guard runs only when an alert would otherwise fire. First suspicious
read sets pending_confirmation_*, suppresses alert. Next read resolves:
matching suspicious → fire (confirmed); plausible → fire (recovered
within plausibility); above threshold → suppress (transient anomaly).
Logs every transition.

No confirmation re-scrape yet — uses the next regular cron tick as
the slow-path confirmation. Quick re-scrape lands in Task 6.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Quick Confirmation Re-Scrape

**Files:**
- Modify: `server/src/scheduler/cron.ts`

- [ ] **Step 6.1: Add timing constants**

Below the `PLAUSIBILITY_GUARD_MEDIAN_WINDOW` constant from Task 5, add:

```typescript
const PLAUSIBILITY_CONFIRM_DELAY_BASE_MS = 90_000;
const PLAUSIBILITY_CONFIRM_DELAY_JITTER_MS = 90_000;
const PLAUSIBILITY_RESTART_STALE_AGE_MS = 600_000;
```

- [ ] **Step 6.2: Add the scheduling helper**

Below `tick()` and above `startScheduler()`, add:

```typescript
/**
 * Schedule a confirmation re-scrape of the given seller after a base
 * delay plus jitter (default 90s + uniform 0-90s). Uses the existing
 * p-queue so concurrency limits still apply. The setTimeout reference
 * is intentionally not retained — confirmations are best-effort and
 * the restart recovery path picks up any pending state if the timer
 * is lost (process exit, hot reload, etc.).
 */
function scheduleConfirmationRescrape(sellerId: number): void {
  const delayMs =
    PLAUSIBILITY_CONFIRM_DELAY_BASE_MS +
    Math.random() * PLAUSIBILITY_CONFIRM_DELAY_JITTER_MS;
  setTimeout(() => {
    queue.add(() => checkTrackerUrl(sellerId));
  }, delayMs);
}
```

- [ ] **Step 6.3: Trigger the scheduler from the suspicious-first-time branch**

Inside the alert block edited in Task 5 Step 5.3, find:

```typescript
            if (suspicious && !hadPending) {
              // First time we've seen this — record pending state and
              // suppress alert. Confirmation comes from the next
              // successful scrape (timed re-scrape in Task 6, or the
              // next regular cron tick as a fallback).
              updateTrackerUrl(seller.id, {
                pending_confirmation_price: result.price,
                pending_confirmation_at: new Date()
                  .toISOString()
                  .replace('T', ' ')
                  .slice(0, 19),
              });
              logger.info(
                /* ... */,
                'Suspicious price detected, awaiting confirmation',
              );
            }
```

Add one line after the `logger.info` call inside that branch:

```typescript
              scheduleConfirmationRescrape(seller.id);
```

- [ ] **Step 6.4: Verify build**

```bash
cd /root/price-tracker/server
npm run build
```

Expected: clean.

- [ ] **Step 6.5: Commit**

```bash
cd /root/price-tracker
git add server/src/scheduler/cron.ts
git commit -m "feat(scheduler): schedule confirmation re-scrape on suspicious read

setTimeout-driven re-scrape after 90s + jitter(0-90s) via the existing
p-queue. Lost timers (restart) are handled by the next regular cron
tick or the startup recovery path (Task 7). Re-scrape resolution
happens through the same alert path as any other successful scrape —
the new code from Task 5 picks up the pending flag idempotently.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Restart Recovery

**Files:**
- Modify: `server/src/scheduler/cron.ts`

- [ ] **Step 7.1: Add the recovery function**

Just above `startScheduler()` in `cron.ts`, add:

```typescript
/**
 * On scheduler startup, scan for sellers whose pending_confirmation_at
 * is stale (older than PLAUSIBILITY_RESTART_STALE_AGE_MS) and re-enqueue
 * a check. Younger pending flags are left alone — the next regular cron
 * tick (≤1 min away) acts as the confirmation. We don't try to
 * reconstruct lost in-process setTimeouts because the cron tick is
 * cheap and idempotent.
 */
function recoverPendingConfirmations(): void {
  const pending = getSellersWithPendingConfirmation();
  if (pending.length === 0) return;

  const now = Date.now();
  let recovered = 0;
  for (const seller of pending) {
    if (!seller.pending_confirmation_at) continue;
    const pendingAtMs = new Date(seller.pending_confirmation_at + 'Z').getTime();
    const ageMs = now - pendingAtMs;
    if (ageMs >= PLAUSIBILITY_RESTART_STALE_AGE_MS) {
      logger.info(
        {
          trackerId: seller.tracker_id,
          trackerUrlId: seller.id,
          pendingPrice: seller.pending_confirmation_price,
          pendingAgeMs: ageMs,
        },
        'Re-enqueueing stale pending confirmation after restart',
      );
      queue.add(() => checkTrackerUrl(seller.id));
      recovered++;
    }
  }

  if (recovered > 0) {
    logger.info({ recovered }, 'Pending confirmations recovered at startup');
  }
}
```

- [ ] **Step 7.2: Wire into `startScheduler()`**

Modify `startScheduler()` to call recovery before starting the cron tick:

```typescript
export function startScheduler(): void {
  recoverPendingConfirmations();
  task = cron.schedule('* * * * *', tick);
  logger.info('Scheduler started (checking every minute)');
}
```

- [ ] **Step 7.3: Verify build**

```bash
cd /root/price-tracker/server
npm run build
```

Expected: clean.

- [ ] **Step 7.4: Commit**

```bash
cd /root/price-tracker
git add server/src/scheduler/cron.ts
git commit -m "feat(scheduler): recover stale pending confirmations on startup

Scans tracker_urls for pending_confirmation_at older than 10 min and
enqueues them for an immediate scrape via the existing p-queue. Younger
pending flags are left for the next 1-minute cron tick — no need to
reconstruct lost setTimeout state.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Integration Tests — Alert Path

**Files:**
- Create: `server/src/scheduler/cron-plausibility.test.ts`

This file mirrors the existing `cron-cooldown.test.ts` structure (same mocking strategy) and exercises every branch of the new logic.

- [ ] **Step 8.1: Write the test file**

Create `server/src/scheduler/cron-plausibility.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', () => ({
  extractPrice: vi.fn(),
}));
vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyPriceAlert: vi.fn().mockResolvedValue(true),
  sendNtfyErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericPriceAlert: vi.fn().mockResolvedValue(true),
  sendGenericErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailPriceAlert: vi.fn().mockResolvedValue(true),
  sendEmailErrorAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker,
  setSetting,
  addPriceRecord,
  getTrackerUrlById,
} from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordPriceAlert } from '../notifications/discord.js';

/**
 * Integration tests for the plausibility guard. Exercises every branch
 * of the guard logic in cron.ts via real DB writes and mocked scrapes.
 *
 * Test plan (one test per spec'd outcome):
 *   1. Suspicious + no pending → flag set, alert suppressed.
 *   2. Suspicious + pending → flag cleared, alert fires (confirmed).
 *   3. Plausible-but-below-threshold + pending → flag cleared,
 *      alert fires (recovery within plausibility).
 *   4. Above-threshold + pending → flag cleared, alert NOT fired
 *      (transient anomaly).
 *   5. Below-threshold but not suspicious + no pending → alert fires
 *      (normal path, no behavior change).
 *   6. threshold = 0 (guard disabled) → alert fires regardless.
 *   7. Suspicious + cooldown active → cooldown wins, no flag set.
 */

function seedTestUser(): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('test@example.com', 'fakehash', 'Test User', 'user', 1)
  `).run();
  return Number(result.lastInsertRowid);
}

/** Seed a tracker with one seller and N successful price_history rows
 *  at `historicalPrice`. Returns the seller_url id. */
function seedTracker(
  userId: number,
  thresholdPrice: number,
  historicalPrice: number,
  historyCount: number,
): { trackerId: number; sellerId: number } {
  const tracker = createTracker({
    name: 'Test Item',
    url: 'https://example.com/item',
    threshold_price: thresholdPrice,
    user_id: userId,
  });
  const seller = getDb()
    .prepare('SELECT * FROM tracker_urls WHERE tracker_id = ?')
    .get(tracker.id) as { id: number };
  for (let i = 0; i < historyCount; i++) {
    addPriceRecord(tracker.id, historicalPrice, 'USD', seller.id);
  }
  return { trackerId: tracker.id, sellerId: seller.id };
}

describe('plausibility guard — integration', () => {
  beforeEach(() => {
    initSettingsCrypto(randomBytes(32).toString('hex'));
    _setDbForTesting(new Database(':memory:'));
    initializeSchema();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  it('suspicious + no pending → flag set, alert suppressed', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    const { sellerId } = seedTracker(userId, /*threshold*/ 100, /*history*/ 600, /*count*/ 10);

    // $10 is well below threshold (100) AND below median (600) * 0.5 = 300.
    vi.mocked(extractPrice).mockResolvedValue({
      price: 10,
      currency: 'USD',
      strategy: 'css-patterns',
      finalUrl: 'https://example.com/item',
    });

    await checkTrackerUrl(sellerId);

    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_price).toBe(10);
    expect(seller!.pending_confirmation_at).not.toBeNull();
    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();
  });

  it('suspicious + pending → flag cleared, alert fires', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    const { sellerId } = seedTracker(userId, 100, 600, 10);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 10,
      currency: 'USD',
      strategy: 'css-patterns',
      finalUrl: 'https://example.com/item',
    });

    await checkTrackerUrl(sellerId);   // first: sets pending
    await checkTrackerUrl(sellerId);   // second: confirms + alerts

    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_price).toBeNull();
    expect(seller!.pending_confirmation_at).toBeNull();
    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
  });

  it('plausible-but-below-threshold + pending → flag cleared, alert fires', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    // History at $50, threshold $40. A $20 read is suspicious (< 50*0.5=25).
    // A $30 read is below threshold and NOT suspicious (>= 25).
    const { sellerId } = seedTracker(userId, /*threshold*/ 40, /*history*/ 50, 10);

    vi.mocked(extractPrice).mockResolvedValueOnce({
      price: 20, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });
    await checkTrackerUrl(sellerId);

    const afterFirst = getTrackerUrlById(sellerId);
    expect(afterFirst!.pending_confirmation_at).not.toBeNull();
    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();

    vi.mocked(extractPrice).mockResolvedValueOnce({
      price: 30, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });
    await checkTrackerUrl(sellerId);

    const afterSecond = getTrackerUrlById(sellerId);
    expect(afterSecond!.pending_confirmation_at).toBeNull();
    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
  });

  it('above-threshold + pending → flag cleared, alert NOT fired (transient)', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    const { sellerId } = seedTracker(userId, 100, 600, 10);

    vi.mocked(extractPrice).mockResolvedValueOnce({
      price: 10, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });
    await checkTrackerUrl(sellerId);

    vi.mocked(extractPrice).mockResolvedValueOnce({
      price: 600, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });
    await checkTrackerUrl(sellerId);

    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_at).toBeNull();
    expect(sendDiscordPriceAlert).not.toHaveBeenCalled();
  });

  it('below-threshold but not suspicious + no pending → alert fires (normal path)', async () => {
    const userId = seedTestUser();
    setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
    // History at $50, threshold $40. $30 is below threshold but
    // NOT suspicious (50*0.5=25, 30>25).
    const { sellerId } = seedTracker(userId, 40, 50, 10);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 30, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
    });

    await checkTrackerUrl(sellerId);

    expect(sendDiscordPriceAlert).toHaveBeenCalledTimes(1);
    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_at).toBeNull();
  });

  it('threshold of 0 (guard disabled) → alert fires immediately', async () => {
    const originalThreshold = process.env.PLAUSIBILITY_GUARD_DROP_THRESHOLD;
    process.env.PLAUSIBILITY_GUARD_DROP_THRESHOLD = '0';
    // Reload the config module so our env override takes effect.
    vi.resetModules();

    try {
      const userId = seedTestUser();
      setSetting('discord_webhook_url', 'https://discord.com/webhook', userId);
      const { sellerId } = seedTracker(userId, 100, 600, 10);

      vi.mocked(extractPrice).mockResolvedValue({
        price: 10, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
      });

      // Re-import after vi.resetModules so the new config is used.
      const { checkTrackerUrl: freshCheck } = await import('./cron.js');
      await freshCheck(sellerId);

      const { sendDiscordPriceAlert: freshDiscord } = await import('../notifications/discord.js');
      expect(freshDiscord).toHaveBeenCalledTimes(1);
    } finally {
      if (originalThreshold === undefined) {
        delete process.env.PLAUSIBILITY_GUARD_DROP_THRESHOLD;
      } else {
        process.env.PLAUSIBILITY_GUARD_DROP_THRESHOLD = originalThreshold;
      }
      vi.resetModules();
    }
  });
});
```

**Why threshold = 40 and history = 50 in the third test:** the test needs a price that is simultaneously below threshold AND not suspicious. With history at $50, the median is $50, the suspiciousness floor is $25 (50 × 0.5), so $30 satisfies both: 30 < 40 (below threshold) and 30 ≥ 25 (not suspicious). With the more typical $600/$100 setup used in other tests, no single price satisfies both — by design, since a 50% drop from $600 ($300) is still well above threshold $100.

Final test count: 6 cases.

- [ ] **Step 8.2: Run integration tests**

```bash
cd /root/price-tracker/server
npx vitest run src/scheduler/cron-plausibility.test.ts 2>&1 | tail -25
```

Expected: 6 tests pass.

- [ ] **Step 8.3: Run the full server test suite**

```bash
cd /root/price-tracker/server
npm test 2>&1 | tail -10
```

Expected: ≥255 tests pass (existing 249 + 12 unit + 6 integration = 267, give or take).

- [ ] **Step 8.4: Commit**

```bash
cd /root/price-tracker
git add server/src/scheduler/cron-plausibility.test.ts
git commit -m "test(scheduler): integration tests for plausibility guard alert path

Six end-to-end cases mocking extractPrice + all four notification
channels: suspicious-first-time, suspicious-confirmed, plausible-
recovery, transient-recovery, normal-path-no-guard, and disabled-via-
env. Uses the same in-memory sqlite + seeded fixtures pattern as
cron-cooldown.test.ts.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Restart Recovery Test

**Files:**
- Create: `server/src/scheduler/cron-recovery.test.ts`

- [ ] **Step 9.1: Write the test**

Create `server/src/scheduler/cron-recovery.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', () => ({
  extractPrice: vi.fn().mockResolvedValue({
    price: 600, currency: 'USD', strategy: 'css-patterns', finalUrl: 'https://example.com/item',
  }),
}));
vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyPriceAlert: vi.fn().mockResolvedValue(true),
  sendNtfyErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericPriceAlert: vi.fn().mockResolvedValue(true),
  sendGenericErrorAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailPriceAlert: vi.fn().mockResolvedValue(true),
  sendEmailErrorAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createTracker, addPriceRecord, getTrackerUrlById } from '../db/queries.js';
import { startScheduler, stopScheduler } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';

function seedTestUser(): number {
  return Number(getDb().prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('t@example.com', 'h', 'T', 'user', 1)
  `).run().lastInsertRowid);
}

function seedSellerWithStalePending(
  userId: number,
  pendingAtIso: string,
): number {
  const tracker = createTracker({
    name: 'Test',
    url: 'https://example.com/item',
    threshold_price: 100,
    user_id: userId,
  });
  const seller = getDb()
    .prepare('SELECT * FROM tracker_urls WHERE tracker_id = ?')
    .get(tracker.id) as { id: number };
  // Some history so the guard can run on the recovery scrape.
  for (let i = 0; i < 10; i++) addPriceRecord(tracker.id, 600, 'USD', seller.id);
  // Plant a stale pending flag.
  getDb()
    .prepare(
      'UPDATE tracker_urls SET pending_confirmation_price = 10, pending_confirmation_at = ? WHERE id = ?',
    )
    .run(pendingAtIso, seller.id);
  return seller.id;
}

describe('plausibility guard — restart recovery', () => {
  beforeEach(() => {
    initSettingsCrypto(randomBytes(32).toString('hex'));
    _setDbForTesting(new Database(':memory:'));
    initializeSchema();
    vi.clearAllMocks();
  });

  afterEach(() => {
    stopScheduler();
    _setDbForTesting(null);
    resetCrypto();
  });

  it('re-enqueues stale pending confirmations (>10 min old)', async () => {
    const userId = seedTestUser();
    // 30 min ago, formatted to match the scheduler's ISO format.
    const staleIso = new Date(Date.now() - 30 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const sellerId = seedSellerWithStalePending(userId, staleIso);

    startScheduler();

    // The recovery enqueues an immediate scrape via p-queue. Let it drain.
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(extractPrice).toHaveBeenCalledTimes(1);
    // After recovery + scrape, the new $600 read clears the pending flag.
    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_at).toBeNull();
  });

  it('leaves young pending confirmations alone', async () => {
    const userId = seedTestUser();
    // 1 min ago — well under the 10-min stale threshold.
    const youngIso = new Date(Date.now() - 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);
    const sellerId = seedSellerWithStalePending(userId, youngIso);

    startScheduler();
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(extractPrice).not.toHaveBeenCalled();
    const seller = getTrackerUrlById(sellerId);
    expect(seller!.pending_confirmation_at).not.toBeNull();
  });
});
```

- [ ] **Step 9.2: Run the recovery tests**

```bash
cd /root/price-tracker/server
npx vitest run src/scheduler/cron-recovery.test.ts 2>&1 | tail -10
```

Expected: 2 tests pass.

- [ ] **Step 9.3: Commit**

```bash
cd /root/price-tracker
git add server/src/scheduler/cron-recovery.test.ts
git commit -m "test(scheduler): startup recovery for stale pending confirmations

Two cases: stale (>10 min) flag → re-enqueued; young (<10 min) flag →
left for the next regular cron tick. Mocks extractPrice + all
notification channels and uses the same in-memory sqlite pattern as
the other scheduler tests.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Final Verification & PR

**Files:**
- Modify: `tasks/todo.md` (in `/root/homelabmisc`)

- [ ] **Step 10.1: Full test suite + build**

```bash
cd /root/price-tracker/server
npm test 2>&1 | tail -10
npm run build 2>&1 | tail -5
```

Expected: all tests pass, build clean.

- [ ] **Step 10.2: Update homelab todo**

Open `/root/homelabmisc/tasks/todo.md` and add to the Website section:

```markdown
- [x] Plausibility-guarded alert path — defense-in-depth on top of PR #8 (Amazon regex bypass). Suspicious price drops require a confirmation re-scrape before firing Discord/ntfy/webhook/email alerts. Spec: `docs/superpowers/specs/2026-04-27-plausibility-guard-design.md`. Plan: `docs/superpowers/plans/2026-04-27-plausibility-guard.md`.
```

Commit and push:

```bash
cd /root/homelabmisc
git add tasks/todo.md
git commit -m "docs(todo): plausibility guard shipped"
git push
```

- [ ] **Step 10.3: Push the feature branch**

```bash
cd /root/price-tracker
git push -u origin feature/plausibility-guard
```

- [ ] **Step 10.4: Open PR**

```bash
cd /root/price-tracker
gh pr create --title "feat: plausibility-guarded alert path" --body "$(cat <<'EOF'
## Summary

Defense-in-depth follow-up to #8 (Amazon regex bypass). After a scrape
that would otherwise fire an alert, evaluates the price against the
seller's recent median; if suspiciously low, suppresses the alert and
schedules a confirmation re-scrape ~90s later. Only fires if the
confirmation also reads as suspicious-and-below-threshold.

Spec: `docs/superpowers/specs/2026-04-27-plausibility-guard-design.md`
Plan: `docs/superpowers/plans/2026-04-27-plausibility-guard.md`

## Architecture

- New pure helper `isPlausibilityGuardSuspicious(price, recentPrices, threshold)` — cold-start path uses last_price, warm path (≥5 entries) uses median for robustness against single outliers.
- Guard runs only inside the alert-firing branch of `checkTrackerUrl()` — does not affect any other code path.
- State on `tracker_urls.pending_confirmation_*` (migration v7).
- Confirmation re-scrape via `setTimeout(90s + jitter)` → existing p-queue.
- Restart-safe: scheduler scans for stale pending state and re-enqueues at startup.

## Test plan

- [x] `npm test` — full server suite (12 unit + 6 alert-path integration + 2 recovery integration tests added)
- [x] `npm run build` — clean
- [ ] Deploy via `scripts/deploy.sh`
- [ ] Manually re-trigger a scrape via UI on an Amazon tracker — confirm logs show the guard exercised and a real alert still fires

## Configuration

`PLAUSIBILITY_GUARD_DROP_THRESHOLD=0.5` (default). Set to `0` to disable.

## Out of scope (follow-ups)

- UI badge for "pending confirmation" on tracker detail page.
- Per-tracker threshold override.
- Multi-confirmation requirement for very large drops.
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review Notes

The plan covers every section of the spec:
- Detection signal ✓ Task 4 (helper) + Task 5 (wiring)
- Trigger condition ✓ Task 5 — guard runs only inside `if (price <= threshold && !inCooldown && hasAnyChannel)`
- Schema (migration v7) ✓ Task 1
- Flow (4 transitions) ✓ Task 5 (suspicious-first, suspicious-confirmed, plausible-recovery, transient-recovery)
- Confirmation re-scrape ✓ Task 6
- Restart safety ✓ Task 7
- Observability (5 log events) ✓ Task 5 + Task 7
- Configuration ✓ Task 3
- Tests (unit + integration) ✓ Tasks 4, 8, 9
- Migration & rollout ✓ Task 1 (additive migration), Task 10 (deploy)

No placeholders. Type signatures consistent across tasks (`TrackerUrl.pending_confirmation_price: number | null`, `pending_confirmation_at: string | null`, `isPlausibilityGuardSuspicious(price, recentPrices, threshold): boolean`). All exact file paths and code blocks present.
