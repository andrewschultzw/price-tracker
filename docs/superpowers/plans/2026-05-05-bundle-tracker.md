# Bundle Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Layer a project (basket) abstraction on top of trackers. A user creates named projects with a target total budget, adds N existing trackers as members, and receives a "basket ready" alert when sum(last_price) drops at or below the target with all items available.

**Architecture:** Event-driven fire-and-forget on tracker scrape (mirrors the AI Buyer's Assistant verdict regen pattern). Pure deterministic basket evaluation; firer orchestrator owns dispatch + cooldown gate + DB writes; new dedicated channel-renderer functions per channel; new `/projects` REST surface; new `/projects` and `/projects/:id` frontend routes. M:N membership via a join table; per-item ceilings stored on the join row but informational only.

**Tech Stack:** TypeScript, Express, better-sqlite3, vitest, node-cron, React + Tailwind on the client. Reuses the AI Buyer's Assistant infrastructure (`@anthropic-ai/sdk`, prompt builders, `client.ts`, `<VerdictPill>`).

**Spec:** `docs/superpowers/specs/2026-05-05-bundle-tracker-design.md`

**Branch:** `feature/bundle-tracker`

---

## File Structure

### New files

| Path | Responsibility |
|---|---|
| `server/src/projects/types.ts` | Shared types: `Project`, `ProjectTracker`, `BasketMember`, `BasketState`, `IneligibleReason` |
| `server/src/projects/basket.ts` | Pure: `evaluateBasket(project, members) → BasketState` |
| `server/src/projects/basket.test.ts` | Pure unit tests for every basket state |
| `server/src/projects/firer.ts` | Orchestrator: `evaluateAndFireForProject(projectId)` — only writer of `project_notifications` |
| `server/src/projects/firer.test.ts` | Integration tests with mocked channel senders |
| `server/src/db/migration-v9.test.ts` | Migration v9 schema/idempotency tests |
| `server/src/db/queries.project.test.ts` | DB queries unit tests for project CRUD + member ops |
| `server/src/routes/projects.ts` | REST routes for projects + members |
| `server/src/routes/projects.test.ts` | API tests |
| `server/src/scheduler/cron-projects.test.ts` | Cron integration test |
| `server/src/notifications/discord-basket.test.ts` | Basket-variant tests for Discord |
| `server/src/notifications/ntfy-basket.test.ts` | Basket-variant tests for ntfy |
| `server/src/notifications/email-basket.test.ts` | Basket-variant tests for email |
| `server/src/notifications/webhook-basket.test.ts` | Basket-variant tests for webhook |
| `client/src/pages/Projects.tsx` | List view |
| `client/src/pages/ProjectDetail.tsx` | Detail view |
| `client/src/components/BasketTotalCard.tsx` | Composite verdict + total/target/progress |
| `client/src/components/BasketMembersTable.tsx` | Member rows with VerdictPill, ceiling, action menu |
| `client/src/components/AddTrackerModal.tsx` | Searchable tracker picker |
| `client/src/components/RecentAlertsSection.tsx` | Last 10 project notifications |
| `client/src/api/projects.ts` | API client wrappers (fetch/POST/PATCH/DELETE for projects + members) |

### Modified files

| Path | Change |
|---|---|
| `server/src/db/migrations.ts` | Append migration v9 — three new tables |
| `server/src/db/queries.ts` | Append project read/write helpers + new types from `projects/types.ts` re-exported |
| `server/src/scheduler/cron.ts` | (1) export `getEnabledChannels` + `getCooldownHoursForChannel` for firer reuse; (2) call firer after AI verdict fire-and-forget |
| `server/src/notifications/discord.ts` | Add `sendDiscordBasketAlert` |
| `server/src/notifications/ntfy.ts` | Add `sendNtfyBasketAlert` |
| `server/src/notifications/email.ts` | Add `sendEmailBasketAlert` |
| `server/src/notifications/webhook.ts` | Add `sendGenericBasketAlert` |
| `server/src/ai/prompts.ts` | Add `buildBasketAlertCopyPrompt` |
| `server/src/ai/prompts.test.ts` | Add tests for `buildBasketAlertCopyPrompt` |
| `server/src/index.ts` | Mount `/api/projects` route |
| `client/src/types.ts` | Add `Project`, `BasketMember`, `BasketState`, `ProjectTracker` types |
| `client/src/App.tsx` (or routing config) | Add `/projects` and `/projects/:id` routes |
| Top nav | Add `Projects` link |

---

## Task 1: Migration v9 — projects + project_trackers + project_notifications

**Files:**
- Modify: `server/src/db/migrations.ts` (append v9 entry)
- Create: `server/src/db/migration-v9.test.ts`

- [ ] **Step 1: Write the failing migration test**

Create `server/src/db/migration-v9.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { runMigrations } from './migrations.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

describe('migration v9 — projects, project_trackers, project_notifications', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    runMigrations();
  });

  it('creates projects table with expected columns', () => {
    const cols = getDb().prepare("PRAGMA table_info(projects)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    for (const expected of ['id', 'user_id', 'name', 'target_total', 'status', 'created_at', 'updated_at']) {
      expect(names).toContain(expected);
    }
  });

  it('creates project_trackers join table with composite primary key', () => {
    const cols = getDb().prepare("PRAGMA table_info(project_trackers)").all() as { name: string; pk: number }[];
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pkCols).toEqual(['project_id', 'tracker_id']);
  });

  it('creates project_notifications table with expected columns', () => {
    const cols = getDb().prepare("PRAGMA table_info(project_notifications)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    for (const expected of ['id', 'project_id', 'channel', 'basket_total', 'target_total', 'ai_commentary', 'sent_at']) {
      expect(names).toContain(expected);
    }
  });

  it('creates the reverse-direction index on project_trackers(tracker_id)', () => {
    const indexes = getDb().prepare("PRAGMA index_list(project_trackers)").all() as { name: string }[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_project_trackers_tracker_id');
  });

  it('creates the per-channel cooldown lookup index on project_notifications', () => {
    const indexes = getDb().prepare("PRAGMA index_list(project_notifications)").all() as { name: string }[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_project_notifications_project_channel');
  });

  it('migration v9 is idempotent', () => {
    runMigrations();
    runMigrations();
    const projectsCols = getDb().prepare("PRAGMA table_info(projects)").all();
    expect(projectsCols).toHaveLength(7);
  });

  it('cascades delete: deleting a project removes its project_trackers + project_notifications', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(`INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes) VALUES ('T','https://x',?,100,'active',60,0)`).run(userId);
    const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get('T') as { id: number }).id;
    db.prepare(`INSERT INTO projects (user_id, name, target_total) VALUES (?, 'P', 100)`).run(userId);
    const projectId = (db.prepare('SELECT id FROM projects WHERE name=?').get('P') as { id: number }).id;
    db.prepare(`INSERT INTO project_trackers (project_id, tracker_id) VALUES (?, ?)`).run(projectId, trackerId);
    db.prepare(`INSERT INTO project_notifications (project_id, channel, basket_total, target_total) VALUES (?, 'discord', 80, 100)`).run(projectId);

    db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);

    expect((db.prepare('SELECT COUNT(*) as c FROM project_trackers WHERE project_id=?').get(projectId) as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) as c FROM project_notifications WHERE project_id=?').get(projectId) as { c: number }).c).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /root/price-tracker/server && npm test -- migration-v9
```

Expected: tests fail because the tables don't exist yet.

- [ ] **Step 3: Append migration v9 to `server/src/db/migrations.ts`**

Inside the `migrations` array, after the v8 entry (which adds AI columns), add:

```ts
{
  version: 9,
  description: "Bundle Tracker — projects, project_trackers, project_notifications",
  up: () => {
    const db = getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        target_total REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_projects_user_id ON projects(user_id);
      CREATE INDEX IF NOT EXISTS idx_projects_user_status ON projects(user_id, status);

      CREATE TABLE IF NOT EXISTS project_trackers (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
        per_item_ceiling REAL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, tracker_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_trackers_tracker_id ON project_trackers(tracker_id);

      CREATE TABLE IF NOT EXISTS project_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        channel TEXT NOT NULL CHECK (channel IN ('discord', 'ntfy', 'webhook', 'email')),
        basket_total REAL NOT NULL,
        target_total REAL NOT NULL,
        ai_commentary TEXT,
        sent_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_project_notifications_project_channel
        ON project_notifications(project_id, channel, sent_at DESC);
    `);
  },
},
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- migration-v9
```

All 7 cases should pass.

- [ ] **Step 5: Run the full server suite — verify no regressions**

```bash
cd /root/price-tracker/server && npm test
```

Expected: previous 364 + 7 new = 371/371.

- [ ] **Step 6: Commit**

```bash
git add server/src/db/migrations.ts server/src/db/migration-v9.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): migration v9 adds projects + project_trackers + project_notifications

Three new tables: projects (named basket with target_total + status),
project_trackers (M:N membership with per_item_ceiling + position),
and project_notifications (per-channel cooldown source-of-truth +
history). Composite PK on project_trackers prevents duplicate
membership; reverse index supports the per-scrape "find projects
containing this tracker" lookup. CASCADE deletes propagate from
projects → memberships + notifications.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Types — Project / ProjectTracker / BasketMember / BasketState / IneligibleReason

**Files:**
- Create: `server/src/projects/types.ts`

- [ ] **Step 1: Create the types file**

```ts
// server/src/projects/types.ts

export interface Project {
  id: number;
  user_id: number;
  name: string;
  target_total: number;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface ProjectTracker {
  project_id: number;
  tracker_id: number;
  per_item_ceiling: number | null;
  position: number;
  created_at: string;
}

export interface BasketMember {
  tracker_id: number;
  tracker_name: string;
  last_price: number | null;
  tracker_status: 'active' | 'paused' | 'error';
  per_item_ceiling: number | null;
  position: number;
  // Surfaced for the project detail view (set by AI Buyer's Assistant).
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
}

export type IneligibleReason =
  | 'no_items'
  | 'item_missing_price'
  | 'item_errored'
  | 'over_target';

export interface BasketState {
  total: number | null;
  target_total: number;
  item_count: number;
  items_with_price: number;
  items_below_ceiling: number;
  eligible: boolean;
  ineligible_reason: IneligibleReason | null;
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /root/price-tracker/server && npm run build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/src/projects/types.ts
git commit -m "$(cat <<'EOF'
feat(projects): define shared types for the Bundle Tracker

Project, ProjectTracker, BasketMember, BasketState, IneligibleReason.
BasketMember surfaces the AI verdict fields populated by the AI
Buyer's Assistant so the project detail view can render the
existing <VerdictPill> per item.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Pure basket evaluation — `evaluateBasket`

**Files:**
- Create: `server/src/projects/basket.ts`
- Create: `server/src/projects/basket.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/projects/basket.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateBasket } from './basket.js';
import type { Project, BasketMember } from './types.js';

const project: Project = {
  id: 1, user_id: 1, name: 'Test', target_total: 100,
  status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05',
};

const member = (overrides: Partial<BasketMember> = {}): BasketMember => ({
  tracker_id: 1, tracker_name: 'X', last_price: 50, tracker_status: 'active',
  per_item_ceiling: null, position: 0,
  ai_verdict_tier: null, ai_verdict_reason: null,
  ...overrides,
});

describe('evaluateBasket', () => {
  it('returns no_items when members list is empty', () => {
    const s = evaluateBasket(project, []);
    expect(s.eligible).toBe(false);
    expect(s.ineligible_reason).toBe('no_items');
    expect(s.total).toBeNull();
    expect(s.item_count).toBe(0);
  });

  it('returns item_errored when any member has tracker_status === "error"', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30 }),
      member({ tracker_id: 2, last_price: 40, tracker_status: 'error' }),
    ]);
    expect(s.eligible).toBe(false);
    expect(s.ineligible_reason).toBe('item_errored');
  });

  it('returns item_missing_price when any active member has null last_price', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30 }),
      member({ tracker_id: 2, last_price: null }),
    ]);
    expect(s.eligible).toBe(false);
    expect(s.ineligible_reason).toBe('item_missing_price');
    expect(s.total).toBeNull();
  });

  it('returns eligible true when total < target', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30 }),
      member({ tracker_id: 2, last_price: 40 }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.ineligible_reason).toBeNull();
    expect(s.total).toBe(70);
  });

  it('returns eligible true when total === target (boundary)', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 60 }),
      member({ tracker_id: 2, last_price: 40 }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.total).toBe(100);
  });

  it('returns over_target when total > target', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 80 }),
      member({ tracker_id: 2, last_price: 40 }),
    ]);
    expect(s.eligible).toBe(false);
    expect(s.ineligible_reason).toBe('over_target');
    expect(s.total).toBe(120);
  });

  it('counts items_with_price correctly', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30 }),
      member({ tracker_id: 2, last_price: 40 }),
    ]);
    expect(s.item_count).toBe(2);
    expect(s.items_with_price).toBe(2);
  });

  it('counts items_below_ceiling when ceiling is set and item is below', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30, per_item_ceiling: 35 }),
      member({ tracker_id: 2, last_price: 40, per_item_ceiling: 50 }),
      member({ tracker_id: 3, last_price: 60, per_item_ceiling: 50 }), // over ceiling
    ]);
    // Ceilings are display-only; eligibility unaffected.
    expect(s.items_below_ceiling).toBe(2);
  });

  it('items_below_ceiling counts items WITHOUT a ceiling as "below" (no constraint)', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30, per_item_ceiling: null }),
      member({ tracker_id: 2, last_price: 40, per_item_ceiling: 50 }),
    ]);
    // Both pass — null ceiling = no constraint, so it counts as "below"
    expect(s.items_below_ceiling).toBe(2);
  });

  it('paused members with last_price still contribute to total + eligibility', () => {
    // Paused != error. A paused tracker has a known last_price; the
    // user opted to stop scraping but the price stands.
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30, tracker_status: 'active' }),
      member({ tracker_id: 2, last_price: 40, tracker_status: 'paused' }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.total).toBe(70);
  });

  it('error precedence: error trumps missing-price', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: null }),
      member({ tracker_id: 2, last_price: 40, tracker_status: 'error' }),
    ]);
    expect(s.ineligible_reason).toBe('item_errored');
  });

  it('returns target_total in the state regardless of eligibility', () => {
    const s = evaluateBasket(project, []);
    expect(s.target_total).toBe(100);
  });

  it('handles single-tracker basket eligible', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 50 }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.total).toBe(50);
    expect(s.item_count).toBe(1);
  });

  it('handles fractional cents correctly', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 33.33 }),
      member({ tracker_id: 2, last_price: 33.33 }),
      member({ tracker_id: 3, last_price: 33.34 }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.total).toBeCloseTo(100, 2);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (module does not exist)**

```bash
cd /root/price-tracker/server && npm test -- basket.test
```

- [ ] **Step 3: Implement `server/src/projects/basket.ts`**

```ts
// server/src/projects/basket.ts
import type { Project, BasketMember, BasketState } from './types.js';

export function evaluateBasket(project: Project, members: BasketMember[]): BasketState {
  const target_total = project.target_total;

  if (members.length === 0) {
    return {
      total: null,
      target_total,
      item_count: 0,
      items_with_price: 0,
      items_below_ceiling: 0,
      eligible: false,
      ineligible_reason: 'no_items',
    };
  }

  const item_count = members.length;
  const items_with_price = members.filter(m => m.last_price !== null).length;
  // null ceiling = no constraint; treat as "below"
  const items_below_ceiling = members.filter(m =>
    m.per_item_ceiling === null || (m.last_price !== null && m.last_price <= m.per_item_ceiling)
  ).length;

  // Errored items take precedence — the basket math is unreliable.
  const errored = members.find(m => m.tracker_status === 'error');
  if (errored) {
    const partial = members
      .filter(m => m.last_price !== null)
      .reduce((sum, m) => sum + (m.last_price as number), 0);
    return {
      total: partial,
      target_total,
      item_count,
      items_with_price,
      items_below_ceiling,
      eligible: false,
      ineligible_reason: 'item_errored',
    };
  }

  // Missing price (e.g. brand-new tracker that hasn't scraped yet).
  if (members.some(m => m.last_price === null)) {
    return {
      total: null,
      target_total,
      item_count,
      items_with_price,
      items_below_ceiling,
      eligible: false,
      ineligible_reason: 'item_missing_price',
    };
  }

  const total = members.reduce((sum, m) => sum + (m.last_price as number), 0);
  const eligible = total <= target_total;

  return {
    total,
    target_total,
    item_count,
    items_with_price,
    items_below_ceiling,
    eligible,
    ineligible_reason: eligible ? null : 'over_target',
  };
}
```

- [ ] **Step 4: Run — all tests PASS**

```bash
cd /root/price-tracker/server && npm test -- basket.test
```

Expected: 14 tests pass.

- [ ] **Step 5: Run full suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 385/385 (was 371; +14).

- [ ] **Step 6: Commit**

```bash
git add server/src/projects/basket.ts server/src/projects/basket.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): pure basket evaluation — evaluateBasket

Deterministic, no IO. Maps Project + BasketMember[] to a BasketState
with total / target_total / counts / eligibility / reason. Error
precedence: errored item > missing price > over target. Per-item
ceilings counted for display only — they do not gate eligibility.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: DB queries for projects + members + notifications

**Files:**
- Modify: `server/src/db/queries.ts` (append project helpers)
- Create: `server/src/db/queries.project.test.ts`

- [ ] **Step 1: Add project query helpers to `server/src/db/queries.ts`**

Re-export the project types at the top so callers can import from a single place:

```ts
// at the top of queries.ts (next to the existing type imports)
export type { Project, ProjectTracker, BasketMember, BasketState, IneligibleReason } from '../projects/types.js';
```

Append the helpers at the bottom of the file:

```ts
// === Projects ===

import type { Project, BasketMember } from '../projects/types.js';

export function listProjectsForUser(userId: number, status?: 'active' | 'archived'): Project[] {
  if (status) {
    return getDb().prepare(
      `SELECT * FROM projects WHERE user_id = ? AND status = ? ORDER BY created_at DESC`
    ).all(userId, status) as Project[];
  }
  return getDb().prepare(
    `SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC`
  ).all(userId) as Project[];
}

export function getProjectById(id: number, userId?: number): Project | undefined {
  const row = userId !== undefined
    ? getDb().prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`).get(id, userId)
    : getDb().prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
  return row as Project | undefined;
}

export function createProject(args: { user_id: number; name: string; target_total: number }): number {
  const result = getDb().prepare(
    `INSERT INTO projects (user_id, name, target_total) VALUES (?, ?, ?)`
  ).run(args.user_id, args.name, args.target_total);
  return Number(result.lastInsertRowid);
}

export function updateProject(
  id: number,
  args: { name?: string; target_total?: number; status?: 'active' | 'archived' }
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (args.name !== undefined) { sets.push('name = ?'); values.push(args.name); }
  if (args.target_total !== undefined) { sets.push('target_total = ?'); values.push(args.target_total); }
  if (args.status !== undefined) { sets.push('status = ?'); values.push(args.status); }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  getDb().prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteProject(id: number): void {
  getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

export function addProjectTracker(args: {
  project_id: number;
  tracker_id: number;
  per_item_ceiling?: number | null;
  position?: number;
}): void {
  const position = args.position ?? 0;
  const ceiling = args.per_item_ceiling ?? null;
  getDb().prepare(
    `INSERT INTO project_trackers (project_id, tracker_id, per_item_ceiling, position) VALUES (?, ?, ?, ?)`
  ).run(args.project_id, args.tracker_id, ceiling, position);
}

export function removeProjectTracker(projectId: number, trackerId: number): void {
  getDb().prepare(
    `DELETE FROM project_trackers WHERE project_id = ? AND tracker_id = ?`
  ).run(projectId, trackerId);
}

export function updateProjectTracker(
  projectId: number,
  trackerId: number,
  args: { per_item_ceiling?: number | null; position?: number }
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (args.per_item_ceiling !== undefined) { sets.push('per_item_ceiling = ?'); values.push(args.per_item_ceiling); }
  if (args.position !== undefined) { sets.push('position = ?'); values.push(args.position); }
  if (sets.length === 0) return;
  values.push(projectId, trackerId);
  getDb().prepare(
    `UPDATE project_trackers SET ${sets.join(', ')} WHERE project_id = ? AND tracker_id = ?`
  ).run(...values);
}

/** Returns the IDs of active projects containing this tracker. Called per-scrape. */
export function getActiveProjectIdsForTracker(trackerId: number): number[] {
  const rows = getDb().prepare(
    `SELECT pt.project_id FROM project_trackers pt
     INNER JOIN projects p ON p.id = pt.project_id
     WHERE pt.tracker_id = ? AND p.status = 'active'`
  ).all(trackerId) as { project_id: number }[];
  return rows.map(r => r.project_id);
}

/**
 * Loads basket members for a project — joins project_trackers + trackers
 * and surfaces the AI verdict fields populated by the AI Buyer's Assistant.
 * Sorted by position, then tracker name as a stable tiebreaker.
 */
export function getBasketMembersForProject(projectId: number): BasketMember[] {
  const rows = getDb().prepare(
    `SELECT
       t.id AS tracker_id,
       t.name AS tracker_name,
       t.last_price,
       t.status AS tracker_status,
       pt.per_item_ceiling,
       pt.position,
       t.ai_verdict_tier,
       t.ai_verdict_reason
     FROM project_trackers pt
     INNER JOIN trackers t ON t.id = pt.tracker_id
     WHERE pt.project_id = ?
     ORDER BY pt.position ASC, t.name ASC`
  ).all(projectId) as BasketMember[];
  return rows;
}

// === Project notifications (cooldown source-of-truth + history) ===

export interface ProjectNotificationRecord {
  id: number;
  project_id: number;
  channel: string;
  basket_total: number;
  target_total: number;
  ai_commentary: string | null;
  sent_at: string;
}

export function getLastProjectNotificationForChannel(
  projectId: number,
  channel: string,
): ProjectNotificationRecord | undefined {
  return getDb().prepare(
    `SELECT * FROM project_notifications
     WHERE project_id = ? AND channel = ?
     ORDER BY sent_at DESC LIMIT 1`
  ).get(projectId, channel) as ProjectNotificationRecord | undefined;
}

export function getRecentProjectNotifications(projectId: number, limit: number): ProjectNotificationRecord[] {
  return getDb().prepare(
    `SELECT * FROM project_notifications
     WHERE project_id = ?
     ORDER BY sent_at DESC LIMIT ?`
  ).all(projectId, limit) as ProjectNotificationRecord[];
}

export function addProjectNotification(args: {
  project_id: number;
  channel: string;
  basket_total: number;
  target_total: number;
  ai_commentary: string | null;
}): void {
  getDb().prepare(
    `INSERT INTO project_notifications (project_id, channel, basket_total, target_total, ai_commentary)
     VALUES (?, ?, ?, ?, ?)`
  ).run(args.project_id, args.channel, args.basket_total, args.target_total, args.ai_commentary);
}
```

- [ ] **Step 2: Write the failing tests at `server/src/db/queries.project.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createProject, getProjectById, listProjectsForUser, updateProject, deleteProject,
  addProjectTracker, removeProjectTracker, updateProjectTracker,
  getActiveProjectIdsForTracker, getBasketMembersForProject,
  getLastProjectNotificationForChannel, getRecentProjectNotifications, addProjectNotification,
} from './queries.js';

function seedUser(email = 't@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'T', 'user', 1)`
  ).run(email).lastInsertRowid);
}

function seedTracker(userId: number, name = 'X', lastPrice: number | null = 50): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 100, 'active', 60, 0, ?)`
  ).run(name, `https://example.com/${name}`, userId, lastPrice).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('project CRUD', () => {
  it('creates and retrieves a project', () => {
    const userId = seedUser();
    const id = createProject({ user_id: userId, name: 'NAS', target_total: 1200 });
    const p = getProjectById(id);
    expect(p?.name).toBe('NAS');
    expect(p?.target_total).toBe(1200);
    expect(p?.status).toBe('active');
  });

  it('getProjectById with userId scopes correctly (cross-user isolation)', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const id = createProject({ user_id: u1, name: 'P', target_total: 100 });
    expect(getProjectById(id, u1)).toBeDefined();
    expect(getProjectById(id, u2)).toBeUndefined();
  });

  it('listProjectsForUser filters by status when provided', () => {
    const u = seedUser();
    const a = createProject({ user_id: u, name: 'A', target_total: 100 });
    const b = createProject({ user_id: u, name: 'B', target_total: 100 });
    updateProject(b, { status: 'archived' });
    expect(listProjectsForUser(u, 'active').map(p => p.id)).toEqual([a]);
    expect(listProjectsForUser(u, 'archived').map(p => p.id)).toEqual([b]);
    expect(listProjectsForUser(u).map(p => p.id).sort()).toEqual([a, b].sort());
  });

  it('updateProject is partial (only specified fields change)', () => {
    const u = seedUser();
    const id = createProject({ user_id: u, name: 'A', target_total: 100 });
    updateProject(id, { name: 'B' });
    const p = getProjectById(id);
    expect(p?.name).toBe('B');
    expect(p?.target_total).toBe(100);
    expect(p?.status).toBe('active');
  });

  it('deleteProject cascades to project_trackers + project_notifications', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t });
    addProjectNotification({ project_id: p, channel: 'discord', basket_total: 50, target_total: 100, ai_commentary: null });
    deleteProject(p);
    expect(getProjectById(p)).toBeUndefined();
  });
});

describe('project membership', () => {
  it('addProjectTracker stores ceiling + position', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t, per_item_ceiling: 25, position: 3 });
    const members = getBasketMembersForProject(p);
    expect(members).toHaveLength(1);
    expect(members[0].per_item_ceiling).toBe(25);
    expect(members[0].position).toBe(3);
  });

  it('addProjectTracker rejects duplicate (project, tracker) pair via PK', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t });
    expect(() => addProjectTracker({ project_id: p, tracker_id: t })).toThrow();
  });

  it('removeProjectTracker removes only the matching row', () => {
    const u = seedUser();
    const t1 = seedTracker(u, 'A');
    const t2 = seedTracker(u, 'B');
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });
    removeProjectTracker(p, t1);
    expect(getBasketMembersForProject(p).map(m => m.tracker_id)).toEqual([t2]);
  });

  it('updateProjectTracker updates ceiling without touching position', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t, per_item_ceiling: 25, position: 3 });
    updateProjectTracker(p, t, { per_item_ceiling: 30 });
    const members = getBasketMembersForProject(p);
    expect(members[0].per_item_ceiling).toBe(30);
    expect(members[0].position).toBe(3);
  });

  it('getBasketMembersForProject surfaces AI verdict fields when populated', () => {
    const u = seedUser();
    const t = seedTracker(u);
    getDb().prepare(`UPDATE trackers SET ai_verdict_tier='BUY', ai_verdict_reason='At low.' WHERE id=?`).run(t);
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t });
    const members = getBasketMembersForProject(p);
    expect(members[0].ai_verdict_tier).toBe('BUY');
    expect(members[0].ai_verdict_reason).toBe('At low.');
  });
});

describe('cron lookup', () => {
  it('getActiveProjectIdsForTracker returns only active project ids', () => {
    const u = seedUser();
    const t = seedTracker(u);
    const a = createProject({ user_id: u, name: 'A', target_total: 100 });
    const b = createProject({ user_id: u, name: 'B', target_total: 100 });
    updateProject(b, { status: 'archived' });
    addProjectTracker({ project_id: a, tracker_id: t });
    addProjectTracker({ project_id: b, tracker_id: t });
    expect(getActiveProjectIdsForTracker(t)).toEqual([a]);
  });

  it('getActiveProjectIdsForTracker returns empty when tracker is in no projects', () => {
    const u = seedUser();
    const t = seedTracker(u);
    expect(getActiveProjectIdsForTracker(t)).toEqual([]);
  });
});

describe('project notifications', () => {
  it('addProjectNotification + getLastProjectNotificationForChannel returns latest row', async () => {
    const u = seedUser();
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    addProjectNotification({ project_id: p, channel: 'discord', basket_total: 80, target_total: 100, ai_commentary: null });
    await new Promise(r => setTimeout(r, 10));
    addProjectNotification({ project_id: p, channel: 'discord', basket_total: 75, target_total: 100, ai_commentary: 'AI-test' });
    const last = getLastProjectNotificationForChannel(p, 'discord');
    expect(last?.basket_total).toBe(75);
    expect(last?.ai_commentary).toBe('AI-test');
  });

  it('getRecentProjectNotifications respects the limit', () => {
    const u = seedUser();
    const p = createProject({ user_id: u, name: 'P', target_total: 100 });
    for (let i = 0; i < 15; i++) {
      addProjectNotification({ project_id: p, channel: 'discord', basket_total: i, target_total: 100, ai_commentary: null });
    }
    const rows = getRecentProjectNotifications(p, 5);
    expect(rows).toHaveLength(5);
  });
});
```

- [ ] **Step 3: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- queries.project
```

Expected: ~14 tests pass.

- [ ] **Step 4: Run full server suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 399/399 (was 385; +14).

- [ ] **Step 5: Commit**

```bash
git add server/src/db/queries.ts server/src/db/queries.project.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): DB read/write helpers for projects + members + notifications

Project CRUD, member CRUD with composite-PK enforcement, getBasketMembersForProject
joining trackers and surfacing AI verdict fields from the AI Buyer's Assistant,
getActiveProjectIdsForTracker for the cron path, and project notification
helpers for the cooldown source-of-truth + recent-alerts UI section.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Channel basket renderers — `sendXxxBasketAlert` for all four channels

**Files:**
- Modify: `server/src/notifications/discord.ts`, `ntfy.ts`, `email.ts`, `webhook.ts`
- Create: `server/src/notifications/discord-basket.test.ts`, `ntfy-basket.test.ts`, `email-basket.test.ts`, `webhook-basket.test.ts`

Each new sender accepts:

```ts
sendXxxBasketAlert(
  project: Project,
  basket: BasketState,
  members: BasketMember[],
  channelTarget: string,        // webhook URL / ntfy URL / email recipient
  ntfyToken?: string,            // ntfy only
  aiCommentary?: string | null,
): Promise<boolean>
```

(The `ntfyToken` parameter only exists for the ntfy sender; for the others it's omitted.)

- [ ] **Step 1: Add `sendDiscordBasketAlert` to `server/src/notifications/discord.ts`**

Append at the bottom of the file:

```ts
import type { Project, BasketState, BasketMember } from '../projects/types.js';

export async function sendDiscordBasketAlert(
  project: Project,
  basket: BasketState,
  members: BasketMember[],
  webhookUrl: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;
  const savings = (project.target_total - basket.total).toFixed(2);
  const memberLines = members
    .map(m => `• ${m.tracker_name} — $${(m.last_price ?? 0).toFixed(2)}`)
    .join('\n');
  const baseDescription = `${memberLines}`;
  const description = aiCommentary
    ? `${baseDescription}\n\n${aiCommentary}`
    : baseDescription;

  const embed: Record<string, unknown> = {
    title: `Bundle Ready: ${project.name}`,
    color: 0x00c853,
    description,
    fields: [
      { name: 'Total', value: `$${basket.total.toFixed(2)}`, inline: true },
      { name: 'Target', value: `$${project.target_total.toFixed(2)}`, inline: true },
      { name: 'Savings', value: `$${savings}`, inline: true },
      { name: 'Items', value: String(basket.item_count), inline: true },
    ],
  };

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    return resp.ok;
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'Discord basket alert failed');
    return false;
  }
}
```

- [ ] **Step 2: Test it — `server/src/notifications/discord-basket.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendDiscordBasketAlert } from './discord.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

function makeProject(): Project {
  return { id: 1, user_id: 1, name: 'NAS Build', target_total: 100,
    status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05' };
}
function makeBasket(): BasketState {
  return { total: 80, target_total: 100, item_count: 2,
    items_with_price: 2, items_below_ceiling: 2, eligible: true, ineligible_reason: null };
}
function makeMembers(): BasketMember[] {
  return [
    { tracker_id: 1, tracker_name: 'SSD', last_price: 30, tracker_status: 'active',
      per_item_ceiling: null, position: 0, ai_verdict_tier: 'BUY', ai_verdict_reason: null },
    { tracker_id: 2, tracker_name: 'CPU', last_price: 50, tracker_status: 'active',
      per_item_ceiling: null, position: 1, ai_verdict_tier: 'BUY', ai_verdict_reason: null },
  ];
}
function mockFetch(status = 204) {
  const fn = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => '' });
  // @ts-expect-error overriding global for tests
  globalThis.fetch = fn;
  return fn;
}

describe('sendDiscordBasketAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders title + total/target/savings + member list', async () => {
    const fetchSpy = mockFetch();
    const ok = await sendDiscordBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://example/wh');
    expect(ok).toBe(true);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const embed = body.embeds[0];
    expect(embed.title).toBe('Bundle Ready: NAS Build');
    expect(embed.description).toContain('SSD');
    expect(embed.description).toContain('CPU');
    const fieldByName = (n: string) => embed.fields.find((f: { name: string }) => f.name === n)?.value;
    expect(fieldByName('Total')).toBe('$80.00');
    expect(fieldByName('Target')).toBe('$100.00');
    expect(fieldByName('Savings')).toBe('$20.00');
    expect(fieldByName('Items')).toBe('2');
  });

  it('omits aiCommentary when null', async () => {
    const fetchSpy = mockFetch();
    await sendDiscordBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://example/wh', null);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.embeds[0].description).not.toContain('great deal');
  });

  it('appends aiCommentary when provided', async () => {
    const fetchSpy = mockFetch();
    await sendDiscordBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://example/wh', 'All 4 components at 30-day low.');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.embeds[0].description).toContain('All 4 components at 30-day low.');
  });
});
```

- [ ] **Step 3: Add `sendNtfyBasketAlert` to `server/src/notifications/ntfy.ts`**

Append at the bottom of the file:

```ts
import type { Project as ProjectType, BasketState as BasketStateType, BasketMember as BasketMemberType } from '../projects/types.js';

export async function sendNtfyBasketAlert(
  project: ProjectType,
  basket: BasketStateType,
  members: BasketMemberType[],
  ntfyUrl: string,
  ntfyToken?: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;
  let target: NtfyTarget;
  try {
    target = parseNtfyUrl(ntfyUrl);
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'Invalid ntfy URL');
    return false;
  }
  const savings = (project.target_total - basket.total).toFixed(2);
  const memberLines = members
    .map(m => `• ${m.tracker_name} — $${(m.last_price ?? 0).toFixed(2)}`)
    .join('\n');
  const baseBody = `Total: $${basket.total.toFixed(2)} (target $${project.target_total.toFixed(2)}, savings $${savings})\n\n${memberLines}`;
  const body = aiCommentary ? `${baseBody}\n\n${aiCommentary}` : baseBody;

  try {
    const headers: Record<string, string> = {
      'content-type': 'text/plain; charset=utf-8',
      'title': `Bundle Ready: ${project.name}`,
    };
    if (ntfyToken) headers['authorization'] = `Bearer ${ntfyToken}`;
    const resp = await fetch(target.url, { method: 'POST', headers, body });
    return resp.ok;
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'ntfy basket alert failed');
    return false;
  }
}
```

- [ ] **Step 4: Test ntfy basket — `server/src/notifications/ntfy-basket.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendNtfyBasketAlert } from './ntfy.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

function makeProject(): Project {
  return { id: 1, user_id: 1, name: 'NAS Build', target_total: 100,
    status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05' };
}
function makeBasket(): BasketState {
  return { total: 80, target_total: 100, item_count: 2,
    items_with_price: 2, items_below_ceiling: 2, eligible: true, ineligible_reason: null };
}
function makeMembers(): BasketMember[] {
  return [
    { tracker_id: 1, tracker_name: 'SSD', last_price: 30, tracker_status: 'active',
      per_item_ceiling: null, position: 0, ai_verdict_tier: null, ai_verdict_reason: null },
    { tracker_id: 2, tracker_name: 'CPU', last_price: 50, tracker_status: 'active',
      per_item_ceiling: null, position: 1, ai_verdict_tier: null, ai_verdict_reason: null },
  ];
}
function mockFetch(status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => '' });
  // @ts-expect-error overriding global for tests
  globalThis.fetch = fn;
  return fn;
}

describe('sendNtfyBasketAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders body with totals + members', async () => {
    const fetchSpy = mockFetch();
    const ok = await sendNtfyBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://ntfy.example/topic');
    expect(ok).toBe(true);
    const body = fetchSpy.mock.calls[0][1].body as string;
    expect(body).toContain('$80.00');
    expect(body).toContain('SSD');
    expect(body).toContain('CPU');
    expect(fetchSpy.mock.calls[0][1].headers.title).toBe('Bundle Ready: NAS Build');
  });

  it('appends aiCommentary when provided', async () => {
    const fetchSpy = mockFetch();
    await sendNtfyBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://ntfy.example/topic', undefined, 'Worth pulling the trigger.');
    const body = fetchSpy.mock.calls[0][1].body as string;
    expect(body).toContain('Worth pulling the trigger.');
  });

  it('renders without aiCommentary when null', async () => {
    const fetchSpy = mockFetch();
    await sendNtfyBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://ntfy.example/topic', undefined, null);
    const body = fetchSpy.mock.calls[0][1].body as string;
    expect(body).not.toContain('Worth pulling');
  });
});
```

- [ ] **Step 5: Add `sendEmailBasketAlert` to `server/src/notifications/email.ts`**

Append at the bottom of the file (assuming `formatMoney`, `getTransport`, and `config` are already imported in this file from earlier work):

```ts
import type { Project as ProjectType2, BasketState as BasketStateType2, BasketMember as BasketMemberType2 } from '../projects/types.js';

function basketEmailText(project: ProjectType2, basket: BasketStateType2, members: BasketMemberType2[], aiCommentary?: string | null): string {
  if (basket.total === null) return '';
  const memberLines = members.map(m => `  • ${m.tracker_name} — ${formatMoney(m.last_price ?? 0)}`).join('\n');
  const base = `Bundle ready: ${project.name}\n\n` +
    `Total: ${formatMoney(basket.total)} (target ${formatMoney(project.target_total)}, savings ${formatMoney(project.target_total - basket.total)})\n\n` +
    `Items:\n${memberLines}\n`;
  return aiCommentary ? `${base}\n${aiCommentary}\n` : base;
}

function basketEmailHtml(project: ProjectType2, basket: BasketStateType2, members: BasketMemberType2[], aiCommentary?: string | null): string {
  if (basket.total === null) return '';
  const memberRows = members.map(m =>
    `<li>${m.tracker_name} — <strong>${formatMoney(m.last_price ?? 0)}</strong></li>`
  ).join('');
  const aiBlock = aiCommentary ? `<p><em>${aiCommentary}</em></p>` : '';
  return `<h2>Bundle ready: ${project.name}</h2>` +
    `<p>Total: <strong>${formatMoney(basket.total)}</strong> ` +
    `(target ${formatMoney(project.target_total)}, savings ${formatMoney(project.target_total - basket.total)})</p>` +
    `<ul>${memberRows}</ul>${aiBlock}`;
}

export async function sendEmailBasketAlert(
  project: ProjectType2,
  basket: BasketStateType2,
  members: BasketMemberType2[],
  recipient: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: `Bundle ready: ${project.name} hit ${formatMoney(basket.total)}`,
      text: basketEmailText(project, basket, members, aiCommentary ?? null),
      html: basketEmailHtml(project, basket, members, aiCommentary ?? null),
    });
    logger.info({ projectId: project.id, total: basket.total }, 'Email basket alert sent');
    return true;
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'Email basket alert failed');
    return false;
  }
}
```

- [ ] **Step 6: Test email basket — `server/src/notifications/email-basket.test.ts`**

Mirror the existing email.test.ts mock setup (mock nodemailer + config). Then:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const sentMessages: any[] = [];
vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({
    sendMail: vi.fn(opts => { sentMessages.push(opts); return Promise.resolve({ messageId: 'test-id' }); }),
  })) },
}));
vi.mock('../config.js', () => ({
  config: { smtpHost: 'h', smtpPort: 465, smtpUser: 'u', smtpPass: 'p', smtpFrom: 'a@b.c' },
  isEmailConfigured: () => true,
}));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { sendEmailBasketAlert } from './email.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

function makeProject(): Project {
  return { id: 1, user_id: 1, name: 'NAS Build', target_total: 100,
    status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05' };
}
function makeBasket(): BasketState {
  return { total: 80, target_total: 100, item_count: 2,
    items_with_price: 2, items_below_ceiling: 2, eligible: true, ineligible_reason: null };
}
function makeMembers(): BasketMember[] {
  return [
    { tracker_id: 1, tracker_name: 'SSD', last_price: 30, tracker_status: 'active',
      per_item_ceiling: null, position: 0, ai_verdict_tier: null, ai_verdict_reason: null },
    { tracker_id: 2, tracker_name: 'CPU', last_price: 50, tracker_status: 'active',
      per_item_ceiling: null, position: 1, ai_verdict_tier: null, ai_verdict_reason: null },
  ];
}

describe('sendEmailBasketAlert', () => {
  beforeEach(() => { sentMessages.length = 0; });

  it('sends email with subject + bodies containing totals + members', async () => {
    const ok = await sendEmailBasketAlert(makeProject(), makeBasket(), makeMembers(), 'user@example.com');
    expect(ok).toBe(true);
    expect(sentMessages[0].subject).toContain('NAS Build');
    expect(sentMessages[0].subject).toContain('80');
    expect(sentMessages[0].text).toContain('SSD');
    expect(sentMessages[0].html).toContain('SSD');
  });

  it('appends aiCommentary to both bodies when provided', async () => {
    await sendEmailBasketAlert(makeProject(), makeBasket(), makeMembers(), 'user@example.com', 'Worth pulling the trigger.');
    expect(sentMessages[0].text).toContain('Worth pulling the trigger.');
    expect(sentMessages[0].html).toContain('Worth pulling the trigger.');
  });

  it('omits aiCommentary when null', async () => {
    await sendEmailBasketAlert(makeProject(), makeBasket(), makeMembers(), 'user@example.com', null);
    expect(sentMessages[0].text).not.toContain('Worth pulling');
    expect(sentMessages[0].html).not.toContain('Worth pulling');
  });
});
```

- [ ] **Step 7: Add `sendGenericBasketAlert` to `server/src/notifications/webhook.ts`**

```ts
import type { Project as ProjectType3, BasketState as BasketStateType3, BasketMember as BasketMemberType3 } from '../projects/types.js';

export async function sendGenericBasketAlert(
  project: ProjectType3,
  basket: BasketStateType3,
  members: BasketMemberType3[],
  webhookUrl: string,
  aiCommentary?: string | null,
): Promise<boolean> {
  if (basket.total === null) return false;
  try {
    assertWebhookUrl(webhookUrl);
    const payload = {
      event: 'bundle_ready' as const,
      project: {
        id: project.id, name: project.name,
        target_total: project.target_total, status: project.status,
      },
      basket: {
        total: basket.total,
        target_total: basket.target_total,
        savings: project.target_total - basket.total,
        item_count: basket.item_count,
      },
      members: members.map(m => ({
        tracker_id: m.tracker_id,
        tracker_name: m.tracker_name,
        last_price: m.last_price,
        per_item_ceiling: m.per_item_ceiling,
        ai_verdict_tier: m.ai_verdict_tier,
      })),
      ai_commentary: aiCommentary ?? null,
    };
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return resp.ok;
  } catch (err) {
    logger.error({ err, projectId: project.id }, 'Generic webhook basket alert failed');
    return false;
  }
}
```

- [ ] **Step 8: Test webhook basket — `server/src/notifications/webhook-basket.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendGenericBasketAlert } from './webhook.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

function makeProject(): Project { return { id: 1, user_id: 1, name: 'NAS', target_total: 100,
  status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05' }; }
function makeBasket(): BasketState { return { total: 80, target_total: 100, item_count: 2,
  items_with_price: 2, items_below_ceiling: 2, eligible: true, ineligible_reason: null }; }
function makeMembers(): BasketMember[] { return [
  { tracker_id: 1, tracker_name: 'SSD', last_price: 30, tracker_status: 'active',
    per_item_ceiling: null, position: 0, ai_verdict_tier: 'BUY', ai_verdict_reason: null },
]; }
function mockFetch(status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => '' });
  // @ts-expect-error overriding global for tests
  globalThis.fetch = fn;
  return fn;
}

describe('sendGenericBasketAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts JSON with event=bundle_ready + project + basket + members', async () => {
    const fetchSpy = mockFetch();
    const ok = await sendGenericBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://hooks.example/x');
    expect(ok).toBe(true);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.event).toBe('bundle_ready');
    expect(body.project.name).toBe('NAS');
    expect(body.basket.total).toBe(80);
    expect(body.basket.savings).toBe(20);
    expect(body.members[0].tracker_name).toBe('SSD');
    expect(body.members[0].ai_verdict_tier).toBe('BUY');
    expect(body.ai_commentary).toBeNull();
  });

  it('includes ai_commentary in the JSON when provided', async () => {
    const fetchSpy = mockFetch();
    await sendGenericBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://hooks.example/x', 'AI line.');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.ai_commentary).toBe('AI line.');
  });
});
```

- [ ] **Step 9: Run full server suite — verify everything green**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 410/410 (was 399; +11 new across the four test files).

- [ ] **Step 10: Commit**

```bash
git add server/src/notifications/discord.ts server/src/notifications/ntfy.ts server/src/notifications/email.ts server/src/notifications/webhook.ts server/src/notifications/discord-basket.test.ts server/src/notifications/ntfy-basket.test.ts server/src/notifications/email-basket.test.ts server/src/notifications/webhook-basket.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): basket-alert renderers for all four channels

Each channel gains a sendXxxBasketAlert function wrapping the
existing transport. Same optional aiCommentary parameter convention
as the per-tracker AI alert copy. Discord: embed with title,
total/target/savings/items fields, member list in description.
ntfy: title + body with totals + member list. Email: subject with
total, HTML + plaintext bodies. Webhook: { event: 'bundle_ready',
project, basket, members, ai_commentary } JSON.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: AI prompt builder for basket alerts

**Files:**
- Modify: `server/src/ai/prompts.ts` — add `buildBasketAlertCopyPrompt` + `BasketAlertCopyContext` interface
- Modify: `server/src/ai/prompts.test.ts` — add tests

- [ ] **Step 1: Append the new builder + context type to `server/src/ai/prompts.ts`**

```ts
import type { Project, BasketState, BasketMember } from '../projects/types.js';

export interface BasketAlertCopyContext {
  project: Project;
  basket: BasketState;
  members: BasketMember[];
}

export function buildBasketAlertCopyPrompt(ctx: BasketAlertCopyContext): ClaudePromptInput {
  const systemText = `${TONE_BLOCK}

You are composing a one-sentence punchy line to append to a "bundle ready" alert. The user has set a target total budget for a basket of products, and the basket has just dropped at or below the target. Reference the most striking signal across the basket — e.g. the savings amount, the number of items at recent lows, or the largest individual contributor to the savings. Length: max 120 characters. Output the sentence only — no quotes, no labels, no preamble.

${HALLUCINATION_GUARD}`;

  const userText = `${JSON.stringify({
    project_name: ctx.project.name,
    basket_total: ctx.basket.total,
    target_total: ctx.basket.target_total,
    savings: ctx.basket.total !== null ? ctx.basket.target_total - ctx.basket.total : null,
    item_count: ctx.basket.item_count,
    members: ctx.members.map(m => ({
      name: m.tracker_name,
      price: m.last_price,
      verdict: m.ai_verdict_tier,
    })),
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

Note: `promptName: 'alert'` reuses the existing enum value — no need to extend `ClaudePromptInput['promptName']` since the bucket is logical (alert copy).

- [ ] **Step 2: Append tests to `server/src/ai/prompts.test.ts`**

```ts
import type { Project, BasketState, BasketMember } from '../projects/types.js';

const sampleProject: Project = {
  id: 1, user_id: 1, name: 'NAS Build', target_total: 1200,
  status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05',
};
const sampleBasket: BasketState = {
  total: 1149, target_total: 1200, item_count: 8,
  items_with_price: 8, items_below_ceiling: 8, eligible: true, ineligible_reason: null,
};
const sampleMembersBasket: BasketMember[] = [
  { tracker_id: 1, tracker_name: 'Samsung 990 Pro 4TB', last_price: 279, tracker_status: 'active',
    per_item_ceiling: 280, position: 0, ai_verdict_tier: 'BUY', ai_verdict_reason: 'At low.' },
];

describe('buildBasketAlertCopyPrompt', () => {
  it('promptName is "alert" and limit is 120 chars', () => {
    const p = buildBasketAlertCopyPrompt({ project: sampleProject, basket: sampleBasket, members: sampleMembersBasket });
    expect(p.promptName).toBe('alert');
    expect(p.maxOutputChars).toBe(120);
  });

  it('serializes basket savings + project name in user block', () => {
    const p = buildBasketAlertCopyPrompt({ project: sampleProject, basket: sampleBasket, members: sampleMembersBasket });
    expect(p.user).toContain('NAS Build');
    expect(p.user).toContain('1149');
    expect(p.user).toContain('1200');
    expect(p.user).toContain('51');                       // savings
  });

  it('marks the system block as cache-controlled ephemeral', () => {
    const p = buildBasketAlertCopyPrompt({ project: sampleProject, basket: sampleBasket, members: sampleMembersBasket });
    expect(p.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('system block contains hallucination guard wording', () => {
    const p = buildBasketAlertCopyPrompt({ project: sampleProject, basket: sampleBasket, members: sampleMembersBasket });
    expect(p.system[0].text).toMatch(/only use values present in the signals/i);
  });
});
```

- [ ] **Step 3: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- prompts.test
```

Expected: 13 tests (was 9 + 4 new).

- [ ] **Step 4: Run full suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 414/414 (was 410; +4).

- [ ] **Step 5: Commit**

```bash
git add server/src/ai/prompts.ts server/src/ai/prompts.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): AI prompt builder for basket alert copy

buildBasketAlertCopyPrompt feeds Claude the project name, totals,
savings, and per-member context (name + price + verdict tier).
Reuses the existing TONE_BLOCK + HALLUCINATION_GUARD constants and
the ephemeralSystem() helper. promptName='alert' shares the bucket
with per-tracker alert copy for logging/metrics consistency.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Firer — `evaluateAndFireForProject`

**Files:**
- Modify: `server/src/scheduler/cron.ts` — export `getEnabledChannels` + `getCooldownHoursForChannel` for firer reuse
- Create: `server/src/projects/firer.ts`
- Create: `server/src/projects/firer.test.ts`

- [ ] **Step 1: Export the channel helpers from `cron.ts`**

In `server/src/scheduler/cron.ts`, change:

```ts
function getCooldownHoursForChannel(userId: number, channel: ChannelName): number {
```

to:

```ts
export function getCooldownHoursForChannel(userId: number, channel: ChannelName): number {
```

And similarly for `getEnabledChannels`:

```ts
export function getEnabledChannels(userId: number | null | undefined): EnabledChannels {
```

Also export the `ChannelName` type and `CHANNEL_NAMES` constant if not already exported:

```ts
export type ChannelName = 'discord' | 'ntfy' | 'webhook' | 'email';
export const CHANNEL_NAMES: readonly ChannelName[] = ['discord', 'ntfy', 'webhook', 'email'] as const;
```

(If `ChannelName` and `CHANNEL_NAMES` are already declared internally in the file, just add `export` keywords.)

- [ ] **Step 2: Verify the build still works**

```bash
cd /root/price-tracker/server && npm run build
```

Expected: clean. Existing scheduler tests must still pass:

```bash
cd /root/price-tracker/server && npm test -- scheduler
```

Expected: 414/414 still green.

- [ ] **Step 3: Write the firer test at `server/src/projects/firer.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
  sendDiscordBasketAlert: vi.fn().mockResolvedValue(true),
  testDiscordWebhook: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyPriceAlert: vi.fn().mockResolvedValue(true),
  sendNtfyErrorAlert: vi.fn().mockResolvedValue(true),
  sendNtfyBasketAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericPriceAlert: vi.fn().mockResolvedValue(true),
  sendGenericErrorAlert: vi.fn().mockResolvedValue(true),
  sendGenericBasketAlert: vi.fn().mockResolvedValue(true),
  assertWebhookUrl: vi.fn(),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailPriceAlert: vi.fn().mockResolvedValue(true),
  sendEmailErrorAlert: vi.fn().mockResolvedValue(true),
  sendEmailBasketAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createProject, addProjectTracker, setSetting } from '../db/queries.js';
import { evaluateAndFireForProject } from './firer.js';
import { sendDiscordBasketAlert } from '../notifications/discord.js';
import { sendNtfyBasketAlert } from '../notifications/ntfy.js';
import { sendEmailBasketAlert } from '../notifications/email.js';
import { sendGenericBasketAlert } from '../notifications/webhook.js';

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function seedTracker(userId: number, name: string, lastPrice: number | null, status: 'active' | 'paused' | 'error' = 'active'): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 100, ?, 60, 0, ?)`
  ).run(name, `https://example/${name}`, userId, status, lastPrice).lastInsertRowid);
}

function setupChannels(userId: number) {
  setSetting('discord_webhook_url', 'https://example/wh', userId);
  setSetting('ntfy_url', 'https://ntfy.example/topic', userId);
  setSetting('email_recipient', 'user@example.com', userId);
  setSetting('generic_webhook_url', 'https://hooks.example/x', userId);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('evaluateAndFireForProject', () => {
  it('fires across all 4 enabled channels when basket is eligible', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30);
    const t2 = seedTracker(u, 'B', 40);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });

    await evaluateAndFireForProject(p);

    expect(sendDiscordBasketAlert).toHaveBeenCalledTimes(1);
    expect(sendNtfyBasketAlert).toHaveBeenCalledTimes(1);
    expect(sendEmailBasketAlert).toHaveBeenCalledTimes(1);
    expect(sendGenericBasketAlert).toHaveBeenCalledTimes(1);

    const notifs = getDb().prepare('SELECT channel FROM project_notifications WHERE project_id=?').all(p) as { channel: string }[];
    expect(notifs.map(n => n.channel).sort()).toEqual(['discord', 'email', 'ntfy', 'webhook']);
  });

  it('does NOT fire when basket is over target', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 80);
    const t2 = seedTracker(u, 'B', 40);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });

    await evaluateAndFireForProject(p);
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('does NOT fire when any member is errored', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30, 'active');
    const t2 = seedTracker(u, 'B', 40, 'error');
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });

    await evaluateAndFireForProject(p);
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('does NOT fire when project is archived', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    getDb().prepare(`UPDATE projects SET status='archived' WHERE id=?`).run(p);

    await evaluateAndFireForProject(p);
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('respects per-channel cooldown — Discord skipped within 6h, ntfy still fires', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });

    // Seed a recent Discord notification (1 hour ago — well within default 6h cooldown).
    getDb().prepare(
      `INSERT INTO project_notifications (project_id, channel, basket_total, target_total, sent_at)
       VALUES (?, 'discord', 30, 100, datetime('now', '-1 hour'))`
    ).run(p);

    await evaluateAndFireForProject(p);
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
    expect(sendNtfyBasketAlert).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no channels are enabled', async () => {
    const u = seedUser();
    // No setupChannels call — user has nothing configured
    const t1 = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });

    await expect(evaluateAndFireForProject(p)).resolves.not.toThrow();
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('does not throw if project does not exist', async () => {
    await expect(evaluateAndFireForProject(99999)).resolves.not.toThrow();
  });

  it('one channel failing does not block other channels', async () => {
    vi.mocked(sendDiscordBasketAlert).mockResolvedValueOnce(false);
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });

    await evaluateAndFireForProject(p);

    expect(sendDiscordBasketAlert).toHaveBeenCalledTimes(1);
    expect(sendNtfyBasketAlert).toHaveBeenCalledTimes(1);
    // Discord failure → no notification logged for it; ntfy/email/webhook all logged
    const notifs = getDb().prepare('SELECT channel FROM project_notifications WHERE project_id=?').all(p) as { channel: string }[];
    expect(notifs.map(n => n.channel).sort()).toEqual(['email', 'ntfy', 'webhook']);
  });
});
```

- [ ] **Step 4: Run — expect FAIL (firer.ts does not exist)**

```bash
cd /root/price-tracker/server && npm test -- firer.test
```

- [ ] **Step 5: Implement `server/src/projects/firer.ts`**

```ts
// server/src/projects/firer.ts
import { evaluateBasket } from './basket.js';
import {
  getProjectById, getBasketMembersForProject,
  getLastProjectNotificationForChannel, addProjectNotification,
} from '../db/queries.js';
import {
  getEnabledChannels, getCooldownHoursForChannel, CHANNEL_NAMES,
} from '../scheduler/cron.js';
import type { ChannelName } from '../scheduler/cron.js';
import { sendDiscordBasketAlert } from '../notifications/discord.js';
import { sendNtfyBasketAlert } from '../notifications/ntfy.js';
import { sendEmailBasketAlert } from '../notifications/email.js';
import { sendGenericBasketAlert } from '../notifications/webhook.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { buildBasketAlertCopyPrompt } from '../ai/prompts.js';
import { callClaude } from '../ai/client.js';
import { AIGenerationError } from '../ai/types.js';

function isWithinCooldown(lastSentAt: string, cooldownHours: number): boolean {
  if (cooldownHours <= 0) return false;
  const lastMs = new Date(lastSentAt + 'Z').getTime();
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  return Date.now() - lastMs < cooldownMs;
}

async function maybeGenerateAICommentary(ctx: { project: { id: number; user_id: number; name: string; target_total: number; status: 'active' | 'archived'; created_at: string; updated_at: string }; basket: ReturnType<typeof evaluateBasket>; members: ReturnType<typeof getBasketMembersForProject> }): Promise<string | null> {
  if (process.env.AI_ENABLED !== 'true') return null;
  if (ctx.basket.total === null) return null;
  try {
    const prompt = buildBasketAlertCopyPrompt({ project: ctx.project, basket: ctx.basket, members: ctx.members });
    const result = await Promise.race([
      callClaude(prompt).then(r => r.text),
      new Promise<null>(resolve => setTimeout(() => resolve(null), config.aiAlertCopyTimeoutMs)),
    ]);
    return result;
  } catch (err) {
    if (err instanceof AIGenerationError) {
      logger.info({ category: err.category, project_id: ctx.project.id }, 'ai_basket_copy_skip');
      return null;
    }
    logger.error({ err: String(err), project_id: ctx.project.id }, 'ai_basket_copy_unexpected');
    return null;
  }
}

export async function evaluateAndFireForProject(projectId: number): Promise<void> {
  try {
    const project = getProjectById(projectId);
    if (!project) {
      logger.info({ project_id: projectId }, 'basket_eval_skip_missing');
      return;
    }
    if (project.status !== 'active') {
      logger.info({ project_id: projectId, status: project.status }, 'basket_eval_skip_inactive');
      return;
    }

    const members = getBasketMembersForProject(projectId);
    const basket = evaluateBasket(project, members);

    if (!basket.eligible) {
      logger.info({ project_id: projectId, ineligible_reason: basket.ineligible_reason }, 'basket_eval_skip');
      return;
    }
    if (basket.total === null) return;  // Type narrowing — eligible implies non-null total

    const channels = getEnabledChannels(project.user_id);
    if (!channels.discord && !channels.ntfy && !channels.webhook && !channels.email) {
      logger.info({ project_id: projectId }, 'basket_alert_no_channels_enabled');
      return;
    }

    // Determine eligible channels (after cooldown gate).
    const eligibleChannels: ChannelName[] = [];
    for (const name of CHANNEL_NAMES) {
      if (!channels[name]) continue;
      const cooldownHours = getCooldownHoursForChannel(project.user_id, name);
      if (cooldownHours > 0) {
        const last = getLastProjectNotificationForChannel(projectId, name);
        if (last && isWithinCooldown(last.sent_at, cooldownHours)) {
          logger.info({ project_id: projectId, channel: name, cooldownHours }, 'basket_alert_cooldown');
          continue;
        }
      }
      eligibleChannels.push(name);
    }
    if (eligibleChannels.length === 0) return;

    // Generate AI commentary once for all eligible channels.
    const aiCommentary = await maybeGenerateAICommentary({ project, basket, members });

    // Dispatch in parallel; record notifications only for successful sends.
    const dispatch = await Promise.allSettled(eligibleChannels.map(async (name) => {
      let ok = false;
      switch (name) {
        case 'discord':
          ok = await sendDiscordBasketAlert(project, basket, members, channels.discord!, aiCommentary);
          break;
        case 'ntfy':
          ok = await sendNtfyBasketAlert(project, basket, members, channels.ntfy!, channels.ntfyToken, aiCommentary);
          break;
        case 'email':
          ok = await sendEmailBasketAlert(project, basket, members, channels.email!, aiCommentary);
          break;
        case 'webhook':
          ok = await sendGenericBasketAlert(project, basket, members, channels.webhook!, aiCommentary);
          break;
      }
      return { name, ok };
    }));

    for (let i = 0; i < dispatch.length; i++) {
      const result = dispatch[i];
      if (result.status === 'fulfilled' && result.value.ok) {
        addProjectNotification({
          project_id: projectId,
          channel: result.value.name,
          basket_total: basket.total,
          target_total: project.target_total,
          ai_commentary: aiCommentary,
        });
        logger.info({ project_id: projectId, channel: result.value.name, basket_total: basket.total, target_total: project.target_total }, 'basket_alert_fire');
      } else {
        const channelName = result.status === 'fulfilled' ? result.value.name : eligibleChannels[i];
        logger.warn({ project_id: projectId, channel: channelName, err: result.status === 'rejected' ? String(result.reason) : 'send returned false' }, 'basket_alert_failed');
      }
    }
  } catch (err) {
    logger.error({ project_id: projectId, err: String(err) }, 'basket_eval_unexpected');
  }
}
```

The `EnabledChannels` shape from `cron.ts` already has `discord`, `ntfy`, `ntfyToken`, `webhook`, `email` fields — the firer reuses it directly.

- [ ] **Step 6: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- firer.test
```

Expected: 8 firer tests pass.

- [ ] **Step 7: Run full suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 422/422 (was 414; +8).

- [ ] **Step 8: Commit**

```bash
git add server/src/scheduler/cron.ts server/src/projects/firer.ts server/src/projects/firer.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): firer orchestrator + per-channel cooldown gate

evaluateAndFireForProject is the only writer of project_notifications.
Loads project + members → evaluateBasket → per-channel cooldown gate
(reusing the same ${channel}_cooldown_hours user setting as per-tracker
alerts) → optional AI commentary via Promise.race(3000ms) → parallel
dispatch with Promise.allSettled. One channel failing does not block
the others. Errors caught and logged structured.

Required exporting getEnabledChannels + getCooldownHoursForChannel
+ CHANNEL_NAMES + ChannelName from cron.ts.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Cron integration — fire-and-forget basket re-eval

**Files:**
- Modify: `server/src/scheduler/cron.ts` — add the post-AI-verdict project re-eval hook
- Create: `server/src/scheduler/cron-projects.test.ts`

- [ ] **Step 1: Modify `cron.ts` — add the project re-eval hook in `checkTrackerUrl`**

Locate the existing AI verdict hook (added in the AI Buyer's Assistant — Task 10 of that plan) inside `checkTrackerUrl`, around the success path after `refreshTrackerAggregates(tracker.id)`:

```ts
// existing AI verdict hook
if (process.env.AI_ENABLED === 'true' && seller.last_price !== result.price) {
  void generateVerdictForTracker(tracker.id).catch(() => {});
}
```

Add a new line immediately after:

```ts
import { evaluateAndFireForProject } from '../projects/firer.js';
import { getActiveProjectIdsForTracker } from '../db/queries.js';

// ... and within checkTrackerUrl, AFTER the existing AI verdict hook:

// Project basket re-eval — fire-and-forget for every active project
// containing this tracker. Independent of AI flag.
const activeProjectIds = getActiveProjectIdsForTracker(tracker.id);
for (const projectId of activeProjectIds) {
  void evaluateAndFireForProject(projectId).catch(() => {
    // firer logs internally — outer catch is the fire-and-forget backstop
  });
}
```

- [ ] **Step 2: Write the cron integration test at `server/src/scheduler/cron-projects.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', () => ({ extractPrice: vi.fn() }));
vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
  sendDiscordBasketAlert: vi.fn().mockResolvedValue(true),
  testDiscordWebhook: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyPriceAlert: vi.fn().mockResolvedValue(true),
  sendNtfyErrorAlert: vi.fn().mockResolvedValue(true),
  sendNtfyBasketAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericPriceAlert: vi.fn().mockResolvedValue(true),
  sendGenericErrorAlert: vi.fn().mockResolvedValue(true),
  sendGenericBasketAlert: vi.fn().mockResolvedValue(true),
  assertWebhookUrl: vi.fn(),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailPriceAlert: vi.fn().mockResolvedValue(true),
  sendEmailErrorAlert: vi.fn().mockResolvedValue(true),
  sendEmailBasketAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createProject, addProjectTracker, setSetting } from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordBasketAlert } from '../notifications/discord.js';

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function seedTrackerWithSeller(userId: number, name: string, lastPrice: number): { trackerId: number; trackerUrlId: number } {
  const trackerInsert = getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 999, 'active', 60, 0, ?)`
  ).run(name, `https://amazon.com/dp/${name}`, userId, lastPrice);
  const trackerId = Number(trackerInsert.lastInsertRowid);
  const urlInsert = getDb().prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position, last_price, status)
     VALUES (?, ?, 0, ?, 'active')`
  ).run(trackerId, `https://amazon.com/dp/${name}`, lastPrice);
  const trackerUrlId = Number(urlInsert.lastInsertRowid);
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
});

describe('cron project re-eval hook', () => {
  it('fires basket alert when scrape brings basket total at-or-below target', async () => {
    const u = seedUser();
    setSetting('discord_webhook_url', 'https://example/wh', u);
    const { trackerId: t1, trackerUrlId: url1 } = seedTrackerWithSeller(u, 'A', 80);
    const { trackerId: t2 } = seedTrackerWithSeller(u, 'B', 40);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });

    // Mock the next scrape to bring A from 80 → 50 (basket: 50+40=90 ≤ 100)
    vi.mocked(extractPrice).mockResolvedValue({
      price: 50, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(url1);
    // Wait a tick for fire-and-forget firer to settle
    await new Promise(r => setTimeout(r, 100));

    expect(sendDiscordBasketAlert).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire basket alert when project is archived', async () => {
    const u = seedUser();
    setSetting('discord_webhook_url', 'https://example/wh', u);
    const { trackerId: t1, trackerUrlId: url1 } = seedTrackerWithSeller(u, 'A', 80);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    getDb().prepare(`UPDATE projects SET status='archived' WHERE id=?`).run(p);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 50, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(url1);
    await new Promise(r => setTimeout(r, 100));

    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('does NOT block the scrape pipeline if the firer throws', async () => {
    const u = seedUser();
    setSetting('discord_webhook_url', 'https://example/wh', u);
    const { trackerId: t1, trackerUrlId: url1 } = seedTrackerWithSeller(u, 'A', 80);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });

    vi.mocked(extractPrice).mockResolvedValue({
      price: 50, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    vi.mocked(sendDiscordBasketAlert).mockRejectedValue(new Error('discord down'));

    await expect(checkTrackerUrl(url1)).resolves.not.toThrow();
    // Even if alert fails, the price_history row was inserted by the scrape
    const phRows = getDb().prepare('SELECT COUNT(*) as c FROM price_history WHERE tracker_id=?').get(t1) as { c: number };
    expect(phRows.c).toBeGreaterThan(0);
  });

  it('does nothing when tracker is in no projects', async () => {
    const u = seedUser();
    setSetting('discord_webhook_url', 'https://example/wh', u);
    const { trackerUrlId: url1 } = seedTrackerWithSeller(u, 'A', 80);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 50, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(url1);
    await new Promise(r => setTimeout(r, 100));

    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- cron-projects
```

Expected: 4 tests pass.

- [ ] **Step 4: Run full suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 426/426 (was 422; +4).

- [ ] **Step 5: Commit**

```bash
git add server/src/scheduler/cron.ts server/src/scheduler/cron-projects.test.ts
git commit -m "$(cat <<'EOF'
feat(projects): wire basket re-eval into the cron path

After every successful scrape (and after the existing AI verdict
fire-and-forget hook), look up active projects containing this
tracker and kick off evaluateAndFireForProject for each. Fully
fire-and-forget — errors swallowed inside the firer; scrape pipeline
unaffected.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: API routes — `/api/projects` + member endpoints

**Files:**
- Create: `server/src/routes/projects.ts`
- Create: `server/src/routes/projects.test.ts`
- Modify: `server/src/index.ts` — mount the route

- [ ] **Step 1: Create `server/src/routes/projects.ts`**

```ts
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  listProjectsForUser, getProjectById, createProject, updateProject, deleteProject,
  addProjectTracker, removeProjectTracker, updateProjectTracker,
  getBasketMembersForProject, getRecentProjectNotifications,
  getTrackerById,
} from '../db/queries.js';

const router = Router();

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200),
  target_total: z.number().positive(),
});
const UpdateProjectSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  target_total: z.number().positive().optional(),
  status: z.enum(['active', 'archived']).optional(),
});
const AddTrackerSchema = z.object({
  tracker_id: z.number().int().positive(),
  per_item_ceiling: z.number().positive().nullable().optional(),
  position: z.number().int().nonnegative().optional(),
});
const UpdateTrackerSchema = z.object({
  per_item_ceiling: z.number().positive().nullable().optional(),
  position: z.number().int().nonnegative().optional(),
});

// GET /api/projects?status=active|archived
router.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const status = req.query.status as 'active' | 'archived' | undefined;
  const projects = listProjectsForUser(userId, status);
  res.json(projects);
});

// POST /api/projects
router.post('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const parsed = CreateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  const id = createProject({ user_id: userId, name: parsed.data.name, target_total: parsed.data.target_total });
  const project = getProjectById(id);
  res.status(201).json(project);
});

// GET /api/projects/:id (project + members + recent notifications)
router.get('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  const members = getBasketMembersForProject(id);
  const recent_notifications = getRecentProjectNotifications(id, 10);
  res.json({ project, members, recent_notifications });
});

// PATCH /api/projects/:id
router.patch('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  const parsed = UpdateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  updateProject(id, parsed.data);
  res.json(getProjectById(id));
});

// DELETE /api/projects/:id
router.delete('/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  deleteProject(id);
  res.status(204).send();
});

// POST /api/projects/:id/trackers
router.post('/:id/trackers', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });

  const parsed = AddTrackerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  // Cross-user guard: can only add own trackers
  const tracker = getTrackerById(parsed.data.tracker_id, userId);
  if (!tracker) return res.status(404).json({ error: 'tracker_not_found' });

  try {
    addProjectTracker({
      project_id: id,
      tracker_id: parsed.data.tracker_id,
      per_item_ceiling: parsed.data.per_item_ceiling ?? null,
      position: parsed.data.position ?? 0,
    });
  } catch (err) {
    // Likely a PK violation (duplicate membership)
    return res.status(409).json({ error: 'already_member' });
  }
  res.status(201).json(getBasketMembersForProject(id));
});

// DELETE /api/projects/:id/trackers/:trackerId
router.delete('/:id/trackers/:trackerId', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const trackerId = Number(req.params.trackerId);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  removeProjectTracker(id, trackerId);
  res.status(204).send();
});

// PATCH /api/projects/:id/trackers/:trackerId
router.patch('/:id/trackers/:trackerId', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const trackerId = Number(req.params.trackerId);
  const project = getProjectById(id, userId);
  if (!project) return res.status(404).json({ error: 'not_found' });
  const parsed = UpdateTrackerSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  updateProjectTracker(id, trackerId, parsed.data);
  res.json(getBasketMembersForProject(id));
});

export default router;
```

The route accesses `req.user` — populated by the existing `apiKeyMiddleware` + `authMiddleware` chain (same chain used by the existing `/api/trackers` and `/api/settings` routes). Mounting the route as `app.use('/api/projects', apiKeyMiddleware, authMiddleware, projectsRoutes)` in `index.ts` ensures the chain runs.

- [ ] **Step 2: Mount the route in `server/src/index.ts`**

Locate the existing route mounts (e.g., `app.use('/api/trackers', ...)`). Add:

```ts
import projectsRoutes from './routes/projects.js';
// ... alongside the other route imports

// ... below the trackers route mount:
app.use('/api/projects', apiKeyMiddleware, authMiddleware, projectsRoutes);
```

- [ ] **Step 3: Write the failing tests at `server/src/routes/projects.test.ts`**

Minimal supertest-style tests focused on the handlers' contract. Reuse the same DB-level pattern as existing route tests where possible — the existing project's auth middleware sets `req.user` from a JWT, so we'll use the existing helper:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import express from 'express';
import request from 'supertest';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import projectsRoutes from './projects.js';

// Simple test middleware that pretends a user is authenticated.
function makeApp(userId: number) {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', (req, _res, next) => {
    (req as { user?: { userId: number; role: string } }).user = { userId, role: 'user' };
    next();
  }, projectsRoutes);
  return app;
}

function seedUser(email = 't@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'T', 'user', 1)`
  ).run(email).lastInsertRowid);
}

function seedTracker(userId: number, name = 'X', lastPrice: number | null = 50): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 100, 'active', 60, 0, ?)`
  ).run(name, `https://example/${name}`, userId, lastPrice).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('projects routes', () => {
  it('GET / returns empty list for new user', async () => {
    const u = seedUser();
    const res = await request(makeApp(u)).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST / creates a project and returns 201 + body', async () => {
    const u = seedUser();
    const res = await request(makeApp(u))
      .post('/api/projects')
      .send({ name: 'NAS', target_total: 1200 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('NAS');
    expect(res.body.target_total).toBe(1200);
    expect(res.body.status).toBe('active');
  });

  it('POST / rejects missing name', async () => {
    const u = seedUser();
    const res = await request(makeApp(u))
      .post('/api/projects')
      .send({ target_total: 1200 });
    expect(res.status).toBe(400);
  });

  it('POST / rejects negative target_total', async () => {
    const u = seedUser();
    const res = await request(makeApp(u))
      .post('/api/projects')
      .send({ name: 'NAS', target_total: -5 });
    expect(res.status).toBe(400);
  });

  it('GET /:id returns 404 for other-user project (cross-user isolation)', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const create = await request(makeApp(u1))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const projectId = create.body.id;

    const res = await request(makeApp(u2)).get(`/api/projects/${projectId}`);
    expect(res.status).toBe(404);
  });

  it('GET /:id returns project + members + recent_notifications', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`)
      .send({ tracker_id: t });

    const res = await request(makeApp(u)).get(`/api/projects/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('P');
    expect(res.body.members).toHaveLength(1);
    expect(res.body.recent_notifications).toEqual([]);
  });

  it('PATCH /:id partial update (status only)', async () => {
    const u = seedUser();
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    const res = await request(makeApp(u))
      .patch(`/api/projects/${id}`)
      .send({ status: 'archived' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('archived');
    expect(res.body.name).toBe('P');               // unchanged
    expect(res.body.target_total).toBe(100);        // unchanged
  });

  it('DELETE /:id returns 204 and the project is gone', async () => {
    const u = seedUser();
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    const del = await request(makeApp(u)).delete(`/api/projects/${id}`);
    expect(del.status).toBe(204);
    const get = await request(makeApp(u)).get(`/api/projects/${id}`);
    expect(get.status).toBe(404);
  });

  it('POST /:id/trackers — duplicate add returns 409', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t });
    const dup = await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t });
    expect(dup.status).toBe(409);
  });

  it('POST /:id/trackers — cross-user tracker returns 404', async () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = seedTracker(u2);                      // tracker owned by u2
    const create = await request(makeApp(u1))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    const res = await request(makeApp(u1))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t });
    expect(res.status).toBe(404);                   // don't leak existence
  });

  it('POST /:id/trackers — stores per_item_ceiling', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    const res = await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`)
      .send({ tracker_id: t, per_item_ceiling: 30 });
    expect(res.status).toBe(201);
    expect(res.body[0].per_item_ceiling).toBe(30);
  });

  it('DELETE /:id/trackers/:trackerId removes the membership', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t });
    const del = await request(makeApp(u))
      .delete(`/api/projects/${id}/trackers/${t}`);
    expect(del.status).toBe(204);
    const get = await request(makeApp(u)).get(`/api/projects/${id}`);
    expect(get.body.members).toHaveLength(0);
  });

  it('PATCH /:id/trackers/:trackerId updates ceiling', async () => {
    const u = seedUser();
    const t = seedTracker(u);
    const create = await request(makeApp(u))
      .post('/api/projects').send({ name: 'P', target_total: 100 });
    const id = create.body.id;
    await request(makeApp(u))
      .post(`/api/projects/${id}/trackers`).send({ tracker_id: t, per_item_ceiling: 30 });
    const patch = await request(makeApp(u))
      .patch(`/api/projects/${id}/trackers/${t}`).send({ per_item_ceiling: 25 });
    expect(patch.status).toBe(200);
    expect(patch.body[0].per_item_ceiling).toBe(25);
  });
});
```

Note: the test imports `request` from `supertest`. If supertest is not yet a devDependency, install it:

```bash
cd /root/price-tracker/server && npm install --save-dev supertest @types/supertest
```

(Check whether existing route tests use supertest already. If yes, skip the install.)

- [ ] **Step 4: Run — expect PASS**

```bash
cd /root/price-tracker/server && npm test -- routes/projects.test
```

Expected: 13 tests pass.

- [ ] **Step 5: Run full server suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 439/439 (was 426; +13).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/projects.ts server/src/routes/projects.test.ts server/src/index.ts server/package.json server/package-lock.json
git commit -m "$(cat <<'EOF'
feat(projects): REST routes for projects + member CRUD

8 endpoints: list/get/create/update/delete project, add/remove/update
membership. zod validation on bodies. Cross-user isolation: cannot
read or modify another user's project; adding another user's tracker
returns 404 (don't leak existence). Duplicate membership PK violation
surfaces as 409.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Client-side types

**Files:**
- Modify: `client/src/types.ts`
- Create: `client/src/api/projects.ts`

- [ ] **Step 1: Add types at the bottom of `client/src/types.ts`**

```ts
// === Bundle Tracker (server migration v9) ===

export type IneligibleReason =
  | 'no_items'
  | 'item_missing_price'
  | 'item_errored'
  | 'over_target';

export interface Project {
  id: number;
  user_id: number;
  name: string;
  target_total: number;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface BasketMember {
  tracker_id: number;
  tracker_name: string;
  last_price: number | null;
  tracker_status: 'active' | 'paused' | 'error';
  per_item_ceiling: number | null;
  position: number;
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
}

export interface ProjectNotificationRecord {
  id: number;
  project_id: number;
  channel: string;
  basket_total: number;
  target_total: number;
  ai_commentary: string | null;
  sent_at: string;
}

export interface ProjectDetail {
  project: Project;
  members: BasketMember[];
  recent_notifications: ProjectNotificationRecord[];
}

/** Composite project verdict (deterministic, client-side derivation). */
export type CompositeVerdictTier = 'BUY' | 'WAIT' | 'HOLD';
```

- [ ] **Step 2: Create `client/src/api/projects.ts`**

```ts
// client/src/api/projects.ts
import type { Project, ProjectDetail, BasketMember } from '../types';

// Reuse the existing fetch wrapper (with auth headers) from elsewhere in the
// client. If your project uses a typed `apiFetch(url, opts)`, swap the raw
// fetch calls below for it.

async function authFetch(input: string, init?: RequestInit): Promise<Response> {
  const resp = await fetch(input, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  return resp;
}

export async function listProjects(status?: 'active' | 'archived'): Promise<Project[]> {
  const url = status ? `/api/projects?status=${status}` : '/api/projects';
  const resp = await authFetch(url);
  if (!resp.ok) throw new Error(`listProjects: ${resp.status}`);
  return resp.json();
}

export async function createProject(args: { name: string; target_total: number }): Promise<Project> {
  const resp = await authFetch('/api/projects', { method: 'POST', body: JSON.stringify(args) });
  if (!resp.ok) throw new Error(`createProject: ${resp.status}`);
  return resp.json();
}

export async function getProject(id: number): Promise<ProjectDetail> {
  const resp = await authFetch(`/api/projects/${id}`);
  if (!resp.ok) throw new Error(`getProject: ${resp.status}`);
  return resp.json();
}

export async function updateProject(
  id: number,
  args: { name?: string; target_total?: number; status?: 'active' | 'archived' },
): Promise<Project> {
  const resp = await authFetch(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(args) });
  if (!resp.ok) throw new Error(`updateProject: ${resp.status}`);
  return resp.json();
}

export async function deleteProject(id: number): Promise<void> {
  const resp = await authFetch(`/api/projects/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error(`deleteProject: ${resp.status}`);
}

export async function addProjectTracker(
  projectId: number,
  args: { tracker_id: number; per_item_ceiling?: number | null; position?: number },
): Promise<BasketMember[]> {
  const resp = await authFetch(`/api/projects/${projectId}/trackers`, { method: 'POST', body: JSON.stringify(args) });
  if (!resp.ok) {
    if (resp.status === 409) throw new Error('already_member');
    throw new Error(`addProjectTracker: ${resp.status}`);
  }
  return resp.json();
}

export async function removeProjectTracker(projectId: number, trackerId: number): Promise<void> {
  const resp = await authFetch(`/api/projects/${projectId}/trackers/${trackerId}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error(`removeProjectTracker: ${resp.status}`);
}

export async function updateProjectTracker(
  projectId: number,
  trackerId: number,
  args: { per_item_ceiling?: number | null; position?: number },
): Promise<BasketMember[]> {
  const resp = await authFetch(`/api/projects/${projectId}/trackers/${trackerId}`, { method: 'PATCH', body: JSON.stringify(args) });
  if (!resp.ok) throw new Error(`updateProjectTracker: ${resp.status}`);
  return resp.json();
}
```

⚠️ Note: the `authFetch` shown above is a minimal placeholder. The client codebase likely has an existing fetch wrapper that handles auth headers/cookies (look for it via `grep -rn "fetch.*api" client/src/`). Replace the placeholder with the real one.

- [ ] **Step 3: Verify the client builds clean**

```bash
cd /root/price-tracker/client && npm run build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/types.ts client/src/api/projects.ts
git commit -m "$(cat <<'EOF'
feat(projects): client types + API wrappers

Types mirror the server-side shapes (snake_case, matching the
existing convention). API wrappers cover the 8 endpoints. Composite
project verdict is computed client-side from member verdicts +
basket eligibility — no server endpoint needed.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Frontend — Projects list page

**Files:**
- Create: `client/src/pages/Projects.tsx`
- Create: `client/src/components/ProjectListCard.tsx`
- Modify: `client/src/App.tsx` (or routing config) — add `/projects` route + nav link

- [ ] **Step 1: Create `client/src/components/ProjectListCard.tsx`**

```tsx
import { Link } from 'react-router-dom';
import type { Project, BasketMember, CompositeVerdictTier } from '../types';
import { VerdictPill } from './VerdictPill';

interface Props {
  project: Project;
  members: BasketMember[];
  lastAlertAt: string | null;
}

function deriveBasketTotal(members: BasketMember[]): number | null {
  if (members.length === 0) return null;
  if (members.some(m => m.last_price === null)) return null;
  return members.reduce((sum, m) => sum + (m.last_price as number), 0);
}

function deriveCompositeVerdict(project: Project, members: BasketMember[]): CompositeVerdictTier {
  const total = deriveBasketTotal(members);
  if (total === null || total > project.target_total) return 'HOLD';
  if (members.some(m => m.ai_verdict_tier === 'WAIT')) return 'WAIT';
  return 'BUY';
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso + 'Z').getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function ProjectListCard({ project, members, lastAlertAt }: Props) {
  const total = deriveBasketTotal(members);
  const verdict = deriveCompositeVerdict(project, members);
  const pct = total !== null ? Math.min(100, Math.round((total / project.target_total) * 100)) : 0;

  return (
    <Link
      to={`/projects/${project.id}`}
      className="block rounded-lg border border-border bg-surface p-4 hover:border-primary transition-colors"
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-text">{project.name}</h3>
        <VerdictPill tier={verdict} reason={null} size="sm" />
      </div>
      <div className="text-sm text-text-muted mb-2">
        {members.length} {members.length === 1 ? 'item' : 'items'} ·{' '}
        {total !== null ? `$${total.toFixed(2)}` : '—'} / ${project.target_total.toFixed(2)} target
      </div>
      <div className="w-full h-2 bg-bg rounded overflow-hidden mb-2">
        <div
          className={`h-full transition-all ${verdict === 'BUY' ? 'bg-success' : verdict === 'WAIT' ? 'bg-warning' : 'bg-text-muted'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-text-muted">
        {lastAlertAt ? `Last alert: ${formatRelative(lastAlertAt)}` : 'No alerts yet'}
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Create `client/src/pages/Projects.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project, ProjectDetail } from '../types';
import { listProjects, getProject, createProject } from '../api/projects';
import { ProjectListCard } from '../components/ProjectListCard';

type StatusFilter = 'active' | 'archived';

export default function ProjectsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [projects, setProjects] = useState<Project[]>([]);
  const [details, setDetails] = useState<Map<number, ProjectDetail>>(new Map());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listProjects(statusFilter);
        if (cancelled) return;
        setProjects(list);

        // Fetch details for each project to render members + last alert.
        // For small N this is fine — 3-5 projects per user typical.
        const detailEntries = await Promise.all(list.map(p => getProject(p.id).then(d => [p.id, d] as const)));
        if (cancelled) return;
        setDetails(new Map(detailEntries));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [statusFilter]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const target = Number(newTarget);
      if (!newName.trim() || !Number.isFinite(target) || target <= 0) {
        setError('Name and positive target required');
        return;
      }
      const project = await createProject({ name: newName.trim(), target_total: target });
      setProjects(prev => [project, ...prev]);
      setNewName('');
      setNewTarget('');
      setCreating(false);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Projects</h1>
        <button
          onClick={() => setCreating(c => !c)}
          className="px-3 py-1.5 rounded bg-primary text-white text-sm font-medium hover:opacity-90"
        >
          {creating ? 'Cancel' : '+ New Project'}
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        {(['active', 'archived'] as const).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded text-sm ${statusFilter === s ? 'bg-primary text-white' : 'bg-surface border border-border'}`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {creating && (
        <form onSubmit={handleCreate} className="bg-surface border border-border rounded-lg p-4 mb-4 space-y-3">
          <input
            autoFocus
            placeholder="Project name (e.g., NAS Build)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            className="w-full bg-bg border border-border rounded px-3 py-2"
          />
          <input
            type="number" step="0.01" min="0.01"
            placeholder="Target total ($)"
            value={newTarget}
            onChange={e => setNewTarget(e.target.value)}
            className="w-full bg-bg border border-border rounded px-3 py-2"
          />
          <button type="submit" className="px-4 py-2 rounded bg-primary text-white font-medium">Create</button>
        </form>
      )}

      {error && <div className="text-error text-sm mb-4">{error}</div>}

      {projects.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          No {statusFilter} projects.{' '}
          <Link to="/" className="text-primary underline">Browse trackers</Link> to add to a project.
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map(p => {
            const detail = details.get(p.id);
            const lastAlert = detail?.recent_notifications[0]?.sent_at ?? null;
            return (
              <ProjectListCard
                key={p.id}
                project={p}
                members={detail?.members ?? []}
                lastAlertAt={lastAlert}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the route + nav link**

Locate the React Router config in `client/src/App.tsx` (or wherever routes are defined). Add a new route:

```tsx
import ProjectsPage from './pages/Projects';
import ProjectDetailPage from './pages/ProjectDetail'; // will exist after Task 12

// inside the <Routes>:
<Route path="/projects" element={<ProjectsPage />} />
<Route path="/projects/:id" element={<ProjectDetailPage />} />
```

In the nav (top bar / sidebar — locate the existing nav with Dashboard, Settings, etc.):

```tsx
<NavLink to="/projects">Projects</NavLink>
```

Match whatever component / styling pattern the existing nav uses.

- [ ] **Step 4: Verify the build**

```bash
cd /root/price-tracker/client && npm run build
```

Expected: clean. (The `ProjectDetail` page doesn't exist yet — temporarily comment out the `/projects/:id` route OR create a stub `client/src/pages/ProjectDetail.tsx` that just exports a placeholder. Recommended: stub.)

```tsx
// client/src/pages/ProjectDetail.tsx (stub — will be filled in Task 12)
export default function ProjectDetailPage() {
  return <div>Project detail (Task 12)</div>;
}
```

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/Projects.tsx client/src/components/ProjectListCard.tsx client/src/pages/ProjectDetail.tsx client/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(projects): list page + composite verdict pill on cards

/projects route. Active/Archived filter. Inline create form. List
cards show name, composite verdict (computed client-side from
member verdicts + eligibility), item count, current/target total,
progress bar, and last-alert relative timestamp.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Frontend — ProjectDetail + components

**Files:**
- Modify: `client/src/pages/ProjectDetail.tsx` (replace the stub)
- Create: `client/src/components/BasketTotalCard.tsx`
- Create: `client/src/components/BasketMembersTable.tsx`
- Create: `client/src/components/AddTrackerModal.tsx`
- Create: `client/src/components/RecentAlertsSection.tsx`

- [ ] **Step 1: Create `BasketTotalCard.tsx`**

```tsx
import type { Project, BasketMember, CompositeVerdictTier } from '../types';
import { VerdictPill } from './VerdictPill';

interface Props {
  project: Project;
  members: BasketMember[];
}

function deriveBasketTotal(members: BasketMember[]): number | null {
  if (members.length === 0) return null;
  if (members.some(m => m.last_price === null)) return null;
  return members.reduce((sum, m) => sum + (m.last_price as number), 0);
}

function deriveCompositeVerdict(project: Project, members: BasketMember[]): CompositeVerdictTier {
  const total = deriveBasketTotal(members);
  if (total === null || total > project.target_total) return 'HOLD';
  if (members.some(m => m.ai_verdict_tier === 'WAIT')) return 'WAIT';
  return 'BUY';
}

export function BasketTotalCard({ project, members }: Props) {
  const total = deriveBasketTotal(members);
  const verdict = deriveCompositeVerdict(project, members);
  const gap = total !== null ? total - project.target_total : null;
  const pct = total !== null ? Math.min(100, Math.round((total / project.target_total) * 100)) : 0;

  return (
    <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <VerdictPill tier={verdict} reason={null} size="md" />
        <div className="text-2xl font-bold">
          {total !== null ? `$${total.toFixed(2)}` : '—'}{' '}
          <span className="text-base font-normal text-text-muted">
            / ${project.target_total.toFixed(2)}
          </span>
        </div>
        {gap !== null && (
          <div className={`text-sm font-medium ${gap > 0 ? 'text-warning' : 'text-success'}`}>
            {gap > 0 ? `▲ $${gap.toFixed(2)} over target` : `▼ $${Math.abs(gap).toFixed(2)} under target`}
          </div>
        )}
      </div>
      <div className="w-full h-2 bg-bg rounded overflow-hidden">
        <div
          className={`h-full transition-all ${verdict === 'BUY' ? 'bg-success' : verdict === 'WAIT' ? 'bg-warning' : 'bg-text-muted'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-text-muted mt-1">{pct}%</div>
    </div>
  );
}
```

- [ ] **Step 2: Create `BasketMembersTable.tsx`**

```tsx
import { useState } from 'react';
import type { BasketMember } from '../types';
import { VerdictPill } from './VerdictPill';
import { updateProjectTracker, removeProjectTracker } from '../api/projects';

interface Props {
  projectId: number;
  members: BasketMember[];
  onChange: () => void;
}

export function BasketMembersTable({ projectId, members, onChange }: Props) {
  const [editingCeiling, setEditingCeiling] = useState<number | null>(null);
  const [ceilingInput, setCeilingInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function saveCeiling(trackerId: number) {
    setError(null);
    try {
      const value = ceilingInput.trim() === '' ? null : Number(ceilingInput);
      if (value !== null && (!Number.isFinite(value) || value <= 0)) {
        setError('Ceiling must be a positive number');
        return;
      }
      await updateProjectTracker(projectId, trackerId, { per_item_ceiling: value });
      setEditingCeiling(null);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRemove(trackerId: number) {
    if (!confirm('Remove this tracker from the project?')) return;
    try {
      await removeProjectTracker(projectId, trackerId);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  }

  if (members.length === 0) {
    return <div className="text-text-muted text-sm py-4">No items yet. Click "Add Tracker" to start.</div>;
  }

  return (
    <div>
      {error && <div className="text-error text-sm mb-2">{error}</div>}
      <ul className="divide-y divide-border">
        {members.map(m => (
          <li key={m.tracker_id} className="py-3 flex flex-wrap items-center gap-3">
            <a
              href={`/trackers/${m.tracker_id}`}
              className="font-medium text-text hover:text-primary flex-1 min-w-0 truncate"
            >
              {m.tracker_name}
            </a>
            <span className="text-text font-semibold tabular-nums">
              {m.last_price !== null ? `$${m.last_price.toFixed(2)}` : '—'}
            </span>
            <VerdictPill tier={m.ai_verdict_tier} reason={m.ai_verdict_reason} size="sm" />
            {editingCeiling === m.tracker_id ? (
              <input
                autoFocus
                type="number"
                step="0.01"
                value={ceilingInput}
                onChange={e => setCeilingInput(e.target.value)}
                onBlur={() => saveCeiling(m.tracker_id)}
                onKeyDown={e => { if (e.key === 'Enter') saveCeiling(m.tracker_id); }}
                className="w-24 bg-bg border border-border rounded px-2 py-1 text-sm"
                placeholder="ceiling"
              />
            ) : (
              <button
                onClick={() => {
                  setEditingCeiling(m.tracker_id);
                  setCeilingInput(m.per_item_ceiling !== null ? String(m.per_item_ceiling) : '');
                }}
                className="text-xs px-2 py-0.5 rounded border border-border text-text-muted hover:border-primary"
              >
                {m.per_item_ceiling !== null ? `ceiling $${m.per_item_ceiling.toFixed(2)}` : '+ ceiling'}
              </button>
            )}
            <button
              onClick={() => handleRemove(m.tracker_id)}
              className="text-text-muted hover:text-error text-sm"
              title="Remove from project"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Create `AddTrackerModal.tsx`**

```tsx
import { useEffect, useState } from 'react';
import type { Tracker } from '../types';
import { addProjectTracker } from '../api/projects';

interface Props {
  projectId: number;
  excludeIds: Set<number>;
  onClose: () => void;
  onAdded: () => void;
}

export function AddTrackerModal({ projectId, excludeIds, onClose, onAdded }: Props) {
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [ceilingInput, setCeilingInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch('/api/trackers', { credentials: 'include' });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const all = await resp.json() as Tracker[];
        setTrackers(all.filter(t => !excludeIds.has(t.id)));
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [excludeIds]);

  const filtered = trackers.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );

  async function handleAdd() {
    if (selectedId === null) return;
    setError(null);
    try {
      const ceiling = ceilingInput.trim() === '' ? null : Number(ceilingInput);
      if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling <= 0)) {
        setError('Ceiling must be a positive number');
        return;
      }
      await addProjectTracker(projectId, { tracker_id: selectedId, per_item_ceiling: ceiling });
      onAdded();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg p-4 w-full max-w-md max-h-[80vh] overflow-y-auto">
        <h3 className="font-bold mb-3">Add tracker to project</h3>
        <input
          autoFocus
          placeholder="Search trackers..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-bg border border-border rounded px-3 py-2 mb-3"
        />
        <div className="max-h-64 overflow-y-auto border border-border rounded mb-3">
          {filtered.length === 0 ? (
            <div className="p-3 text-text-muted text-sm">No trackers match.</div>
          ) : (
            filtered.map(t => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left p-2 hover:bg-bg ${selectedId === t.id ? 'bg-bg ring-1 ring-primary' : ''}`}
              >
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-text-muted">
                  {t.last_price !== null ? `$${t.last_price.toFixed(2)}` : '—'}
                </div>
              </button>
            ))
          )}
        </div>
        <input
          type="number" step="0.01" min="0.01"
          placeholder="Per-item ceiling (optional)"
          value={ceilingInput}
          onChange={e => setCeilingInput(e.target.value)}
          className="w-full bg-bg border border-border rounded px-3 py-2 mb-3"
        />
        {error && <div className="text-error text-sm mb-2">{error}</div>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 rounded border border-border">Cancel</button>
          <button
            onClick={handleAdd}
            disabled={selectedId === null}
            className="px-3 py-1.5 rounded bg-primary text-white font-medium disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `RecentAlertsSection.tsx`**

```tsx
import type { ProjectNotificationRecord } from '../types';

interface Props {
  notifications: ProjectNotificationRecord[];
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso + 'Z').getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

const CHANNEL_LABELS: Record<string, string> = {
  discord: 'Discord',
  ntfy: 'ntfy',
  email: 'Email',
  webhook: 'Webhook',
};

export function RecentAlertsSection({ notifications }: Props) {
  if (notifications.length === 0) {
    return <div className="text-text-muted text-sm py-2">No alerts yet.</div>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {notifications.map(n => (
        <li key={n.id} className="flex flex-wrap gap-2 text-text-muted">
          <span>•</span>
          <span>{formatRelative(n.sent_at)}</span>
          <span className="text-text">{CHANNEL_LABELS[n.channel] ?? n.channel}</span>
          <span>${n.basket_total.toFixed(2)} → fired</span>
          {n.ai_commentary && <span className="italic">"{n.ai_commentary}"</span>}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 5: Replace the stub `client/src/pages/ProjectDetail.tsx`**

```tsx
import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { ProjectDetail } from '../types';
import { getProject, updateProject, deleteProject } from '../api/projects';
import { BasketTotalCard } from '../components/BasketTotalCard';
import { BasketMembersTable } from '../components/BasketMembersTable';
import { AddTrackerModal } from '../components/AddTrackerModal';
import { RecentAlertsSection } from '../components/RecentAlertsSection';

export default function ProjectDetailPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const id = Number(idParam);
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [targetInput, setTargetInput] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const reload = useCallback(async () => {
    try {
      const d = await getProject(id);
      setData(d);
      setNameInput(d.project.name);
      setTargetInput(String(d.project.target_total));
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  async function saveName() {
    if (!data) return;
    setEditingName(false);
    if (nameInput.trim() === data.project.name) return;
    try {
      await updateProject(id, { name: nameInput.trim() });
      reload();
    } catch (e) { setError(String(e)); }
  }

  async function saveTarget() {
    if (!data) return;
    setEditingTarget(false);
    const t = Number(targetInput);
    if (!Number.isFinite(t) || t <= 0 || t === data.project.target_total) return;
    try {
      await updateProject(id, { target_total: t });
      reload();
    } catch (e) { setError(String(e)); }
  }

  async function toggleArchive() {
    if (!data) return;
    const next = data.project.status === 'active' ? 'archived' : 'active';
    try {
      await updateProject(id, { status: next });
      reload();
    } catch (e) { setError(String(e)); }
  }

  async function handleDelete() {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    try {
      await deleteProject(id);
      navigate('/projects');
    } catch (e) { setError(String(e)); }
  }

  if (error) return <div className="p-4 text-error">{error}</div>;
  if (!data) return <div className="p-4 text-text-muted">Loading…</div>;

  const memberIds = new Set(data.members.map(m => m.tracker_id));

  return (
    <div className="max-w-4xl mx-auto p-4">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-text-muted hover:text-text text-sm mb-4">
        <ArrowLeft className="w-4 h-4" /> Projects
      </Link>

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            {editingName ? (
              <input
                autoFocus
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onBlur={saveName}
                onKeyDown={e => { if (e.key === 'Enter') saveName(); }}
                className="bg-bg border border-border rounded px-3 py-1.5 text-xl font-bold w-full"
              />
            ) : (
              <h1 className="text-xl sm:text-2xl font-bold cursor-pointer" onClick={() => setEditingName(true)}>
                {data.project.name}
              </h1>
            )}
            <div className="text-sm text-text-muted mt-1">
              Target:{' '}
              {editingTarget ? (
                <input
                  autoFocus
                  type="number" step="0.01" min="0.01"
                  value={targetInput}
                  onChange={e => setTargetInput(e.target.value)}
                  onBlur={saveTarget}
                  onKeyDown={e => { if (e.key === 'Enter') saveTarget(); }}
                  className="bg-bg border border-border rounded px-2 py-0.5 text-sm w-24"
                />
              ) : (
                <span className="cursor-pointer" onClick={() => setEditingTarget(true)}>
                  ${data.project.target_total.toFixed(2)}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={toggleArchive} className="px-2 py-1 text-sm border border-border rounded">
              {data.project.status === 'active' ? 'Archive' : 'Unarchive'}
            </button>
            <button onClick={handleDelete} className="px-2 py-1 text-sm border border-border text-error rounded">
              Delete
            </button>
          </div>
        </div>
      </div>

      <BasketTotalCard project={data.project} members={data.members} />

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Items ({data.members.length})</h2>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-3 py-1.5 rounded bg-primary text-white text-sm font-medium"
          >
            + Add Tracker
          </button>
        </div>
        <BasketMembersTable projectId={id} members={data.members} onChange={reload} />
      </div>

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6">
        <h2 className="font-semibold mb-3">Recent alerts</h2>
        <RecentAlertsSection notifications={data.recent_notifications} />
      </div>

      {showAddModal && (
        <AddTrackerModal
          projectId={id}
          excludeIds={memberIds}
          onClose={() => setShowAddModal(false)}
          onAdded={reload}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Verify the build**

```bash
cd /root/price-tracker/client && npm run build
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/ProjectDetail.tsx client/src/components/BasketTotalCard.tsx client/src/components/BasketMembersTable.tsx client/src/components/AddTrackerModal.tsx client/src/components/RecentAlertsSection.tsx
git commit -m "$(cat <<'EOF'
feat(projects): ProjectDetail page with basket card, members table, modals

BasketTotalCard renders the composite verdict pill, current/target,
gap indicator, progress bar. BasketMembersTable lists each tracker
with VerdictPill, inline-editable per-item ceiling, remove button.
AddTrackerModal is a searchable picker filtered to user's own
trackers not already in the project. RecentAlertsSection shows
the last 10 project_notifications. Inline-edit name + target_total
in the header. Archive/Unarchive + Delete buttons.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Final pre-deploy checklist + PR

- [ ] **Step 1: Run the full server test suite**

```bash
cd /root/price-tracker/server && npm test
```

Expected: 439/439 pass (was 364 + 75 new across migration v9, basket, queries, channel renderers, prompt builder, firer, cron-projects, routes).

- [ ] **Step 2: Run the full client test suite**

```bash
cd /root/price-tracker/client && npm test
```

Expected: existing client tests still pass. (No new client tests were added — visual components are best validated by manual exercise.)

- [ ] **Step 3: Build server + client clean**

```bash
cd /root/price-tracker/server && npm run build
cd /root/price-tracker/client && npm run build
```

Expected: zero TS errors, zero warnings.

- [ ] **Step 4: Manual sanity check**

- Inspect `tasks/todo.md` — does the Bundle Tracker entry still reference the spec?
- Inspect `docs/superpowers/specs/2026-05-05-bundle-tracker-design.md` — unchanged on the branch?
- Spot-check that no new files accidentally landed elsewhere.

- [ ] **Step 5: Manual UI walkthrough (after deploying or running locally)**

Start the server + client locally:

```bash
cd /root/price-tracker/server && npm run dev    # in one terminal
cd /root/price-tracker/client && npm run dev    # in another
```

Navigate the UI:

1. Open the Projects nav link → see empty state
2. Click "+ New Project" → enter "Test Bundle" + target $50 → create
3. Open the project → see the empty state ("No items yet")
4. Click "+ Add Tracker" → search for one of your trackers → set ceiling → add
5. Confirm the BasketTotalCard updates with the price + composite verdict
6. Set the project's target_total slightly below the current basket → confirm verdict flips to HOLD
7. Set the target_total slightly above → confirm verdict flips to BUY
8. Archive the project → verify it disappears from the Active filter and appears under Archived
9. Unarchive → verify it returns
10. Delete → confirm it's gone

- [ ] **Step 6: Push the branch and open a PR**

```bash
git push -u origin feature/bundle-tracker
```

```bash
gh pr create --title "feat(projects): Bundle Tracker — multi-tracker baskets with combined target" --body "$(cat <<'EOF'
## Summary

Implements the Bundle Tracker per \`docs/superpowers/specs/2026-05-05-bundle-tracker-design.md\`. Second of three "next big bets". Layers a project (basket) abstraction on top of trackers: create a named project with a target total budget, add N existing trackers, get a "bundle ready" alert when sum(last_price) at-or-below target with all items available.

Highlights:
- M:N membership via \`project_trackers\` join (a tracker can be in multiple projects)
- Event-driven fire-and-forget on tracker scrape — same architectural rhythm as the AI Buyer's Assistant verdict regen
- Per-channel cooldown reuses the existing \`\${channel}_cooldown_hours\` user settings, scoped via a new \`project_notifications\` table
- All 4 channels (Discord/ntfy/email/webhook) gain \`sendXxxBasketAlert\` wrapping the same transports
- AI commentary on basket alerts via \`Promise.race(3000ms)\` — same fallback pattern as per-tracker alert copy
- Composite project verdict (BUY/WAIT/HOLD) computed deterministically client-side from member verdicts + basket eligibility — no Claude calls for this
- New \`/projects\` and \`/projects/:id\` routes with full CRUD + member management

Migration v9 adds three new tables; no backfill needed. No feature flag (no external API dependency at the basket layer).

## Test plan
- [ ] Server tests pass: \`cd server && npm test\` → 439/439
- [ ] Client tests pass: \`cd client && npm test\`
- [ ] Both builds clean: \`npm run build\` in each
- [ ] Manual walkthrough (see plan Task 13 Step 5)
- [ ] After deploy: create one real project, add 2-3 trackers, confirm alert fires when target dips below current basket

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review

### Spec coverage

| Spec section | Covered by |
|---|---|
| Use case (all-or-nothing build) | Tasks 6, 7, 8 (alert path) |
| M:N data model | Tasks 1, 4 |
| Total + availability gating | Task 3 (evaluateBasket) |
| Event-driven on scrape | Task 8 |
| Per-channel cooldown reuse | Task 7 (firer) |
| `/projects` + detail UI | Tasks 11, 12 |
| Composite project verdict (deterministic) | Tasks 11 (`deriveCompositeVerdict`), 12 (BasketTotalCard) |
| Per-item verdicts displayed inline | Task 12 (BasketMembersTable + VerdictPill reuse) |
| AI commentary opt-in | Tasks 6, 7 |
| Migration v9 schema | Task 1 |
| Channel basket renderers (×4) | Task 5 |
| API routes + auth + cross-user isolation | Task 9 |
| Project lifecycle (active/archived) | Tasks 4, 9, 12 |
| Per-item ceiling stored + edited | Tasks 4, 12 |
| `project_notifications` table + recent alerts UI | Tasks 1, 4, 12 |
| Out-of-scope items (drag-and-drop, history chart, etc.) | explicitly NOT implemented |

All spec sections accounted for.

### Known assumptions to verify during implementation

- `getTrackerById(id, userId)` exists with the expected signature — confirmed during the AI Buyer's Assistant work.
- The existing `apiKeyMiddleware` + `authMiddleware` chain is the right one to mount under `/api/projects` (matches `/api/trackers`, `/api/settings`).
- The client routing is React Router v6 — confirm by inspecting `client/src/App.tsx` for `<Routes>` / `<Route>` JSX.
- `lucide-react` is already a client dependency (used by other pages for the `ArrowLeft` icon).
- `supertest` may not be in devDependencies. Task 9 Step 3 includes the install command if needed.

These are codebase-shape questions, not design questions. Implementer resolves them by reading neighboring code at task time.
