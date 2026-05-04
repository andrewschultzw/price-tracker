# AI Buyer's Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer a Claude-powered advisor over Price Tracker. Three capabilities in v1: BUY/WAIT/HOLD verdict pill on tracker cards, AI commentary appended to alerts, multi-sentence price-history summary on TrackerDetail.

**Architecture:** Rules-judge / LLM-narrate. Pure deterministic signals + verdict tree on the server (zero IO, fully unit-tested). Claude composes prose around the structured signals it is given. Inline async fire-and-forget on the scrape pipeline; nightly backfill cron for summaries. AI is decoration, never infrastructure — failures never block alerts or page loads.

**Tech Stack:** TypeScript, Express, better-sqlite3, vitest, node-cron, p-queue, `@anthropic-ai/sdk` (new), React + Tailwind on the client.

**Spec:** `docs/superpowers/specs/2026-05-04-ai-buyers-assistant-design.md`

**Branch:** `feature/ai-buyers-assistant`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `server/src/ai/types.ts` | Shared types: `Signals`, `Verdict`, `ReasonKey`, `AIGenerationError` |
| `server/src/ai/signals.ts` | Pure: `computeSignals(priceHistory, currentPrice, threshold) -> Signals \| null` |
| `server/src/ai/signals.test.ts` | Pure unit tests for every signal computation |
| `server/src/ai/verdict.ts` | Pure: `signalsToVerdict(signals) -> Verdict` |
| `server/src/ai/verdict.test.ts` | Pure unit tests for every rule branch |
| `server/src/ai/prompts.ts` | `buildVerdictPrompt`, `buildSummaryPrompt`, `buildAlertCopyPrompt` |
| `server/src/ai/prompts.test.ts` | Snapshot + structure tests for cached system blocks |
| `server/src/ai/client.ts` | Anthropic SDK wrapper. Single point of network IO + validation + retry |
| `server/src/ai/client.test.ts` | Tests for retry, length validation, kill switch behavior (mocked SDK) |
| `server/src/ai/generators.ts` | Orchestrators: `generateVerdictForTracker`, `generateSummaryForTracker`, `generateAlertCopy` |
| `server/src/ai/generators.test.ts` | Tests with injected mock client |
| `server/src/ai/backfill-cron.ts` | Nightly sweep — refreshes summaries older than 7 days |
| `server/src/ai/backfill-cron.test.ts` | Tests for staleness logic |
| `server/src/scripts/ai-smoke.ts` | Manual real-Claude smoke runner |
| `client/src/components/VerdictPill.tsx` | Color-coded pill component used on cards + detail |
| `client/src/components/AIInsightsCard.tsx` | TrackerDetail card section |

### Modified files

| Path | Change |
|---|---|
| `server/package.json` | Add `@anthropic-ai/sdk` dependency |
| `server/src/config.ts` | Add `aiEnabled`, `anthropicApiKey`, `aiModel` config |
| `server/src/db/migrations.ts` | Append migration v7 — adds AI columns to `trackers` |
| `server/src/db/queries.ts` | Add AI read/write helpers; update `Tracker` type |
| `server/src/db/migration-v7.test.ts` | New — migration up/idempotency test |
| `server/src/scheduler/cron.ts` | Fire-and-forget verdict regeneration on price change; alert-copy generation with 3s timeout |
| `server/src/scheduler/cron-ai.test.ts` | New — integration test for cron AI hooks |
| `server/src/notifications/discord.ts` | Optional `aiCommentary` parameter, appended to embed description |
| `server/src/notifications/ntfy.ts` | Optional `aiCommentary`, appended to message body |
| `server/src/notifications/email.ts` | Optional `aiCommentary`, appended to HTML + plaintext bodies |
| `server/src/notifications/webhook.ts` | Optional `aiCommentary`, included as JSON field |
| `server/src/notifications/discord.test.ts` | Add cases for `aiCommentary` present + absent |
| `server/src/notifications/email.test.ts` | Add cases for `aiCommentary` |
| `server/src/notifications/ntfy.test.ts` | New — basic rendering test (file does not exist today) |
| `server/src/notifications/webhook.test.ts` | New — basic rendering test (file does not exist today) |
| `server/src/routes/trackers.ts` | Include `ai_*` fields in tracker payloads |
| `server/src/index.ts` | Extend `/api/health` with admin-only AI fields |
| `client/src/components/TrackerCard.tsx` | Render `<VerdictPill>` next to current price |
| `client/src/pages/TrackerDetail.tsx` | Render `<AIInsightsCard>` above existing stat tiles |
| `client/src/api/trackers.ts` (or equivalent type file) | Extend tracker type with AI fields |
| `.env.production` | Add `AI_ENABLED=false`, `ANTHROPIC_API_KEY=`, `AI_MODEL=claude-haiku-4-5-20251001` |
| `.env.example` | Mirror the above |

---

## Task 1: Install Anthropic SDK + config wiring

**Files:**
- Modify: `server/package.json`
- Modify: `server/src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Install the SDK**

```bash
cd server && npm install @anthropic-ai/sdk@latest
```

Expected: `package.json` and `package-lock.json` updated; no peer dep warnings.

- [ ] **Step 2: Verify import works**

```bash
cd server && node -e "import('@anthropic-ai/sdk').then(m => console.log(Object.keys(m)))"
```

Expected: stdout includes `default`, `Anthropic` (or similar exports).

- [ ] **Step 3: Add AI config to `server/src/config.ts`**

Append to the config interface and exported object:

```ts
// server/src/config.ts (additions)
export const config = {
  // ... existing fields ...
  aiEnabled: process.env.AI_ENABLED === 'true',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
  aiAlertCopyTimeoutMs: 3000,
  aiSummaryStalenessDays: 7,
  aiVerdictMinDataDays: 14,
};
```

- [ ] **Step 4: Add env vars to `.env.example`**

```
# AI Buyer's Assistant (Claude API)
AI_ENABLED=false
ANTHROPIC_API_KEY=
AI_MODEL=claude-haiku-4-5-20251001
```

If `.env.production` is checked in, mirror the same values (key blank — operator fills in).

- [ ] **Step 5: Verify the build still type-checks**

```bash
cd server && npm run build
```

Expected: clean exit, no TS errors.

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config.ts .env.example
git commit -m "feat(ai): install Anthropic SDK and wire AI config

Adds @anthropic-ai/sdk and the AI_ENABLED / ANTHROPIC_API_KEY /
AI_MODEL env-driven config fields. Defaults to disabled.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Migration v7 — AI columns on trackers

**Files:**
- Modify: `server/src/db/migrations.ts`
- Create: `server/src/db/migration-v7.test.ts`

- [ ] **Step 1: Write the failing migration test**

Create `server/src/db/migration-v7.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import Database from 'better-sqlite3';

describe('migration v7 — AI columns on trackers', () => {
  beforeEach(() => {
    const db = new Database(':memory:');
    _setDbForTesting(db);
    runMigrations();
  });
  afterEach(() => {
    _setDbForTesting(null);
  });

  it('adds ai_verdict_tier column with NULL default', () => {
    const cols = getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string; dflt_value: string | null }[];
    const tier = cols.find(c => c.name === 'ai_verdict_tier');
    expect(tier).toBeDefined();
    expect(tier!.dflt_value).toBeNull();
  });

  it('adds all eight AI columns', () => {
    const cols = getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
    const names = cols.map(c => c.name);
    for (const expected of [
      'ai_verdict_tier',
      'ai_verdict_reason',
      'ai_verdict_reason_key',
      'ai_verdict_updated_at',
      'ai_summary',
      'ai_summary_updated_at',
      'ai_signals_json',
      'ai_failure_count',
    ]) {
      expect(names).toContain(expected);
    }
  });

  it('ai_failure_count defaults to 0', () => {
    const col = (getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string; dflt_value: string | null }[])
      .find(c => c.name === 'ai_failure_count');
    expect(col!.dflt_value).toBe('0');
  });

  it('migration v7 is idempotent', () => {
    runMigrations();
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
    const aiCols = cols.filter(c => c.name.startsWith('ai_'));
    expect(aiCols).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd server && npm test -- migration-v7
```

Expected: FAIL — `ai_verdict_tier` column not found.

- [ ] **Step 3: Append migration v7 to `server/src/db/migrations.ts`**

Inside the `migrations` array, after the v6 entry, add:

```ts
{
  version: 7,
  description: 'Add AI Buyer\'s Assistant columns to trackers',
  up: () => {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
    const colNames = new Set(cols.map(c => c.name));

    const additions: Array<[string, string]> = [
      ['ai_verdict_tier', 'TEXT'],
      ['ai_verdict_reason', 'TEXT'],
      ['ai_verdict_reason_key', 'TEXT'],
      ['ai_verdict_updated_at', 'INTEGER'],
      ['ai_summary', 'TEXT'],
      ['ai_summary_updated_at', 'INTEGER'],
      ['ai_signals_json', 'TEXT'],
      ['ai_failure_count', 'INTEGER NOT NULL DEFAULT 0'],
    ];

    for (const [name, type] of additions) {
      if (!colNames.has(name)) {
        db.prepare(`ALTER TABLE trackers ADD COLUMN ${name} ${type}`).run();
      }
    }
  },
},
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd server && npm test -- migration-v7
```

Expected: PASS, all four cases.

- [ ] **Step 5: Run the full server test suite — verify nothing else regressed**

```bash
cd server && npm test
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/migrations.ts server/src/db/migration-v7.test.ts
git commit -m "feat(ai): add migration v7 with AI columns on trackers

Eight new nullable columns to hold verdict tier, reason, reason key,
update timestamp, signals snapshot, summary, summary timestamp, and
failure counter. Idempotent (uses PRAGMA + ALTER TABLE guards).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Types — Signals, Verdict, ReasonKey, AIGenerationError

**Files:**
- Create: `server/src/ai/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// server/src/ai/types.ts

export type VerdictTier = 'BUY' | 'WAIT' | 'HOLD';

export type ReasonKey =
  | 'gathering_data'
  | 'at_all_time_low'
  | 'in_bottom_decile'
  | 'below_threshold_at_window_low'
  | 'fake_msrp_or_near_high'
  | 'rising_trend'
  | 'at_30d_low'
  | 'no_notable_signal';

export interface Verdict {
  tier: VerdictTier;
  reasonKey: ReasonKey;
}

export interface PriceObservation {
  price: number;
  recorded_at: number; // unix ms
}

export interface Signals {
  // data sufficiency
  data_days: number;
  data_points: number;

  // price position
  current_price: number;
  all_time_low: number;
  all_time_high: number;
  current_percentile: number;

  // window comparisons (ratios; 1.0 = at the window low)
  vs_30d_low: number;
  vs_90d_low: number;
  vs_all_time_low: number;
  vs_all_time_high: number;

  // recency
  days_since_all_time_low: number | null;
  days_at_current_or_lower: number;

  // dwell
  times_at_or_below_current: number;
  avg_dwell_days_at_low: number | null;

  // direction
  trend_30d: 'falling' | 'flat' | 'rising';
  consecutive_drops: number;

  // user-relative
  threshold: number | null;
  pct_below_threshold: number | null;

  // cohort (existing community-low feature)
  community_low: number | null;
  vs_community_low: number | null;
}

export type AIGenerationCategory =
  | 'timeout'
  | 'rate_limit'
  | 'api_error'
  | 'validation_error'
  | 'kill_switch';

export class AIGenerationError extends Error {
  constructor(
    public category: AIGenerationCategory,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'AIGenerationError';
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd server && npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/src/ai/types.ts
git commit -m "feat(ai): define Signals, Verdict, ReasonKey, AIGenerationError types

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Pure signals — `computeSignals`

**Files:**
- Create: `server/src/ai/signals.ts`
- Create: `server/src/ai/signals.test.ts`

This task has many TDD cycles — one per signal group. Add tests in the order listed; implement the minimum to pass each before moving on.

- [ ] **Step 1: Write failing tests for the sparse-data path (returns null)**

Create `server/src/ai/signals.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { computeSignals } from './signals.js';
import type { PriceObservation } from './types.js';

const MS_PER_DAY = 86_400_000;
const NOW = 1_715_000_000_000; // fixed reference for deterministic tests

function buildHistory(prices: number[], startDaysAgo: number, stepDays = 1): PriceObservation[] {
  return prices.map((price, i) => ({
    price,
    recorded_at: NOW - (startDaysAgo - i * stepDays) * MS_PER_DAY,
  }));
}

describe('computeSignals — sparse data', () => {
  it('returns null when history is empty', () => {
    expect(computeSignals([], 10, null, NOW)).toBeNull();
  });

  it('returns null when only one observation', () => {
    expect(computeSignals(buildHistory([10], 0), 10, null, NOW)).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module does not exist)**

```bash
cd server && npm test -- signals.test
```

- [ ] **Step 3: Create `server/src/ai/signals.ts` with the minimum to make the sparse-data tests pass**

```ts
// server/src/ai/signals.ts
import type { PriceObservation, Signals } from './types.js';

const MS_PER_DAY = 86_400_000;

export function computeSignals(
  history: PriceObservation[],
  currentPrice: number,
  threshold: number | null,
  now: number = Date.now(),
  communityLow: number | null = null,
): Signals | null {
  if (history.length < 2) return null;

  // Stub the rest — filled in by subsequent steps.
  return {
    data_days: 0, data_points: history.length,
    current_price: currentPrice,
    all_time_low: 0, all_time_high: 0, current_percentile: 0,
    vs_30d_low: 1, vs_90d_low: 1, vs_all_time_low: 1, vs_all_time_high: 1,
    days_since_all_time_low: null, days_at_current_or_lower: 0,
    times_at_or_below_current: 0, avg_dwell_days_at_low: null,
    trend_30d: 'flat', consecutive_drops: 0,
    threshold, pct_below_threshold: null,
    community_low: communityLow, vs_community_low: null,
  };
}
```

- [ ] **Step 4: Run — sparse-data tests should PASS**

```bash
cd server && npm test -- signals.test
```

- [ ] **Step 5: Add tests for basic stats (data_days, data_points, all-time min/max)**

Append to `signals.test.ts`:

```ts
describe('computeSignals — basic stats', () => {
  it('computes data_days as span between first and last observation', () => {
    const h = buildHistory([10, 12, 11, 9, 10], 60, 15);
    const s = computeSignals(h, 10, null, NOW)!;
    expect(s.data_days).toBe(60);
  });

  it('records data_points equal to history length', () => {
    const h = buildHistory([10, 11, 12], 30, 10);
    expect(computeSignals(h, 12, null, NOW)!.data_points).toBe(3);
  });

  it('finds all_time_low and all_time_high across history', () => {
    const h = buildHistory([15, 20, 10, 25, 18], 60, 12);
    const s = computeSignals(h, 18, null, NOW)!;
    expect(s.all_time_low).toBe(10);
    expect(s.all_time_high).toBe(25);
  });
});
```

- [ ] **Step 6: Implement basic stats inside `computeSignals`**

Replace the stub body. After the early-return guard:

```ts
const sorted = [...history].sort((a, b) => a.recorded_at - b.recorded_at);
const first = sorted[0];
const last = sorted[sorted.length - 1];
const data_days = Math.round((last.recorded_at - first.recorded_at) / MS_PER_DAY);

const prices = sorted.map(o => o.price);
const all_time_low = Math.min(...prices);
const all_time_high = Math.max(...prices);
```

Update the returned object to use these values. Re-run; tests pass.

- [ ] **Step 7: Add tests for `current_percentile`**

```ts
describe('computeSignals — current_percentile', () => {
  it('is 0 when current price is at the all-time low', () => {
    const h = buildHistory([20, 15, 10, 12, 18], 60, 12);
    expect(computeSignals(h, 10, null, NOW)!.current_percentile).toBe(0);
  });

  it('is 1 when current price is at the all-time high', () => {
    const h = buildHistory([10, 15, 20, 12, 18], 60, 12);
    expect(computeSignals(h, 20, null, NOW)!.current_percentile).toBe(1);
  });

  it('is approximately 0.5 when current is the median', () => {
    const h = buildHistory([10, 15, 20, 25, 30], 60, 12);
    const p = computeSignals(h, 20, null, NOW)!.current_percentile;
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
  });
});
```

Implementation:

```ts
const below = prices.filter(p => p < currentPrice).length;
const current_percentile = prices.length > 1 ? below / (prices.length - 1) : 0;
```

- [ ] **Step 8: Add tests for window comparisons (vs_30d_low, vs_90d_low, vs_all_time_low, vs_all_time_high)**

```ts
describe('computeSignals — window comparisons', () => {
  it('vs_all_time_low is 1.0 when current matches the low', () => {
    const h = buildHistory([20, 15, 10, 25, 18], 60, 12);
    expect(computeSignals(h, 10, null, NOW)!.vs_all_time_low).toBe(1.0);
  });

  it('vs_all_time_low is current/low (>1)', () => {
    const h = buildHistory([20, 15, 10, 25, 18], 60, 12);
    expect(computeSignals(h, 12, null, NOW)!.vs_all_time_low).toBeCloseTo(1.2);
  });

  it('vs_all_time_high is small when current is near the MSRP-style high', () => {
    const h = buildHistory([100, 90, 85, 95, 99], 60, 12);
    expect(computeSignals(h, 99, null, NOW)!.vs_all_time_high).toBeCloseTo(0.99);
  });

  it('vs_30d_low only considers obs within 30d', () => {
    const h: PriceObservation[] = [
      { price: 5, recorded_at: NOW - 60 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 10 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 25, null, NOW)!.vs_30d_low).toBeCloseTo(1.25);
  });
});
```

Implementation:

```ts
function lowInWindow(history: PriceObservation[], windowMs: number, now: number): number | null {
  const cutoff = now - windowMs;
  const inWindow = history.filter(o => o.recorded_at >= cutoff).map(o => o.price);
  return inWindow.length === 0 ? null : Math.min(...inWindow);
}

const low30 = lowInWindow(sorted, 30 * MS_PER_DAY, now) ?? all_time_low;
const low90 = lowInWindow(sorted, 90 * MS_PER_DAY, now) ?? all_time_low;

const vs_30d_low = currentPrice / low30;
const vs_90d_low = currentPrice / low90;
const vs_all_time_low = currentPrice / all_time_low;
const vs_all_time_high = currentPrice / all_time_high;
```

- [ ] **Step 9: Add tests for recency signals**

```ts
describe('computeSignals — recency', () => {
  it('days_since_all_time_low is correct when low was N days ago', () => {
    const h: PriceObservation[] = [
      { price: 20, recorded_at: NOW - 60 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 25 * MS_PER_DAY },
      { price: 15, recorded_at: NOW - 5 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 15, null, NOW)!.days_since_all_time_low).toBe(25);
  });

  it('days_at_current_or_lower spans the consecutive at-or-below run from latest', () => {
    const h: PriceObservation[] = [
      { price: 20, recorded_at: NOW - 60 * MS_PER_DAY },
      { price: 12, recorded_at: NOW - 20 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 5 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 1 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 10, null, NOW)!.days_at_current_or_lower).toBe(4);
  });
});
```

Implementation:

```ts
const atlObs = sorted.find(o => o.price === all_time_low)!;
const days_since_all_time_low = Math.round((now - atlObs.recorded_at) / MS_PER_DAY);

let runStart = sorted.length - 1;
for (let i = sorted.length - 1; i >= 0; i--) {
  if (sorted[i].price <= currentPrice) runStart = i;
  else break;
}
const days_at_current_or_lower = Math.round(
  (sorted[sorted.length - 1].recorded_at - sorted[runStart].recorded_at) / MS_PER_DAY
);
```

- [ ] **Step 10: Add tests for dwell signals**

```ts
describe('computeSignals — dwell', () => {
  it('counts times_at_or_below_current across full history', () => {
    const h = buildHistory([20, 10, 15, 9, 25, 10], 100, 20);
    expect(computeSignals(h, 10, null, NOW)!.times_at_or_below_current).toBe(3);
  });

  it('avg_dwell_days_at_low is null when no historical low runs rebounded', () => {
    const h = buildHistory([10, 10, 10], 30, 10);
    expect(computeSignals(h, 10, null, NOW)!.avg_dwell_days_at_low).toBeNull();
  });

  it('computes avg_dwell as mean span of low runs that rebounded', () => {
    const h: PriceObservation[] = [
      { price: 10, recorded_at: NOW - 50 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 48 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 40 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 30 * MS_PER_DAY },
      { price: 25, recorded_at: NOW - 20 * MS_PER_DAY },
    ];
    const s = computeSignals(h, 10, null, NOW)!;
    expect(s.avg_dwell_days_at_low).toBeCloseTo(1, 1);
  });
});
```

Implementation:

```ts
const times_at_or_below_current = prices.filter(p => p <= currentPrice).length;

const dwellSpans: number[] = [];
let runStartIdx: number | null = null;
for (let i = 0; i < sorted.length; i++) {
  const isLow = sorted[i].price === all_time_low;
  if (isLow && runStartIdx === null) runStartIdx = i;
  if (!isLow && runStartIdx !== null) {
    const spanDays = (sorted[i - 1].recorded_at - sorted[runStartIdx].recorded_at) / MS_PER_DAY;
    dwellSpans.push(spanDays);
    runStartIdx = null;
  }
}
const avg_dwell_days_at_low = dwellSpans.length === 0
  ? null
  : dwellSpans.reduce((a, b) => a + b, 0) / dwellSpans.length;
```

- [ ] **Step 11: Add tests for direction signals**

```ts
describe('computeSignals — direction', () => {
  it('trend_30d is "rising" when prices in window go up overall', () => {
    const h: PriceObservation[] = [
      { price: 10, recorded_at: NOW - 28 * MS_PER_DAY },
      { price: 15, recorded_at: NOW - 14 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 1 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 20, null, NOW)!.trend_30d).toBe('rising');
  });

  it('trend_30d is "falling" when prices in window go down', () => {
    const h: PriceObservation[] = [
      { price: 30, recorded_at: NOW - 28 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 14 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 1 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 10, null, NOW)!.trend_30d).toBe('falling');
  });

  it('trend_30d is "flat" when prices are essentially level', () => {
    const h: PriceObservation[] = [
      { price: 20, recorded_at: NOW - 28 * MS_PER_DAY },
      { price: 21, recorded_at: NOW - 14 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 1 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 20, null, NOW)!.trend_30d).toBe('flat');
  });

  it('consecutive_drops counts strictly decreasing tail', () => {
    const h = buildHistory([10, 15, 20, 18, 14, 11], 50, 10);
    expect(computeSignals(h, 11, null, NOW)!.consecutive_drops).toBe(3);
  });
});
```

Implementation:

```ts
function trendIn30d(history: PriceObservation[], now: number): 'falling' | 'flat' | 'rising' {
  const window = history.filter(o => o.recorded_at >= now - 30 * MS_PER_DAY);
  if (window.length < 2) return 'flat';
  const first = window[0].price;
  const last = window[window.length - 1].price;
  const change = (last - first) / first;
  if (change > 0.05) return 'rising';
  if (change < -0.05) return 'falling';
  return 'flat';
}
const trend_30d = trendIn30d(sorted, now);

let consecutive_drops = 0;
for (let i = sorted.length - 1; i > 0; i--) {
  if (sorted[i].price < sorted[i - 1].price) consecutive_drops++;
  else break;
}
```

- [ ] **Step 12: Add tests for user-relative + community signals**

```ts
describe('computeSignals — user-relative + community', () => {
  it('pct_below_threshold is positive when current is under threshold', () => {
    const h = buildHistory([20, 15, 10], 30, 10);
    expect(computeSignals(h, 10, 12, NOW)!.pct_below_threshold).toBeCloseTo(16.66, 1);
  });

  it('pct_below_threshold is null when threshold is null', () => {
    const h = buildHistory([20, 15, 10], 30, 10);
    expect(computeSignals(h, 10, null, NOW)!.pct_below_threshold).toBeNull();
  });

  it('vs_community_low is current/communityLow when both present', () => {
    const h = buildHistory([20, 15, 10], 30, 10);
    expect(computeSignals(h, 10, null, NOW, 8)!.vs_community_low).toBeCloseTo(1.25);
  });

  it('vs_community_low is null when communityLow is null', () => {
    const h = buildHistory([20, 15, 10], 30, 10);
    expect(computeSignals(h, 10, null, NOW, null)!.vs_community_low).toBeNull();
  });
});
```

Implementation:

```ts
const pct_below_threshold = threshold === null
  ? null
  : Math.max(0, ((threshold - currentPrice) / threshold) * 100);

const vs_community_low = communityLow === null ? null : currentPrice / communityLow;
```

- [ ] **Step 13: Run the full signals suite — confirm all green**

```bash
cd server && npm test -- signals.test
```

Expected: ~25 tests all PASS.

- [ ] **Step 14: Run full server suite — no regressions**

```bash
cd server && npm test
```

- [ ] **Step 15: Commit**

```bash
git add server/src/ai/types.ts server/src/ai/signals.ts server/src/ai/signals.test.ts
git commit -m "feat(ai): pure signals computation from price history

computeSignals returns a structured Signals payload covering price
position, window comparisons, recency, dwell behavior, direction,
user-relative deltas, and community cohort. Pure function — zero IO,
fully unit-tested across data sufficiency edges, sparse history, and
all signal categories.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Pure verdict — `signalsToVerdict`

**Files:**
- Create: `server/src/ai/verdict.ts`
- Create: `server/src/ai/verdict.test.ts`

- [ ] **Step 1: Write the failing tests covering every rule branch**

Create `server/src/ai/verdict.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { signalsToVerdict } from './verdict.js';
import type { Signals } from './types.js';

const baseSignals: Signals = {
  data_days: 60, data_points: 60,
  current_price: 100, all_time_low: 90, all_time_high: 120, current_percentile: 0.5,
  vs_30d_low: 1.1, vs_90d_low: 1.1, vs_all_time_low: 1.1, vs_all_time_high: 0.83,
  days_since_all_time_low: 30, days_at_current_or_lower: 0,
  times_at_or_below_current: 5, avg_dwell_days_at_low: 3,
  trend_30d: 'flat', consecutive_drops: 0,
  threshold: null, pct_below_threshold: null,
  community_low: null, vs_community_low: null,
};

const s = (overrides: Partial<Signals> = {}): Signals => ({ ...baseSignals, ...overrides });

describe('signalsToVerdict', () => {
  it('HOLD/gathering_data when data_days < 14', () => {
    expect(signalsToVerdict(s({ data_days: 13 }))).toEqual({ tier: 'HOLD', reasonKey: 'gathering_data' });
  });

  it('BUY/at_all_time_low when within 2% of ATL', () => {
    expect(signalsToVerdict(s({ vs_all_time_low: 1.01 }))).toEqual({ tier: 'BUY', reasonKey: 'at_all_time_low' });
    expect(signalsToVerdict(s({ vs_all_time_low: 1.02 }))).toEqual({ tier: 'BUY', reasonKey: 'at_all_time_low' });
  });

  it('BUY/in_bottom_decile when percentile <= 0.10 and data_days >= 30', () => {
    expect(signalsToVerdict(s({ vs_all_time_low: 1.05, current_percentile: 0.05, data_days: 30 })))
      .toEqual({ tier: 'BUY', reasonKey: 'in_bottom_decile' });
  });

  it('does NOT use bottom-decile rule when data_days < 30', () => {
    const v = signalsToVerdict(s({ vs_all_time_low: 1.05, current_percentile: 0.05, data_days: 20 }));
    expect(v.reasonKey).not.toBe('in_bottom_decile');
  });

  it('BUY/below_threshold_at_window_low when pct_below_threshold>=5 and at 30d low', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.10, current_percentile: 0.30,
      pct_below_threshold: 7, vs_30d_low: 1.0,
    }))).toEqual({ tier: 'BUY', reasonKey: 'below_threshold_at_window_low' });
  });

  it('WAIT/fake_msrp_or_near_high when near all-time high and high percentile', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.30, vs_all_time_high: 1.02, current_percentile: 0.85,
    }))).toEqual({ tier: 'WAIT', reasonKey: 'fake_msrp_or_near_high' });
  });

  it('WAIT/rising_trend when trend rising and high percentile', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.20, current_percentile: 0.75, trend_30d: 'rising',
    }))).toEqual({ tier: 'WAIT', reasonKey: 'rising_trend' });
  });

  it('BUY/at_30d_low when at 30d window low (soft BUY)', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.20, vs_30d_low: 1.01, current_percentile: 0.40,
    }))).toEqual({ tier: 'BUY', reasonKey: 'at_30d_low' });
  });

  it('HOLD/no_notable_signal when nothing matches', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.20, vs_30d_low: 1.10, current_percentile: 0.50,
    }))).toEqual({ tier: 'HOLD', reasonKey: 'no_notable_signal' });
  });

  it('strong BUY beats WAIT — at_all_time_low wins over rising_trend', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.01, trend_30d: 'rising', current_percentile: 0.85,
    }))).toEqual({ tier: 'BUY', reasonKey: 'at_all_time_low' });
  });

  it('boundary: vs_all_time_low exactly 1.02 still BUYs', () => {
    expect(signalsToVerdict(s({ vs_all_time_low: 1.02 })).tier).toBe('BUY');
  });

  it('boundary: vs_all_time_low 1.021 falls through ATL rule', () => {
    expect(signalsToVerdict(s({ vs_all_time_low: 1.021 })).reasonKey).not.toBe('at_all_time_low');
  });

  it('boundary: data_days exactly 14 leaves gathering_data', () => {
    const v = signalsToVerdict(s({ data_days: 14 }));
    expect(v.reasonKey).not.toBe('gathering_data');
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module does not exist)**

```bash
cd server && npm test -- verdict.test
```

- [ ] **Step 3: Implement `server/src/ai/verdict.ts`**

```ts
// server/src/ai/verdict.ts
import type { Signals, Verdict } from './types.js';

export function signalsToVerdict(s: Signals): Verdict {
  if (s.data_days < 14) {
    return { tier: 'HOLD', reasonKey: 'gathering_data' };
  }

  // Strong BUY signals
  if (s.vs_all_time_low <= 1.02) {
    return { tier: 'BUY', reasonKey: 'at_all_time_low' };
  }
  if (s.current_percentile <= 0.10 && s.data_days >= 30) {
    return { tier: 'BUY', reasonKey: 'in_bottom_decile' };
  }
  if (s.pct_below_threshold !== null && s.pct_below_threshold >= 5 && s.vs_30d_low <= 1.00) {
    return { tier: 'BUY', reasonKey: 'below_threshold_at_window_low' };
  }

  // WAIT signals
  if (s.vs_all_time_high <= 1.05 && s.current_percentile >= 0.80) {
    return { tier: 'WAIT', reasonKey: 'fake_msrp_or_near_high' };
  }
  if (s.trend_30d === 'rising' && s.current_percentile >= 0.70) {
    return { tier: 'WAIT', reasonKey: 'rising_trend' };
  }

  // Soft BUY
  if (s.vs_30d_low <= 1.02) {
    return { tier: 'BUY', reasonKey: 'at_30d_low' };
  }

  return { tier: 'HOLD', reasonKey: 'no_notable_signal' };
}
```

- [ ] **Step 4: Run — all verdict tests PASS**

```bash
cd server && npm test -- verdict.test
```

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/verdict.ts server/src/ai/verdict.test.ts
git commit -m "feat(ai): pure verdict logic — signalsToVerdict

Deterministic rule tree mapping Signals to { tier, reasonKey }. Every
rule branch covered by unit tests including boundary conditions and
precedence (strong BUY beats WAIT). Cannot fail by construction —
final return is the catch-all HOLD/no_notable_signal.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Anthropic client wrapper

**Files:**
- Create: `server/src/ai/client.ts`
- Create: `server/src/ai/client.test.ts`

The client owns: SDK initialization, prompt-cache markers, retry-once-with-backoff, length validation, banned-phrase rejection, kill-switch (`AI_ENABLED=false`), and structured error throws.

- [ ] **Step 1: Write failing tests using a mock SDK**

Create `server/src/ai/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIGenerationError } from './types.js';

const createMock = vi.fn();
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = { create: createMock };
    },
    Anthropic: class MockAnthropic {
      messages = { create: createMock };
    },
  };
});

import { callClaude, _resetClientForTesting } from './client.js';

const STUB_PROMPT = {
  system: [{ type: 'text', text: 'system block', cache_control: { type: 'ephemeral' } }],
  user: 'user block',
  maxTokens: 100,
  maxOutputChars: 150,
  promptName: 'verdict' as const,
};

beforeEach(() => {
  _resetClientForTesting();
  createMock.mockReset();
  process.env.AI_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('callClaude', () => {
  it('returns the trimmed text on success', async () => {
    createMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '  hello world  ' }],
      usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 90 },
    });
    const out = await callClaude(STUB_PROMPT);
    expect(out.text).toBe('hello world');
    expect(out.cachedTokens).toBe(90);
  });

  it('throws kill_switch when AI_ENABLED=false', async () => {
    process.env.AI_ENABLED = 'false';
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({
      name: 'AIGenerationError', category: 'kill_switch',
    });
  });

  it('throws kill_switch when ANTHROPIC_API_KEY is empty', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'kill_switch' });
  });

  it('rejects oversized output (over maxOutputChars)', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'x'.repeat(200) }],
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'validation_error' });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('rejects empty output', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: '   ' }],
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'validation_error' });
  });

  it('rejects banned phrases ("as an AI", "I cannot")', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'As an AI I cannot help' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    });
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'validation_error' });
  });

  it('retries once on transient error then succeeds', async () => {
    createMock
      .mockRejectedValueOnce(Object.assign(new Error('429 Rate limit'), { status: 429 }))
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: 'recovered' }],
        usage: { input_tokens: 100, output_tokens: 5 },
      });
    const out = await callClaude(STUB_PROMPT);
    expect(out.text).toBe('recovered');
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws rate_limit category after both attempts fail with 429', async () => {
    const err = Object.assign(new Error('429'), { status: 429 });
    createMock.mockRejectedValue(err);
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'rate_limit' });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('throws api_error for non-rate-limit failures', async () => {
    createMock.mockRejectedValue(new Error('boom'));
    await expect(callClaude(STUB_PROMPT)).rejects.toMatchObject({ category: 'api_error' });
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module does not exist)**

```bash
cd server && npm test -- client.test
```

- [ ] **Step 3: Implement `server/src/ai/client.ts`**

```ts
// server/src/ai/client.ts
import Anthropic from '@anthropic-ai/sdk';
import { AIGenerationError } from './types.js';
import type { AIGenerationCategory } from './types.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface ClaudePromptInput {
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  user: string;
  maxTokens: number;
  maxOutputChars: number;
  promptName: 'verdict' | 'summary' | 'alert';
}

export interface ClaudeResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
}

const BANNED_PHRASES = [
  /\bas an ai\b/i,
  /\bi cannot\b/i,
  /\bi'm sorry\b/i,
  /\bi am unable\b/i,
];

let clientInstance: Anthropic | null = null;
function getClient(): Anthropic {
  if (!clientInstance) {
    clientInstance = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return clientInstance;
}

export function _resetClientForTesting(): void {
  clientInstance = null;
}

function categorize(err: unknown): AIGenerationCategory {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status;
    if (status === 429) return 'rate_limit';
    if (status === 408) return 'timeout';
  }
  if (err instanceof Error && /timeout|timed out/i.test(err.message)) return 'timeout';
  return 'api_error';
}

function validate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) throw new AIGenerationError('validation_error', 'empty output');
  if (trimmed.length > maxChars) throw new AIGenerationError('validation_error', `oversized output (${trimmed.length} > ${maxChars})`);
  for (const re of BANNED_PHRASES) {
    if (re.test(trimmed)) throw new AIGenerationError('validation_error', `banned phrase matched: ${re}`);
  }
  return trimmed;
}

async function callOnce(input: ClaudePromptInput, shorten: boolean): Promise<ClaudeResponse> {
  const startMs = Date.now();
  const userText = shorten
    ? `${input.user}\n\nIMPORTANT: be shorter than your previous attempt — output must be under ${input.maxOutputChars} characters.`
    : input.user;

  const resp = await getClient().messages.create({
    model: config.aiModel,
    max_tokens: input.maxTokens,
    system: input.system,
    messages: [{ role: 'user', content: userText }],
  });

  const block = resp.content?.[0];
  const text = block && block.type === 'text' ? block.text : '';
  const usage = resp.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | undefined;

  return {
    text: validate(text, input.maxOutputChars),
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cachedTokens: usage?.cache_read_input_tokens ?? 0,
    latencyMs: Date.now() - startMs,
  };
}

export async function callClaude(input: ClaudePromptInput): Promise<ClaudeResponse> {
  if (process.env.AI_ENABLED !== 'true') throw new AIGenerationError('kill_switch', 'AI_ENABLED is false');
  if (!process.env.ANTHROPIC_API_KEY) throw new AIGenerationError('kill_switch', 'ANTHROPIC_API_KEY not set');

  let firstErr: unknown = null;
  try {
    const result = await callOnce(input, false);
    logger.info({
      prompt: input.promptName, model: config.aiModel,
      input_tokens: result.inputTokens, output_tokens: result.outputTokens,
      cached_tokens: result.cachedTokens, latency_ms: result.latencyMs,
      status: 'success',
    }, 'ai_call_ok');
    return result;
  } catch (err) {
    firstErr = err;
    if (err instanceof AIGenerationError && err.category === 'validation_error') {
      try {
        const result = await callOnce(input, true);
        logger.info({ prompt: input.promptName, status: 'success_after_retry' }, 'ai_call_retry_ok');
        return result;
      } catch (err2) {
        if (err2 instanceof AIGenerationError) throw err2;
        throw new AIGenerationError(categorize(err2), 'retry failed', err2);
      }
    }
    await new Promise(r => setTimeout(r, 500));
    try {
      const result = await callOnce(input, false);
      logger.info({ prompt: input.promptName, status: 'success_after_retry' }, 'ai_call_retry_ok');
      return result;
    } catch (err2) {
      if (err2 instanceof AIGenerationError) throw err2;
      throw new AIGenerationError(categorize(err2 ?? firstErr), 'second attempt failed', err2);
    }
  }
}
```

- [ ] **Step 4: Run — all client tests PASS**

```bash
cd server && npm test -- client.test
```

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/client.ts server/src/ai/client.test.ts
git commit -m "feat(ai): Anthropic client wrapper with retry, validation, kill switch

Single point of network IO for all Claude calls. Validates output
length, rejects empty + banned phrases (\"as an AI\", \"I cannot\", ...),
retries once on transient or oversize errors with a \"be shorter\"
nudge, categorizes failures (timeout, rate_limit, api_error,
validation_error, kill_switch), structured-logs every call.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Prompt builders

**Files:**
- Create: `server/src/ai/prompts.ts`
- Create: `server/src/ai/prompts.test.ts`

- [ ] **Step 1: Write failing tests for prompt structure**

Create `server/src/ai/prompts.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildVerdictPrompt, buildSummaryPrompt, buildAlertCopyPrompt } from './prompts.js';
import type { Signals } from './types.js';

const sampleSignals: Signals = {
  data_days: 90, data_points: 90, current_price: 279, all_time_low: 279, all_time_high: 389,
  current_percentile: 0.05,
  vs_30d_low: 1.0, vs_90d_low: 1.0, vs_all_time_low: 1.0, vs_all_time_high: 0.72,
  days_since_all_time_low: 0, days_at_current_or_lower: 1,
  times_at_or_below_current: 3, avg_dwell_days_at_low: 4,
  trend_30d: 'flat', consecutive_drops: 1,
  threshold: 300, pct_below_threshold: 7,
  community_low: 275, vs_community_low: 1.014,
};

describe('buildVerdictPrompt', () => {
  it('marks the system block as cache-controlled ephemeral', () => {
    const p = buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low');
    expect(p.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('serializes signals in the user block as JSON', () => {
    const p = buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low');
    expect(p.user).toContain('"current_percentile": 0.05');
    expect(p.user).toContain('"reasonKey": "at_all_time_low"');
    expect(p.user).toContain('"tier": "BUY"');
  });

  it('system block contains hallucination guard wording', () => {
    const p = buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low');
    const sys = p.system[0].text;
    expect(sys).toMatch(/only use values present in the signals/i);
    expect(sys).toMatch(/do not invent/i);
  });

  it('system block declares the length limit', () => {
    const p = buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low');
    expect(p.system[0].text).toMatch(/150 char/i);
    expect(p.maxOutputChars).toBe(150);
  });

  it('promptName is "verdict"', () => {
    expect(buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low').promptName).toBe('verdict');
  });
});

describe('buildSummaryPrompt', () => {
  it('promptName is "summary" and limit is 400 chars', () => {
    const p = buildSummaryPrompt(sampleSignals, []);
    expect(p.promptName).toBe('summary');
    expect(p.maxOutputChars).toBe(400);
  });

  it('includes recent observations in user block', () => {
    const obs = [
      { price: 279, recorded_at: 1715000000000 },
      { price: 289, recorded_at: 1714000000000 },
    ];
    const p = buildSummaryPrompt(sampleSignals, obs);
    expect(p.user).toContain('279');
    expect(p.user).toContain('289');
  });
});

describe('buildAlertCopyPrompt', () => {
  it('promptName is "alert" and limit is 120 chars', () => {
    const p = buildAlertCopyPrompt({
      trackerName: 'Samsung 990 Pro 4TB',
      oldPrice: 349.99, newPrice: 279,
      signals: sampleSignals, reasonKey: 'at_all_time_low',
    });
    expect(p.promptName).toBe('alert');
    expect(p.maxOutputChars).toBe(120);
  });

  it('includes price-change context in user block', () => {
    const p = buildAlertCopyPrompt({
      trackerName: 'Samsung 990 Pro 4TB',
      oldPrice: 349.99, newPrice: 279,
      signals: sampleSignals, reasonKey: 'at_all_time_low',
    });
    expect(p.user).toContain('Samsung 990 Pro 4TB');
    expect(p.user).toContain('349.99');
    expect(p.user).toContain('279');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd server && npm test -- prompts.test
```

- [ ] **Step 3: Implement `server/src/ai/prompts.ts`**

```ts
// server/src/ai/prompts.ts
import type { Signals, ReasonKey, VerdictTier, PriceObservation } from './types.js';
import type { ClaudePromptInput } from './client.js';

const TONE_BLOCK = `You are the deal-advisor inside a price-tracking app. Your tone is terse, factual, and helpful — like a knowledgeable friend texting a one-liner. Never use marketing language ("amazing deal!", "incredible savings!"). Never use exclamation points. Never reference yourself or the LLM nature of your output.`;

const HALLUCINATION_GUARD = `STRICT RULE: Every quantitative claim in your output (percentile rankings, day counts, dollar amounts, "X-month low" phrases) must correspond to a value present in the signals object you are given. Do not invent percentiles, time windows, or comparisons not provided. If a signal is null, do not reference it. Only use values present in the signals object.`;

const REASON_KEY_GLOSSARY = `reasonKey meanings:
- gathering_data: not enough history yet
- at_all_time_low: current price is at or within 2% of the all-time low
- in_bottom_decile: current price is in the lowest 10% of all observed prices
- below_threshold_at_window_low: price below user's threshold AND at the 30-day low
- fake_msrp_or_near_high: current is suspiciously close to all-time high (markup not deal)
- rising_trend: 30-day trend is rising and current is in the top 30%
- at_30d_low: current is at the 30-day window low (modest deal)
- no_notable_signal: nothing stands out`;

function ephemeralSystem(text: string): ClaudePromptInput['system'] {
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function buildVerdictPrompt(
  signals: Signals,
  tier: VerdictTier,
  reasonKey: ReasonKey,
): ClaudePromptInput {
  const systemText = `${TONE_BLOCK}

You are composing a one-sentence reason for a BUY/WAIT/HOLD verdict pill on a tracker card. Length: max 150 characters. Output the sentence only — no quotes, no labels, no preamble.

${REASON_KEY_GLOSSARY}

${HALLUCINATION_GUARD}`;

  const userText = `${JSON.stringify({ tier, reasonKey, signals }, null, 2)}

Compose the reason sentence.`;

  return {
    system: ephemeralSystem(systemText),
    user: userText,
    maxTokens: 80,
    maxOutputChars: 150,
    promptName: 'verdict',
  };
}

export function buildSummaryPrompt(
  signals: Signals,
  recentObservations: PriceObservation[],
): ClaudePromptInput {
  const systemText = `${TONE_BLOCK}

You are composing a 2-4 sentence narrative summary of a product's price story for a tracker detail page. Cover (when relevant): price range, recency of low, dwell behavior at low, fake-MSRP vs. real-discount distinction, trend. Length: max 400 characters. Output the paragraph only — no headings, no labels.

${HALLUCINATION_GUARD}`;

  const obs = recentObservations.slice(-30).map(o => ({ p: o.price, t: o.recorded_at }));

  const userText = `${JSON.stringify({ signals, recent_observations: obs }, null, 2)}

Compose the summary.`;

  return {
    system: ephemeralSystem(systemText),
    user: userText,
    maxTokens: 220,
    maxOutputChars: 400,
    promptName: 'summary',
  };
}

export interface AlertCopyContext {
  trackerName: string;
  oldPrice: number;
  newPrice: number;
  signals: Signals;
  reasonKey: ReasonKey;
}

export function buildAlertCopyPrompt(ctx: AlertCopyContext): ClaudePromptInput {
  const systemText = `${TONE_BLOCK}

You are composing a one-sentence punchy line to append to a price-drop alert. Reference the most striking signal (e.g., "12-month low", "matches February's drop", "first time below $X"). Length: max 120 characters. Output the sentence only.

${REASON_KEY_GLOSSARY}

${HALLUCINATION_GUARD}`;

  const userText = `${JSON.stringify({
    tracker: ctx.trackerName,
    old_price: ctx.oldPrice,
    new_price: ctx.newPrice,
    reasonKey: ctx.reasonKey,
    signals: ctx.signals,
  }, null, 2)}

Compose the alert line.`;

  return {
    system: ephemeralSystem(systemText),
    user: userText,
    maxTokens: 60,
    maxOutputChars: 120,
    promptName: 'alert',
  };
}
```

- [ ] **Step 4: Run — all prompt tests PASS**

```bash
cd server && npm test -- prompts.test
```

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/prompts.ts server/src/ai/prompts.test.ts
git commit -m "feat(ai): prompt builders with ephemeral cache markers + hallucination guard

Three builders (verdict, summary, alert copy). Each emits a stable
ephemeral-cached system block (tone, reason-key glossary, length
constraint, \"only use values present in the signals object\" rule)
and a small variable user block (signals JSON + per-call context).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: DB queries for AI fields

**Files:**
- Modify: `server/src/db/queries.ts`

- [ ] **Step 1: Extend the `Tracker` type**

Locate the `Tracker` interface in `server/src/db/queries.ts` and add the eight AI fields:

```ts
export interface Tracker {
  // ... existing fields ...
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
  ai_verdict_reason_key: string | null;
  ai_verdict_updated_at: number | null;
  ai_summary: string | null;
  ai_summary_updated_at: number | null;
  ai_signals_json: string | null;
  ai_failure_count: number;
}
```

- [ ] **Step 2: Add write helpers**

At the bottom of `queries.ts`:

```ts
export function updateTrackerAIVerdict(
  trackerId: number,
  args: { tier: string; reason: string; reasonKey: string; signalsJson: string }
): void {
  getDb().prepare(`
    UPDATE trackers SET
      ai_verdict_tier = ?,
      ai_verdict_reason = ?,
      ai_verdict_reason_key = ?,
      ai_verdict_updated_at = ?,
      ai_signals_json = ?,
      ai_failure_count = 0
    WHERE id = ?
  `).run(args.tier, args.reason, args.reasonKey, Date.now(), args.signalsJson, trackerId);
}

export function updateTrackerAISummary(trackerId: number, summary: string): void {
  getDb().prepare(`
    UPDATE trackers SET
      ai_summary = ?,
      ai_summary_updated_at = ?
    WHERE id = ?
  `).run(summary, Date.now(), trackerId);
}

export function incrementAIFailureCount(trackerId: number): void {
  getDb().prepare(`
    UPDATE trackers SET ai_failure_count = ai_failure_count + 1 WHERE id = ?
  `).run(trackerId);
}

export function getTrackersWithStaleSummary(stalerThanMs: number, limit: number): Tracker[] {
  return getDb().prepare(`
    SELECT * FROM trackers
    WHERE status = 'active'
      AND (ai_summary_updated_at IS NULL OR ai_summary_updated_at < ?)
    ORDER BY COALESCE(ai_summary_updated_at, 0) ASC
    LIMIT ?
  `).all(Date.now() - stalerThanMs, limit) as Tracker[];
}

export function getRecentSuccessfulPricesForTracker(
  trackerId: number,
  sinceMs: number,
): Array<{ price: number; recorded_at: number }> {
  return getDb().prepare(`
    SELECT price, recorded_at FROM price_history
    WHERE tracker_id = ? AND recorded_at >= ?
    ORDER BY recorded_at ASC
  `).all(trackerId, sinceMs) as Array<{ price: number; recorded_at: number }>;
}
```

⚠️ Verify whether `price_history.recorded_at` is stored as INTEGER (unix ms) or TEXT (ISO datetime). If TEXT, adjust `getRecentSuccessfulPricesForTracker` to convert.

- [ ] **Step 3: Verify type-check + tests still green**

```bash
cd server && npm run build && npm test
```

- [ ] **Step 4: Commit**

```bash
git add server/src/db/queries.ts
git commit -m "feat(ai): DB read/write helpers for AI fields on trackers

Tracker type extended with eight AI columns. New writers:
updateTrackerAIVerdict (sets tier/reason/key/timestamp/signals,
zeroes failure count), updateTrackerAISummary, incrementAIFailureCount.
New readers: getTrackersWithStaleSummary (for backfill cron),
getRecentSuccessfulPricesForTracker (for signals computation).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Generators — orchestrate signals + verdict + Claude

**Files:**
- Create: `server/src/ai/generators.ts`
- Create: `server/src/ai/generators.test.ts`

- [ ] **Step 1: Write failing tests with an injected mock client**

Create `server/src/ai/generators.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import {
  generateVerdictForTracker,
  generateSummaryForTracker,
  generateAlertCopy,
  _setClientForTesting,
} from './generators.js';
import type { ClaudeResponse } from './client.js';
import { AIGenerationError } from './types.js';

const mockCall = vi.fn();

function seedTrackerWithHistory(): number {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('test@x.com', 'h', 'Test')`).run();
  const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('test@x.com') as { id: number }).id;
  db.prepare(`INSERT INTO trackers (name, user_id, threshold_price, status, check_interval_minutes, jitter_minutes) VALUES ('Test', ?, 100, 'active', 60, 0)`).run(userId);
  const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get('Test') as { id: number }).id;
  const now = Date.now();
  for (let i = 30; i >= 0; i--) {
    db.prepare(`INSERT INTO price_history (tracker_id, price, recorded_at) VALUES (?, ?, ?)`)
      .run(trackerId, 100 - i * 0.5, now - i * 86_400_000);
  }
  // Set current_price on tracker (existing schema convention — adjust to match repo)
  db.prepare(`UPDATE trackers SET current_price = ? WHERE id = ?`).run(100, trackerId);
  return trackerId;
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  runMigrations();
  mockCall.mockReset();
  _setClientForTesting(mockCall);
});
afterEach(() => _setDbForTesting(null));

describe('generateVerdictForTracker', () => {
  it('writes tier, reason, signals_json on success', async () => {
    const id = seedTrackerWithHistory();
    const resp: ClaudeResponse = { text: 'At the all-time low.', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50 };
    mockCall.mockResolvedValueOnce(resp);
    await generateVerdictForTracker(id);
    const t = getDb().prepare('SELECT * FROM trackers WHERE id=?').get(id) as Record<string, unknown>;
    expect(t.ai_verdict_tier).toBeTruthy();
    expect(t.ai_verdict_reason).toBe('At the all-time low.');
    expect(t.ai_verdict_reason_key).toBeTruthy();
    expect(t.ai_signals_json).toBeTruthy();
    expect(t.ai_failure_count).toBe(0);
    expect(t.ai_verdict_updated_at).toBeGreaterThan(0);
  });

  it('increments failure count and leaves prior values intact on error', async () => {
    const id = seedTrackerWithHistory();
    getDb().prepare(`UPDATE trackers SET ai_verdict_tier='BUY', ai_verdict_reason='old' WHERE id=?`).run(id);
    mockCall.mockRejectedValueOnce(new AIGenerationError('rate_limit', '429'));
    await generateVerdictForTracker(id);
    const t = getDb().prepare('SELECT * FROM trackers WHERE id=?').get(id) as Record<string, unknown>;
    expect(t.ai_verdict_tier).toBe('BUY');
    expect(t.ai_verdict_reason).toBe('old');
    expect(t.ai_failure_count).toBe(1);
  });

  it('skips Claude entirely when signals are null (sparse data)', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c','h','A')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('a@b.c') as { id: number }).id;
    db.prepare(`INSERT INTO trackers (name, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, current_price) VALUES ('Sparse', ?, 100, 'active', 60, 0, 100)`).run(userId);
    const id = (db.prepare('SELECT id FROM trackers WHERE name=?').get('Sparse') as { id: number }).id;
    db.prepare(`INSERT INTO price_history (tracker_id, price, recorded_at) VALUES (?, 100, ?)`).run(id, Date.now());
    await generateVerdictForTracker(id);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('generateAlertCopy', () => {
  it('returns the trimmed text', async () => {
    const resp: ClaudeResponse = { text: '  9-month low.  ', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 30 };
    mockCall.mockResolvedValueOnce(resp);
    const out = await generateAlertCopy({
      trackerName: 'X', oldPrice: 100, newPrice: 80,
      signals: {} as never, reasonKey: 'at_all_time_low',
    });
    expect(out).toBe('9-month low.');
  });

  it('returns null on AIGenerationError', async () => {
    mockCall.mockRejectedValueOnce(new AIGenerationError('rate_limit', '429'));
    const out = await generateAlertCopy({
      trackerName: 'X', oldPrice: 100, newPrice: 80,
      signals: {} as never, reasonKey: 'at_all_time_low',
    });
    expect(out).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
cd server && npm test -- generators.test
```

- [ ] **Step 3: Implement `server/src/ai/generators.ts`**

```ts
// server/src/ai/generators.ts
import { computeSignals } from './signals.js';
import { signalsToVerdict } from './verdict.js';
import { buildVerdictPrompt, buildSummaryPrompt, buildAlertCopyPrompt } from './prompts.js';
import type { AlertCopyContext } from './prompts.js';
import { callClaude } from './client.js';
import type { ClaudeResponse, ClaudePromptInput } from './client.js';
import { AIGenerationError } from './types.js';
import {
  getTrackerById,
  getRecentSuccessfulPricesForTracker,
  updateTrackerAIVerdict,
  updateTrackerAISummary,
  incrementAIFailureCount,
} from '../db/queries.js';
import { logger } from '../logger.js';

let clientFn: (input: ClaudePromptInput) => Promise<ClaudeResponse> = callClaude;
export function _setClientForTesting(fn: (input: ClaudePromptInput) => Promise<ClaudeResponse>): void {
  clientFn = fn;
}

const HISTORY_WINDOW_DAYS = 365;

async function loadSignalsForTracker(trackerId: number) {
  const tracker = getTrackerById(trackerId);
  if (!tracker || tracker.current_price === null) return null;

  const cutoff = Date.now() - HISTORY_WINDOW_DAYS * 86_400_000;
  const observations = getRecentSuccessfulPricesForTracker(trackerId, cutoff);

  const signals = computeSignals(
    observations,
    tracker.current_price,
    tracker.threshold_price ?? null,
    Date.now(),
    null,
  );
  if (!signals) return null;

  return { tracker, signals, observations };
}

export async function generateVerdictForTracker(trackerId: number): Promise<void> {
  try {
    const ctx = await loadSignalsForTracker(trackerId);
    if (!ctx) return;

    const verdict = signalsToVerdict(ctx.signals);
    const prompt = buildVerdictPrompt(ctx.signals, verdict.tier, verdict.reasonKey);

    const resp = await clientFn(prompt);
    updateTrackerAIVerdict(trackerId, {
      tier: verdict.tier,
      reason: resp.text,
      reasonKey: verdict.reasonKey,
      signalsJson: JSON.stringify(ctx.signals),
    });
  } catch (err) {
    if (err instanceof AIGenerationError) {
      logger.warn({ tracker_id: trackerId, category: err.category, msg: err.message }, 'ai_verdict_failed');
      incrementAIFailureCount(trackerId);
      return;
    }
    logger.error({ tracker_id: trackerId, err: String(err) }, 'ai_verdict_unexpected');
    incrementAIFailureCount(trackerId);
  }
}

export async function generateSummaryForTracker(trackerId: number): Promise<void> {
  try {
    const ctx = await loadSignalsForTracker(trackerId);
    if (!ctx) return;

    const prompt = buildSummaryPrompt(ctx.signals, ctx.observations);
    const resp = await clientFn(prompt);
    updateTrackerAISummary(trackerId, resp.text);
  } catch (err) {
    if (err instanceof AIGenerationError) {
      logger.warn({ tracker_id: trackerId, category: err.category }, 'ai_summary_failed');
      return;
    }
    logger.error({ tracker_id: trackerId, err: String(err) }, 'ai_summary_unexpected');
  }
}

export async function generateAlertCopy(ctx: AlertCopyContext): Promise<string | null> {
  try {
    const prompt = buildAlertCopyPrompt(ctx);
    const resp = await clientFn(prompt);
    return resp.text;
  } catch (err) {
    if (err instanceof AIGenerationError) {
      logger.info({ category: err.category, tracker: ctx.trackerName }, 'ai_alert_copy_skip');
      return null;
    }
    logger.error({ err: String(err) }, 'ai_alert_copy_unexpected');
    return null;
  }
}

// Helper used by cron.ts to compute signals + verdict for the alert path
// without re-querying. Returns null when sparse.
export async function computeSignalsAndVerdictForTracker(trackerId: number) {
  const ctx = await loadSignalsForTracker(trackerId);
  if (!ctx) return null;
  return { signals: ctx.signals, verdict: signalsToVerdict(ctx.signals) };
}
```

- [ ] **Step 4: Run — generators tests PASS**

```bash
cd server && npm test -- generators.test
```

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/generators.ts server/src/ai/generators.test.ts
git commit -m "feat(ai): generator orchestrators — verdict, summary, alert copy

Composes signals + verdict + prompt + client. The only place that
mutates the ai_* columns. Fire-and-forget semantics: never throws,
logs structured errors, increments ai_failure_count on Claude failure
and leaves prior values intact. Test seam (_setClientForTesting)
keeps unit tests fully offline.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Cron integration — verdict fire-and-forget on price change

**Files:**
- Modify: `server/src/scheduler/cron.ts`
- Create: `server/src/scheduler/cron-ai.test.ts`

- [ ] **Step 1: Write the integration test**

Create `server/src/scheduler/cron-ai.test.ts`. Scaffolding mirrors `cron-cooldown.test.ts` (mock the scraper + channel senders at module level so the handler doesn't touch real network):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', () => ({ extractPrice: vi.fn() }));
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
import { createTracker, addTrackerUrl } from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { _setClientForTesting } from '../ai/generators.js';
import type { ClaudeResponse } from '../ai/client.js';

const mockClient = vi.fn<[unknown], Promise<ClaudeResponse>>();

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function seedTrackerWith30dHistory(userId: number, lastPrice: number): { trackerId: number; trackerUrlId: number } {
  // Use the existing createTracker / addTrackerUrl helpers — match their actual signatures.
  // The fields named here are the canonical names; verify against queries.ts.
  const trackerId = createTracker({
    user_id: userId, name: 'Test', threshold_price: 100,
    check_interval_minutes: 60,
  } as never);
  const trackerUrlId = addTrackerUrl({
    tracker_id: trackerId, url: 'https://amazon.com/dp/A', position: 0,
  } as never);
  const db = getDb();
  const now = Date.now();
  for (let i = 30; i >= 1; i--) {
    db.prepare(`INSERT INTO price_history (tracker_id, tracker_url_id, price, recorded_at)
                VALUES (?, ?, ?, ?)`)
      .run(trackerId, trackerUrlId, 100 - i * 0.5, now - i * 86_400_000);
  }
  db.prepare(`UPDATE tracker_urls SET last_price=? WHERE id=?`).run(lastPrice, trackerUrlId);
  return { trackerId, trackerUrlId };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  mockClient.mockReset();
  _setClientForTesting(mockClient);
  process.env.AI_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test';
});

describe('cron AI hook', () => {
  it('fires verdict generation after a price-change scrape', async () => {
    const userId = seedUser();
    const { trackerId, trackerUrlId } = seedTrackerWith30dHistory(userId, 95);
    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    mockClient.mockResolvedValueOnce({
      text: 'At the all-time low.',
      inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50,
    });

    await checkTrackerUrl(trackerUrlId);
    // Wait a tick for the fire-and-forget verdict generator to settle.
    await new Promise(r => setTimeout(r, 50));

    expect(mockClient).toHaveBeenCalledTimes(1);
    const t = getDb().prepare('SELECT * FROM trackers WHERE id=?').get(trackerId) as Record<string, unknown>;
    expect(t.ai_verdict_tier).toBeTruthy();
    expect(t.ai_verdict_reason).toBe('At the all-time low.');
  });

  it('scrape pipeline completes even if AI generator throws', async () => {
    const userId = seedUser();
    const { trackerId, trackerUrlId } = seedTrackerWith30dHistory(userId, 95);
    vi.mocked(extractPrice).mockResolvedValue({
      price: 80, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    mockClient.mockRejectedValue(new Error('claude down'));

    await expect(checkTrackerUrl(trackerUrlId)).resolves.not.toThrow();
    await new Promise(r => setTimeout(r, 50));

    const t = getDb().prepare('SELECT * FROM trackers WHERE id=?').get(trackerId) as Record<string, unknown>;
    expect(t.ai_failure_count).toBe(1);
    // The scrape itself must have committed a price_history row regardless.
    const ph = getDb().prepare('SELECT COUNT(*) as c FROM price_history WHERE tracker_id=?').get(trackerId) as { c: number };
    expect(ph.c).toBeGreaterThan(30);
  });
});
```

⚠️ Note for implementer: the `as never` casts on `createTracker` / `addTrackerUrl` calls are placeholders — match the actual signatures from `queries.ts` when fleshing out. Consult `cron-cooldown.test.ts:60-150` for the canonical seeding shape.

- [ ] **Step 2: Modify `cron.ts` — fire-and-forget on price change**

Locate the per-tick handler in `cron.ts` (the function that processes one `tracker_urls` row). After the call site that updates `last_price` and detects a change, after `refreshTrackerAggregates`, add:

```ts
import { generateVerdictForTracker } from '../ai/generators.js';

// ... inside the handler, after the price-change detection and aggregate refresh ...

if (priceChanged && config.aiEnabled) {
  // Fire-and-forget — do NOT await. Errors are swallowed by the generator.
  void generateVerdictForTracker(tracker.id).catch(() => { /* generator already logs */ });
}
```

The exact insertion point: search for where `firePriceAlerts` is invoked in the existing handler. The verdict regeneration happens *after* `refreshTrackerAggregates` (because the verdict reads aggregated price) and *parallel* to the alert dispatch.

- [ ] **Step 3: Run scheduler test suite — verify still green**

```bash
cd server && npm test -- scheduler
```

Expected: all existing scheduler tests still pass; new cron-ai test passes too.

- [ ] **Step 4: Commit**

```bash
git add server/src/scheduler/cron.ts server/src/scheduler/cron-ai.test.ts
git commit -m "feat(ai): wire fire-and-forget verdict regeneration into the cron path

After a successful scrape detects a price change and after aggregates
are refreshed, kick off generateVerdictForTracker without awaiting.
Gated on config.aiEnabled. Errors are swallowed inside the generator;
the scrape path is unaffected.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: Alert copy integration — `firePriceAlerts` with 3s timeout

**Files:**
- Modify: `server/src/scheduler/cron.ts`
- Modify: `server/src/notifications/discord.ts`, `ntfy.ts`, `email.ts`, `webhook.ts`
- Modify: `server/src/notifications/discord.test.ts`, `email.test.ts`
- Create: `server/src/notifications/ntfy.test.ts`, `webhook.test.ts`

- [ ] **Step 1: Add optional `aiCommentary` parameter to each channel sender**

For each channel file, locate the price-alert send function and add the parameter, rendered conditionally.

**Discord** (`discord.ts`):

```ts
export async function sendDiscordPriceAlert(
  webhookUrl: string,
  payload: PriceAlertPayload,
  aiCommentary?: string | null,
): Promise<void> {
  // Existing description build:
  const baseDescription = /* existing logic */;
  const description = aiCommentary
    ? `${baseDescription}\n\n${aiCommentary}`
    : baseDescription;
  // ... rest of the body uses description ...
}
```

**ntfy** (`ntfy.ts`): append to message body with blank-line separator.

**Email** (`email.ts`): append to both HTML body and plaintext body. Subject unchanged.

**Webhook** (`webhook.ts`): include in JSON payload as `ai_commentary`.

- [ ] **Step 2: Update existing channel tests for `aiCommentary` present + null**

`discord.test.ts` — add:

```ts
it('renders without ai_commentary when null', async () => {
  await sendDiscordPriceAlert('https://example/wh', basePayload, null);
  const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
  expect(body.embeds[0].description).not.toContain('ai_commentary');
});

it('appends ai_commentary to embed description when provided', async () => {
  await sendDiscordPriceAlert('https://example/wh', basePayload, '12-month low.');
  const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
  expect(body.embeds[0].description).toContain('12-month low.');
});
```

`email.test.ts` — same pair, asserting HTML body and plaintext body contain the commentary.

- [ ] **Step 3: Create new minimal tests for `ntfy.ts` and `webhook.ts`**

Follow the `discord.test.ts` pattern. Each test file at minimum asserts:
- price alert renders with the expected core fields when `aiCommentary` is null
- when `aiCommentary` is provided, it appears in the rendered output (body for ntfy, JSON `ai_commentary` field for webhook)

- [ ] **Step 4: Modify `firePriceAlerts` in `cron.ts`**

Locate `firePriceAlerts`. After the per-channel cooldown check (so AI copy is generated once per dispatch, not per channel), and before the per-channel fanout, add:

```ts
import { generateAlertCopy, computeSignalsAndVerdictForTracker } from '../ai/generators.js';

// ... inside firePriceAlerts, after cooldown gate and after computing currentPrice/oldPrice context ...

let aiCommentary: string | null = null;
if (config.aiEnabled) {
  const sv = await computeSignalsAndVerdictForTracker(tracker.id);
  if (sv) {
    aiCommentary = await Promise.race([
      generateAlertCopy({
        trackerName: tracker.name,
        oldPrice, newPrice: currentPrice,
        signals: sv.signals, reasonKey: sv.verdict.reasonKey,
      }),
      new Promise<null>(resolve => setTimeout(() => resolve(null), config.aiAlertCopyTimeoutMs)),
    ]);
  }
}

// Pass aiCommentary into each channel's sender:
await sendDiscordPriceAlert(channels.discord, payload, aiCommentary);
await sendNtfyPriceAlert(channels.ntfy, channels.ntfyToken, payload, aiCommentary);
await sendGenericPriceAlert(channels.webhook, payload, aiCommentary);
await sendEmailPriceAlert(channels.email, payload, aiCommentary);
```

(Adjust the call sites to match the existing signatures — only add the new parameter.)

- [ ] **Step 5: Run all tests**

```bash
cd server && npm test
```

Expected: green. cron-cooldown / cron-plausibility / cron-recovery suites still pass (`config.aiEnabled` is false unless AI_ENABLED is set in the env).

- [ ] **Step 6: Commit**

```bash
git add server/src/scheduler/cron.ts server/src/notifications/*.ts server/src/notifications/*.test.ts
git commit -m "feat(ai): alert copy integration across all four channels

firePriceAlerts now generates an optional one-liner via Claude (3s
hard timeout) after the cooldown gate, before per-channel fanout.
Each channel sender accepts an optional aiCommentary param and
renders it conditionally. On timeout/failure, alerts dispatch
unchanged with the existing template — guaranteed no regression.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Backfill cron — nightly summary refresh

**Files:**
- Create: `server/src/ai/backfill-cron.ts`
- Create: `server/src/ai/backfill-cron.test.ts`
- Modify: `server/src/index.ts` (where existing crons are registered)

- [ ] **Step 1: Write failing tests**

Create `server/src/ai/backfill-cron.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations.js';
import { _setClientForTesting } from './generators.js';
import { runBackfillSweep } from './backfill-cron.js';
import type { ClaudeResponse } from './client.js';

const mockClient = vi.fn<[unknown], Promise<ClaudeResponse>>();

function seedTrackerWithSummaryAge(name: string, summaryAgeDays: number | null): number {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES (?, 'h', ?)`).run(`${name}@x.com`, name);
  const userId = (db.prepare('SELECT id FROM users WHERE email=?').get(`${name}@x.com`) as { id: number }).id;
  db.prepare(`INSERT INTO trackers (name, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, current_price) VALUES (?, ?, 100, 'active', 60, 0, 100)`).run(name, userId);
  const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get(name) as { id: number }).id;
  const now = Date.now();
  for (let i = 30; i >= 0; i--) {
    db.prepare(`INSERT INTO price_history (tracker_id, price, recorded_at) VALUES (?, ?, ?)`)
      .run(trackerId, 100 - i * 0.5, now - i * 86_400_000);
  }
  if (summaryAgeDays !== null) {
    db.prepare(`UPDATE trackers SET ai_summary='old', ai_summary_updated_at=? WHERE id=?`)
      .run(Date.now() - summaryAgeDays * 86_400_000, trackerId);
  }
  return trackerId;
}

beforeEach(() => {
  _setDbForTesting(new Database(':memory:'));
  runMigrations();
  mockClient.mockReset();
  _setClientForTesting(mockClient);
  process.env.AI_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test';
});
afterEach(() => _setDbForTesting(null));

describe('runBackfillSweep', () => {
  it('regenerates summaries for trackers older than 7 days', async () => {
    seedTrackerWithSummaryAge('OldA', 10);
    seedTrackerWithSummaryAge('FreshB', 1);
    mockClient.mockResolvedValue({
      text: 'New summary.', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50,
    });
    const out = await runBackfillSweep();
    expect(out.attempted).toBe(1);
    expect(mockClient).toHaveBeenCalledTimes(1);
  });

  it('regenerates summaries for trackers with NULL summary timestamp', async () => {
    seedTrackerWithSummaryAge('Never', null);
    mockClient.mockResolvedValue({
      text: 'New summary.', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50,
    });
    const out = await runBackfillSweep();
    expect(out.attempted).toBe(1);
  });

  it('respects the per-sweep limit', async () => {
    for (let i = 0; i < 60; i++) seedTrackerWithSummaryAge(`T${i}`, 10);
    mockClient.mockResolvedValue({
      text: 'New summary.', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50,
    });
    const out = await runBackfillSweep();
    expect(out.attempted).toBe(50);
  });
});
```

- [ ] **Step 2: Implement `backfill-cron.ts`**

```ts
// server/src/ai/backfill-cron.ts
import cron from 'node-cron';
import { getTrackersWithStaleSummary } from '../db/queries.js';
import { generateSummaryForTracker } from './generators.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const PER_SWEEP_LIMIT = 50;

export async function runBackfillSweep(): Promise<{ attempted: number }> {
  if (!config.aiEnabled) return { attempted: 0 };

  const stalenessMs = config.aiSummaryStalenessDays * 86_400_000;
  const candidates = getTrackersWithStaleSummary(stalenessMs, PER_SWEEP_LIMIT);
  logger.info({ count: candidates.length }, 'ai_backfill_sweep_start');

  for (const t of candidates) {
    await generateSummaryForTracker(t.id);
  }

  logger.info({ attempted: candidates.length }, 'ai_backfill_sweep_done');
  return { attempted: candidates.length };
}

let task: cron.ScheduledTask | null = null;

export function startBackfillCron(): void {
  if (task) return;
  task = cron.schedule('0 3 * * *', () => {
    runBackfillSweep().catch(err => logger.error({ err: String(err) }, 'ai_backfill_sweep_unhandled'));
  });
}

export function stopBackfillCron(): void {
  task?.stop();
  task = null;
}
```

- [ ] **Step 3: Register the cron in `server/src/index.ts`**

```ts
import { startBackfillCron } from './ai/backfill-cron.js';
// ... after existing scheduler starts ...
startBackfillCron();
```

- [ ] **Step 4: Run tests**

```bash
cd server && npm test -- backfill-cron
```

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/backfill-cron.ts server/src/ai/backfill-cron.test.ts server/src/index.ts
git commit -m "feat(ai): nightly backfill cron for stale summaries

runBackfillSweep picks up trackers whose ai_summary is older than
config.aiSummaryStalenessDays (default 7) or NULL, capped at 50 per
sweep. Wired to run nightly at 03:00. Reuses generateSummaryForTracker;
inherits its fire-and-forget error handling.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: API — include AI fields in tracker payloads

**Files:**
- Modify: `server/src/routes/trackers.ts`

- [ ] **Step 1: Locate the tracker payload serializer**

Find the function that maps `Tracker` rows to the API response shape. The eight AI fields are already on the `Tracker` type from Task 8.

- [ ] **Step 2: Update the response shape**

```ts
return {
  // ... existing fields ...
  aiVerdict: t.ai_verdict_tier ? {
    tier: t.ai_verdict_tier,
    reason: t.ai_verdict_reason,
    reasonKey: t.ai_verdict_reason_key,
    updatedAt: t.ai_verdict_updated_at,
  } : null,
  aiSummary: t.ai_summary ? {
    text: t.ai_summary,
    updatedAt: t.ai_summary_updated_at,
  } : null,
};
```

- [ ] **Step 3: Add a route test asserting the new fields are present**

In the existing trackers route test file (or create one), seed a tracker with AI fields populated:

```ts
it('returns aiVerdict and aiSummary when populated', async () => {
  const id = seedTracker();
  getDb().prepare(`UPDATE trackers SET ai_verdict_tier='BUY', ai_verdict_reason='At low.',
    ai_verdict_reason_key='at_all_time_low', ai_verdict_updated_at=?,
    ai_summary='Story.', ai_summary_updated_at=? WHERE id=?
  `).run(Date.now(), Date.now(), id);

  const resp = await request(app).get(`/api/trackers/${id}`).set('Authorization', `Bearer ${token}`);
  expect(resp.body.aiVerdict.tier).toBe('BUY');
  expect(resp.body.aiVerdict.reason).toBe('At low.');
  expect(resp.body.aiSummary.text).toBe('Story.');
});

it('returns null for AI fields when unpopulated', async () => {
  const id = seedTracker();
  const resp = await request(app).get(`/api/trackers/${id}`).set('Authorization', `Bearer ${token}`);
  expect(resp.body.aiVerdict).toBeNull();
  expect(resp.body.aiSummary).toBeNull();
});
```

- [ ] **Step 4: Run tests**

```bash
cd server && npm test -- trackers
```

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/trackers.ts server/src/routes/*.test.ts
git commit -m "feat(ai): expose aiVerdict and aiSummary on tracker API responses

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: API — `/api/health` AI observability fields

**Files:**
- Modify: `server/src/index.ts`

- [ ] **Step 1: Locate the existing `/api/health` route at `server/src/index.ts:81`**

- [ ] **Step 2: Extend it with admin-only AI fields**

```ts
import { config } from './config.js';
import { getDb } from './db/connection.js';

function countAIFailures(): number {
  return ((getDb().prepare(`SELECT SUM(ai_failure_count) as n FROM trackers`).get() as { n: number | null })?.n) ?? 0;
}

app.get('/api/health', (req, res) => {
  const baseFields = { status: 'ok' /* ... existing fields if any ... */ };

  const isAdmin = (req as { user?: { role?: string } }).user?.role === 'admin';

  if (!isAdmin) {
    return res.json(baseFields);
  }

  const aiFields = {
    ai_enabled: config.aiEnabled,
    ai_verdict_failures_24h: countAIFailures(),
    // The four metrics below require accumulators not yet in v1.
    // Land as 0 placeholders; wire in a follow-up once volume justifies it.
    ai_summary_failures_24h: 0,
    ai_alert_copy_timeouts_24h: 0,
    ai_avg_latency_ms_24h: 0,
    ai_cache_hit_rate_24h: 0,
  };

  res.json({ ...baseFields, ...aiFields });
});
```

⚠️ The non-zero metrics (alert copy timeouts, avg latency, cache hit rate) need accumulators we don't track yet. Land them as `0` literals in v1; document this limitation. Wire real values in a follow-up once volume justifies an in-memory counter or an `ai_metrics` table.

- [ ] **Step 3: Manual verification**

```bash
curl http://localhost:3100/api/health
# (admin auth flow if applicable)
```

- [ ] **Step 4: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(ai): expose AI observability fields on /api/health (admin-only)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: Frontend — `VerdictPill` component + TrackerCard integration

**Files:**
- Create: `client/src/components/VerdictPill.tsx`
- Modify: `client/src/components/TrackerCard.tsx`
- Modify: client tracker DTO type file (locate via grep — likely `client/src/api/trackers.ts` or `client/src/types.ts`)

- [ ] **Step 1: Extend the client-side Tracker type**

In whichever file declares the tracker DTO interface, add:

```ts
export interface AIVerdict {
  tier: 'BUY' | 'WAIT' | 'HOLD';
  reason: string | null;
  reasonKey: string | null;
  updatedAt: number | null;
}
export interface AISummary {
  text: string;
  updatedAt: number | null;
}

export interface Tracker {
  // ... existing fields ...
  aiVerdict: AIVerdict | null;
  aiSummary: AISummary | null;
}
```

- [ ] **Step 2: Create `VerdictPill.tsx`**

```tsx
// client/src/components/VerdictPill.tsx
import type { AIVerdict } from '../api/trackers'; // adjust path to actual DTO file

const TIER_STYLES: Record<AIVerdict['tier'], string> = {
  BUY: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20',
  WAIT: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20',
  HOLD: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20',
};

interface Props {
  verdict: AIVerdict | null;
  size?: 'sm' | 'md';
}

export function VerdictPill({ verdict, size = 'sm' }: Props) {
  if (!verdict) return null;
  const sizeClass = size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm';
  return (
    <span
      className={`inline-flex items-center rounded-md font-medium tabular-nums ${TIER_STYLES[verdict.tier]} ${sizeClass}`}
      title={verdict.reason ?? undefined}
    >
      {verdict.tier}
    </span>
  );
}
```

- [ ] **Step 3: Wire the pill into `TrackerCard.tsx`**

Locate the price row and add the pill next to the current price:

```tsx
import { VerdictPill } from './VerdictPill';

// inside the price row:
<div className="flex items-center gap-2">
  <span className="text-2xl font-semibold">${tracker.currentPrice?.toFixed(2)}</span>
  <VerdictPill verdict={tracker.aiVerdict} size="sm" />
  {/* ... existing "dropped from" indicator etc. ... */}
</div>
```

- [ ] **Step 4: Build the client to ensure no type errors**

```bash
cd client && npm run build
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/VerdictPill.tsx client/src/components/TrackerCard.tsx client/src/api/trackers.ts
git commit -m "feat(ai): VerdictPill component + TrackerCard integration

Color-coded BUY/WAIT/HOLD pill with hover-tooltip carrying the AI
reason. Renders nothing when verdict is null (gathering data —
keeps the dashboard quiet for new trackers).

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 16: Frontend — `AIInsightsCard` on TrackerDetail

**Files:**
- Create: `client/src/components/AIInsightsCard.tsx`
- Modify: `client/src/pages/TrackerDetail.tsx`

- [ ] **Step 1: Create the card component**

```tsx
// client/src/components/AIInsightsCard.tsx
import type { Tracker } from '../api/trackers';
import { VerdictPill } from './VerdictPill';

function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '';
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

interface Props {
  tracker: Tracker;
  isAdmin: boolean;
  onRefresh?: () => void;
}

export function AIInsightsCard({ tracker, isAdmin, onRefresh }: Props) {
  if (!tracker.aiVerdict && !tracker.aiSummary) return null;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <VerdictPill verdict={tracker.aiVerdict} size="md" />
          {tracker.aiVerdict?.updatedAt && (
            <span className="text-xs text-slate-500">Updated {formatRelative(tracker.aiVerdict.updatedAt)}</span>
          )}
        </div>
        {isAdmin && onRefresh && (
          <button
            onClick={onRefresh}
            className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
          >
            Refresh
          </button>
        )}
      </div>

      {tracker.aiVerdict?.reason && (
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200 mb-2">
          {tracker.aiVerdict.reason}
        </p>
      )}

      {tracker.aiSummary && (
        <p className="text-sm italic text-slate-600 dark:text-slate-400">
          {tracker.aiSummary.text}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `TrackerDetail.tsx` directly below the page header, above existing stat tiles**

```tsx
import { AIInsightsCard } from '../components/AIInsightsCard';

// inside the render — directly below the page header, above existing stat tiles:
<AIInsightsCard tracker={tracker} isAdmin={user?.role === 'admin'} />
```

The Refresh button is admin-only for v1 and may be left as a no-op (`onRefresh` undefined) until a server endpoint is added — backlog for v2.

- [ ] **Step 3: Build the client**

```bash
cd client && npm run build
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/AIInsightsCard.tsx client/src/pages/TrackerDetail.tsx
git commit -m "feat(ai): AIInsightsCard on TrackerDetail above stat tiles

Renders the verdict pill (large), AI reason (semibold), and AI
summary (italic). Hidden when tracker has neither verdict nor
summary. Admin-only Refresh button stub.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 17: Real-Claude smoke script + npm task

**Files:**
- Create: `server/src/scripts/ai-smoke.ts`
- Modify: `server/package.json` (add `ai-smoke` npm script)

- [ ] **Step 1: Create the smoke script**

```ts
// server/src/scripts/ai-smoke.ts
// Manual real-Claude smoke runner. Usage: npm run ai-smoke -- <tracker_id>
// Gated on AI_ENABLED + ANTHROPIC_API_KEY. NOT part of the test suite.

import { generateVerdictForTracker, generateSummaryForTracker } from '../ai/generators.js';
import { getTrackerById } from '../db/queries.js';

async function main() {
  const id = Number(process.argv[2]);
  if (!Number.isFinite(id)) {
    console.error('usage: npm run ai-smoke -- <tracker_id>');
    process.exit(1);
  }

  console.log(`Tracker ${id}: generating verdict...`);
  await generateVerdictForTracker(id);
  console.log(`Tracker ${id}: generating summary...`);
  await generateSummaryForTracker(id);

  const t = getTrackerById(id);
  console.log('--- result ---');
  console.log({
    tier: t?.ai_verdict_tier,
    reason: t?.ai_verdict_reason,
    summary: t?.ai_summary,
  });
}

main().catch(err => { console.error(err); process.exit(1); });
```

⚠️ The script assumes the existing DB connection bootstrap fires automatically when the modules are imported. If `connection.ts` requires a manual init call, add it explicitly here following the pattern used by other one-shot scripts in `server/src/scripts/` (e.g. `canary-sweep.ts`).

- [ ] **Step 2: Add the npm script to `server/package.json`**

```json
"scripts": {
  "ai-smoke": "tsx src/scripts/ai-smoke.ts"
}
```

- [ ] **Step 3: Verify build still passes**

```bash
cd server && npm run build && npm test
```

- [ ] **Step 4: Commit**

```bash
git add server/src/scripts/ai-smoke.ts server/package.json
git commit -m "chore(ai): add ai-smoke script for pre-deploy real-Claude eyeball test

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 18: Final pre-deploy checklist + PR

- [ ] **Step 1: Run the full server test suite — confirm green**

```bash
cd server && npm test
```

Expected: ~257 tests pass (172 existing + ~85 new). Zero failures.

- [ ] **Step 2: Run the full client test suite — confirm green**

```bash
cd client && npm test
```

- [ ] **Step 3: Build both server and client — confirm clean**

```bash
cd server && npm run build && cd ../client && npm run build
```

Expected: zero TS errors, zero warnings.

- [ ] **Step 4: Manual sanity check**

- Inspect `tasks/todo.md` — does the AI Buyer's Assistant entry still link to the spec?
- Inspect `docs/superpowers/specs/2026-05-04-ai-buyers-assistant-design.md` — unchanged on the branch?
- Check `.env.example` has the three new env vars?

- [ ] **Step 5: Per-tracker rollout test (real Claude, against the dev DB)**

```bash
cd server
AI_ENABLED=true ANTHROPIC_API_KEY=sk-... npm run ai-smoke -- <real_tracker_id>
```

Expected: prints a verdict tier, a one-sentence reason, and a 2-4 sentence summary that all reference real values from the tracker's price history. Verify the prose is sensible.

- [ ] **Step 6: Open a PR**

```bash
gh pr create --title "feat(ai): AI Buyer's Assistant — verdict pill, alert copy, summary" --body "## Summary

Implements the AI Buyer's Assistant per the spec at \`docs/superpowers/specs/2026-05-04-ai-buyers-assistant-design.md\`.

Three capabilities in v1:
- BUY/WAIT/HOLD verdict pill on tracker cards (rules-judge, LLM-narrate)
- AI commentary appended to all four notification channels (3s timeout, plain-template fallback)
- Multi-sentence price-history summary on TrackerDetail (refreshed nightly)

Architecture:
- Pure signals + verdict (zero IO, fully unit-tested)
- Anthropic Haiku 4.5 with prompt caching (~\$0.20/month estimated)
- Inline async fire-and-forget on the scrape pipeline
- AI is decoration, never infrastructure — alerts and dashboards work when Claude is unavailable

Migration v7 adds eight AI columns to \`trackers\`. New env vars: \`AI_ENABLED\` (default false), \`ANTHROPIC_API_KEY\`, \`AI_MODEL\`.

## Test plan
- [ ] All server tests pass (\`cd server && npm test\`)
- [ ] All client tests pass (\`cd client && npm test\`)
- [ ] \`npm run ai-smoke -- <id>\` produces sensible prose against a real tracker
- [ ] Deploy with \`AI_ENABLED=false\`; confirm zero behavior change
- [ ] Flip flag on, watch first verdict generate; confirm pill renders correctly
- [ ] Trigger a price change; confirm alert dispatches with AI commentary
- [ ] Wait for nightly backfill or run \`npm run ai-smoke\` on a sample to verify summary generation
- [ ] Monitor /api/health for 24h; failure rate stays low

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-review notes

### Spec coverage

| Spec section | Covered by |
|---|---|
| Capabilities (verdict, alert copy, summary) | Tasks 9, 10, 11, 12, 15, 16 |
| Model & prompt caching | Tasks 6, 7 |
| Cadence (price-change-driven, alert-time, weekly) | Tasks 10, 11, 12 |
| Authority pattern (rules judge, LLM narrates) | Tasks 4, 5, 7 |
| Verdict states (3-tier) | Tasks 5, 15 |
| Failure philosophy | Tasks 6, 9, 11 (timeout) |
| Architecture (fire-and-forget) | Task 10 |
| Migration v7 schema | Task 2 |
| Signals shape (full struct) | Task 4 |
| Verdict rules (full tree) | Task 5 |
| Prompts (3 builders, cache markers, hallucination guard) | Task 7 |
| UI surfaces (TrackerCard pill, TrackerDetail card) | Tasks 15, 16 |
| Alert copy integration (4 channels) | Task 11 |
| Error handling matrix | Tasks 6, 9 |
| Observability (/api/health) | Task 14 |
| Testing (~85 new tests) | Tasks 2, 4, 5, 6, 7, 9, 10, 11, 12 |
| Rollout plan | Tasks 1, 17, 18 |

All spec sections accounted for.

### Known assumptions to verify during implementation

- `recorded_at` column type in `price_history` (assumed INTEGER unix ms; if TEXT ISO datetime, adjust queries in Task 8 step 2)
- `current_price` column on the `trackers` table — verify name (alternatives: `last_price`, `latest_price`); adjust generators.ts and tests accordingly
- `getTrackerById` exists as a query helper; confirm signature
- `User` middleware shape on requests for the admin gate in Task 14
- Client-side tracker DTO file path (Task 15) — locate via `grep -rn "interface Tracker" client/src` and modify in place
- The cron-ai integration test placeholders in Task 10 are sketched; implementer fleshes them out using `cron-cooldown.test.ts` as the pattern reference

These are codebase-shape questions, not design questions. Implementer resolves them by reading neighboring code at task time.
