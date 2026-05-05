# Bundle Tracker Design

**Date:** 2026-05-05
**Status:** Approved
**Author:** Andrew Schultz + Claude

## Overview

Price Tracker today tracks individual products. The Bundle Tracker layers a **project** abstraction on top: a user creates a named project (e.g. "NAS Build"), assigns a target total budget, and adds N existing trackers to it. The headline alert fires when the **basket total** (sum of last_price across all members) drops at or below the target — even if no individual item's threshold was crossed. This is the canonical "I'd buy all 8 components together when the bundle math works" use case that no other price-tracking tool does well.

Projects are an **additive view** on top of trackers, not a replacement. A tracker's main-dashboard appearance is unchanged whether or not it's in any project. The same tracker can belong to multiple projects (M:N membership). Existing per-tracker alerts continue to fire independently of basket alerts.

The defining design principles:

- **Event-driven on tracker scrape.** Every successful scrape fires-and-forgets project re-evaluation for the projects this tracker belongs to. Same architectural rhythm as the AI Buyer's Assistant verdict regeneration. No new cron infrastructure.
- **Total + availability gating.** Basket alert fires when (a) sum(last_price) ≤ target_total AND (b) every member has a current valid price (no errors, no missing prices). Per-item ceilings are informational only — they're surfaced in the UI and to the AI advisor, but they don't gate the alert.
- **Reuse existing channel + cooldown infrastructure.** The four channel senders (discord/ntfy/email/webhook) gain new `sendXxxBasketAlert` functions wrapping the same transports. Per-channel cooldowns reuse the same `${channel}_cooldown_hours` user settings, scoped to a separate `project_notifications` table.

## Decisions

- **Use case in v1.** All-or-nothing build (NAS, PC, home gym, gift basket): the headline alert is "basket total ≤ target". Other patterns (gift list as organization, stock-up with running totals) work today via per-tracker alerts and don't need basket math.
- **Data model.** M:N membership via a `project_trackers` join table. A tracker can belong to multiple projects. Existing trackers integrate naturally — no migration on the trackers table.
- **Alert gate.** Total + availability (no per-item ceiling enforcement at the alert path). Per-item ceilings are stored on the join row and surfaced to the UI and the AI advisor.
- **Architecture.** Inline async fire-and-forget on the scrape pipeline. The same pattern we just established for the AI verdict regeneration. No new cron, no job queue.
- **UI.** Dedicated `/projects` route. List view with progress indicators; detail view with member table, basket total card, recent alerts. Trackers remain on the main dashboard regardless of project membership.
- **AI integration.** Three layers, all reuse the AI Buyer's Assistant:
  1. Per-item verdict pills (already populated by the AI feature) rendered in the project detail's member table.
  2. Composite project verdict computed deterministically client-side from member verdicts + basket eligibility.
  3. Optional AI commentary on basket alerts via `Promise.race(3000ms)` — same fallback pattern as per-tracker alert copy.
- **No new feature flag.** Unlike the AI feature (which needed `AI_ENABLED` because Claude calls cost real money), the bundle tracker is deterministic with no external API dependency. Rollback is `git revert` + redeploy.
- **Project lifecycle.** `status: 'active' | 'archived'`. Active projects fire alerts; archived projects are read-only / for reference. No auto-archive on first fired alert (deferred to v2).
- **Per-channel cooldown reuse.** Project alerts use the same `${channel}_cooldown_hours` user settings as per-tracker alerts, scoped to per-(project, channel) via the new `project_notifications` table. No new config keys.

## Architecture

### New module map

| Path | Purpose | Talks to network? |
|---|---|---|
| `server/src/projects/basket.ts` | Pure: `evaluateBasket(project, members) → BasketState`. Computes total, availability, eligibility. Zero IO. | no |
| `server/src/projects/firer.ts` | Orchestrator: `evaluateAndFireForProject(projectId)`. Loads project + members, evaluates basket, applies per-channel cooldown gate, dispatches to enabled channels. Only writer of `project_notifications`. | indirectly via channel senders |
| `server/src/projects/prompts.ts` | Optional: `buildBasketAlertCopyPrompt(...)` for AI commentary. Reuses the AI client established by the AI Buyer's Assistant. | no |
| `server/src/notifications/discord.ts` (+3) | Add `sendDiscordBasketAlert` (and ntfy/email/webhook equivalents) wrapping the same transports. | yes — same transports |
| `server/src/routes/projects.ts` | REST: list/create/get/update/delete + add/remove member + edit per-item ceiling. | no |
| `client/src/pages/Projects.tsx` | List view: progress bars, totals, status filter. | no |
| `client/src/pages/ProjectDetail.tsx` | Detail view: members table with verdict pills, basket total card, recent alerts. | no |
| `client/src/components/BasketTotalCard.tsx` | Composite verdict + total/target/progress. | no |
| `client/src/components/BasketMembersTable.tsx` | Per-member row with VerdictPill, ceiling pill, action menu. | no |
| `client/src/components/AddTrackerModal.tsx` | Searchable picker for adding existing trackers to a project. | no |

### Modified modules

- `server/src/db/migrations.ts` — append migration **v9**: `projects` + `project_trackers` + `project_notifications`. Idempotent guards.
- `server/src/db/queries.ts` — project read/write helpers; new types `Project`, `ProjectTracker`, `BasketMember`, `BasketState`.
- `server/src/scheduler/cron.ts` — after the existing AI verdict fire-and-forget in `checkTrackerUrl`, kick off project re-eval for every active project containing this tracker.
- `client/src/App.tsx` (or routing config) — add `/projects` and `/projects/:id` routes; add `Projects` nav link.
- `client/src/types.ts` — add `Project`, `BasketMember`, `BasketState`, composite verdict tier helper.

### Boundaries

- `basket.ts` is pure with zero IO — `evaluateBasket(project, members) → BasketState`. Hundreds of unit tests possible without ever touching the DB.
- `firer.ts` is the only place that fires basket alerts. The only writer of `project_notifications`. Single auditable mutation point.
- Channel senders for basket are isolated from per-tracker senders — no shared code path that could regress existing alert behavior.
- All project code lives under `server/src/projects/` and `client/src/pages/Projects*` + `client/src/components/Basket*`. Disabling the feature is `git revert` as a unit; deleting it is `rm -rf` two directories.

### Data flow on tracker scrape

```
tracker scrape succeeds (existing path, unchanged)
    ├─→ price stored in price_history
    ├─→ tracker_urls.last_price updated
    ├─→ refreshTrackerAggregates() — tracker.last_price now reflects latest
    ├─→ AI verdict regen (existing, fire-and-forget — from AI Buyer's Assistant)
    │
    └─→ NEW: getActiveProjectIdsForTracker(tracker.id)
            └─→ for each project membership (fire-and-forget):
                   ├─ load project + all members (single JOIN query)
                   ├─ evaluateBasket(project, members) → BasketState
                   ├─ if eligible:
                   │     ├─ check per-(project, channel) cooldown via project_notifications
                   │     ├─ if any channel passes its gate:
                   │     │     ├─ Promise.race(generateBasketAlertCopy, 3000ms)
                   │     │     │     [returns null if AI_ENABLED=false or Claude fails]
                   │     │     ├─ for each eligible channel:
                   │     │     │     └─ sendXxxBasketAlert(project, basketState, members, target, aiCommentary)
                   │     │     └─ insert project_notifications rows for fired channels
                   │     └─ else: log "all channels in cooldown"
                   └─ else: log structured info with ineligible_reason
```

## Data model

### Migration v9 — three new tables

```sql
-- projects: the basket itself
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  target_total REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_projects_user_id ON projects(user_id);
CREATE INDEX idx_projects_user_status ON projects(user_id, status);

-- project_trackers: M:N membership
CREATE TABLE project_trackers (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  per_item_ceiling REAL,                      -- nullable, informational only
  position INTEGER NOT NULL DEFAULT 0,        -- display order
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, tracker_id)
);
-- composite PK prevents duplicate membership
-- reverse index for "find projects containing this tracker" (called per-scrape)
CREATE INDEX idx_project_trackers_tracker_id ON project_trackers(tracker_id);

-- project_notifications: cooldown source-of-truth + history
CREATE TABLE project_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('discord', 'ntfy', 'webhook', 'email')),
  basket_total REAL NOT NULL,                 -- snapshot at fire time
  target_total REAL NOT NULL,                 -- snapshot of target at fire time
  ai_commentary TEXT,                         -- nullable
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_project_notifications_project_channel ON project_notifications(project_id, channel, sent_at DESC);
```

The composite PK on `project_trackers` prevents the same tracker from being added twice to one project. The `project_notifications` index lets the cooldown check (`SELECT most-recent WHERE project_id = ? AND channel = ? ORDER BY sent_at DESC LIMIT 1`) run as a lookup, not a scan.

### Types

```ts
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
  // surfaced for the project detail view (set by AI Buyer's Assistant)
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
}

export type IneligibleReason =
  | 'no_items'
  | 'item_missing_price'
  | 'item_errored'
  | 'over_target';

export interface BasketState {
  total: number | null;          // null when any member has no last_price
  target_total: number;
  item_count: number;
  items_with_price: number;
  items_below_ceiling: number;   // display only, doesn't gate alert
  eligible: boolean;
  ineligible_reason: IneligibleReason | null;
}
```

### Pure basket evaluation (`basket.ts`)

```
evaluateBasket(project, members) → BasketState

  if members.length === 0:
    return { eligible: false, ineligible_reason: 'no_items', total: null,
             item_count: 0, items_with_price: 0, items_below_ceiling: 0,
             target_total: project.target_total }

  if any member.tracker_status === 'error':
    return { eligible: false, ineligible_reason: 'item_errored',
             total: <partial sum of available members>,
             ...counts... }

  if any member.last_price === null:
    return { eligible: false, ineligible_reason: 'item_missing_price',
             total: null, ...counts... }

  total = sum(member.last_price)
  eligible = total <= project.target_total
  ineligible_reason = eligible ? null : 'over_target'
  return { total, eligible, ineligible_reason, ...counts... }
```

Pure function. No IO. Fully unit-testable.

## Alert mechanics

### Trigger

Inside `cron.ts:checkTrackerUrl`, after the existing AI verdict fire-and-forget hook:

```ts
// Existing: AI verdict regen (from AI Buyer's Assistant)
if (process.env.AI_ENABLED === 'true' && seller.last_price !== result.price) {
  void generateVerdictForTracker(tracker.id).catch(() => {});
}

// NEW: project re-eval for every active project containing this tracker.
// Independent of AI flag.
const projectIds = getActiveProjectIdsForTracker(tracker.id);
for (const projectId of projectIds) {
  void evaluateAndFireForProject(projectId).catch(() => {
    // firer logs internally — outer catch is just the fire-and-forget backstop
  });
}
```

### `evaluateAndFireForProject(projectId)`

1. Load `project` + `members` via a single JOIN query (joins `projects`, `project_trackers`, `trackers`).
2. `state = evaluateBasket(project, members)`.
3. If `!state.eligible`: log `info` with `ineligible_reason` + return.
4. Resolve `getEnabledChannels(project.user_id)` — reuses existing helper.
5. For each enabled channel, check per-(project, channel) cooldown:
   - `getLastProjectNotificationForChannel(project.id, channel)` — returns most-recent row.
   - If within `${channel}_cooldown_hours`, skip this channel.
6. If any channel passed its cooldown gate: optionally generate AI commentary via `Promise.race([generateBasketAlertCopy(...), 3000ms timeout])`. Falls back to `null` if AI is off or Claude is slow/fails.
7. For each eligible channel: `sendXxxBasketAlert(project, state, members, channelTarget, aiCommentary)`.
8. Insert `project_notifications` rows for each successful dispatch.

### Channel templates

Each channel renders its own variation, all accept the same optional `aiCommentary?: string | null`:

- **Discord:** embed titled `Bundle Ready: {project.name}`. Fields: total, target, savings, item count. Description block lists each member with current price.
- **ntfy:** title `Bundle Ready: {project.name}`. Body has the math + member list.
- **Email:** subject `Bundle ready: {project.name} hit ${total}`. HTML/plaintext bodies with member list.
- **Webhook:** JSON payload `{ event: 'bundle_ready', project: {...}, basket: {...}, members: [...], ai_commentary }`.

When `aiCommentary` is non-null, each renderer appends it (Discord: embed description; ntfy: body; email: both bodies; webhook: dedicated field). When null, the existing template is unchanged. This mirrors the per-tracker alert convention exactly.

## UI

### `/projects` (list view)

```
┌────────────────────────────────────────────────────────┐
│ Projects                              [+ New Project] │
│ [Active] [Archived]                                    │
├────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────┐  │
│ │ NAS Build                                  [WAIT]│  │
│ │ 8 items · $1,247 / $1,200 target                 │  │
│ │ ████████████████████████░  104%                  │  │
│ │ Last alert: 2 days ago                           │  │
│ └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

Cards show: name, composite verdict pill, item count, current total / target, progress bar, last-alert timestamp. Click → detail. `[Active]` / `[Archived]` filter pills toggle the list.

### `/projects/:id` (detail view)

```
┌────────────────────────────────────────────────────────┐
│ ← Projects                                             │
│                                                        │
│ NAS Build                            [Archive] [⋯]    │
│ Target: $1,200  (inline edit on click)                 │
├────────────────────────────────────────────────────────┤
│  [WAIT]   $1,247 / $1,200      ▲ $47 over target      │
│  ████████████████████████░  104%                       │
├────────────────────────────────────────────────────────┤
│ Items (8)                            [+ Add Tracker]  │
├────────────────────────────────────────────────────────┤
│ Samsung 990 Pro 4TB         $279.00  [BUY]   ceiling $280  ⋯│
│ ASRock Rack B650D4U3       $507.00  [WAIT]  ceiling $500  ⋯│
│ AMD EPYC 4005-4345P        $339.00  [BUY]                ⋯│
│ ...                                                    │
├────────────────────────────────────────────────────────┤
│ Recent alerts                                          │
│ • 2026-04-20 14:32  Discord  $1,189 → fired           │
│ • 2026-03-15 09:11  Discord  $1,195 → fired           │
└────────────────────────────────────────────────────────┘
```

**Components:**

- `BasketTotalCard.tsx` — composite verdict pill (large), current total, target, gap-to-target with up/down indicator, progress bar.
- `BasketMembersTable.tsx` — rows with tracker name, current price, `<VerdictPill>` (reuses the existing component from the AI Buyer's Assistant), per-item ceiling pill (shown only when set), per-row menu (edit ceiling / remove from project / open tracker).
- `AddTrackerModal.tsx` — searchable list of `req.user.id`'s trackers not currently in the project, per-item ceiling input, position defaults to "end".
- `RecentAlertsSection.tsx` — last 10 `project_notifications` rows for this project.

**Edit semantics:** name and target_total inline-edit in the detail page header. Per-item ceiling inline-edit on member row. Add tracker via modal; remove tracker via per-row menu. Archive/unarchive button on header.

### API routes (`server/src/routes/projects.ts`)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects?status=active\|archived` | List user's projects |
| `POST` | `/api/projects` | Create (`name`, `target_total`) |
| `GET` | `/api/projects/:id` | Detail (project + members + recent notifications) |
| `PATCH` | `/api/projects/:id` | Edit (`name`, `target_total`, `status`) |
| `DELETE` | `/api/projects/:id` | Delete (cascades to members + notifications via FK) |
| `POST` | `/api/projects/:id/trackers` | Add tracker (`tracker_id`, `per_item_ceiling`, optional `position`) |
| `DELETE` | `/api/projects/:id/trackers/:trackerId` | Remove tracker |
| `PATCH` | `/api/projects/:id/trackers/:trackerId` | Update `per_item_ceiling` or `position` |

All routes require auth (existing `authMiddleware`). All routes filter by `req.user.id` — a user cannot access or modify another user's project. The `POST /:id/trackers` route also validates that the `tracker_id` belongs to `req.user.id` (otherwise returns 404 — leaks no information about other users' trackers).

## AI integration

Three layers, all reuse the AI Buyer's Assistant infrastructure:

### 1. Per-item verdicts (already free)

The AI Buyer's Assistant populates `tracker.ai_verdict_tier` + `ai_verdict_reason` on every price change. The project detail page renders them in the members table via the existing `<VerdictPill>` component. Zero new Claude calls.

### 2. Composite project verdict (deterministic, client-side)

```
if !state.eligible                                      → HOLD
else if any member has ai_verdict_tier === 'WAIT'        → WAIT
else                                                     → BUY
```

Rendered as the large pill on `BasketTotalCard`. No Claude call. Pure derivation. Uses the same `<VerdictPill>` component at `size='md'`.

### 3. AI commentary on basket alerts (optional, opt-in via AI_ENABLED)

Same `Promise.race(3000ms)` timeout pattern as per-tracker alert copy. New prompt builder `buildBasketAlertCopyPrompt({ projectName, basketState, members })` reuses the existing `client.ts`. One Claude call per basket alert dispatch (rare event — alerts only fire on the active→eligible transition once per cooldown window). Plain template fallback when AI is off or Claude is slow / fails. Channel renderers don't need to know "this is a basket vs. a tracker alert" beyond the payload shape — same `aiCommentary?: string | null` parameter convention.

**Cost estimate:** at most one Claude call per basket alert. With ~3 active projects per user × ~1 alert per project per week × cooldown windows = ~1-3 calls/week. Trivial cost (cents/year).

## Error handling

| Failure | Behavior | User impact |
|---|---|---|
| `getActiveProjectIdsForTracker` query fails | Logged structured error; outer fire-and-forget catch swallows; scrape pipeline continues | None |
| `evaluateAndFireForProject` throws | `firer.ts` catches all errors, logs structured, returns | None — basket state stays last-known; next scrape re-tries |
| One channel send fails (e.g., Discord webhook 500) | `Promise.allSettled` allows other channels to dispatch; `project_notifications` rows logged only for successful sends | Partial alert delivered |
| Anthropic API timeout / fail during basket alert copy | `Promise.race` resolves to `null`; channels render with plain basket template | Plain alert delivered |
| Project deleted mid-eval | `loadProjectAndMembers` returns null → firer logs info and returns | None |
| Tracker deleted while in project | DB FK `ON DELETE CASCADE` removes the `project_trackers` row; basket re-eval sees fewer members | Project gracefully shrinks |
| User has 0 enabled channels | Firer logs `no_channels_enabled` info, no alerts; basket state still observable in UI | None — alerts silent |
| `project_notifications` write fails after channel dispatch | Logged structured error; next eval may re-fire on the same condition (acceptable — alerts are idempotent at the user level) | Possible duplicate alert (rare) |
| Member has `last_price === null` (never scraped) | `evaluateBasket` returns `eligible: false, ineligible_reason: 'item_missing_price'` — no alert | Project view shows "1 item gathering data" |
| Add-tracker route receives a tracker_id from another user | Route returns 404 (don't leak existence); no DB write | Attacker learns nothing |

## Observability

Structured logs at every key event:

- `basket_eval_skip` (info) with `{ project_id, ineligible_reason }`
- `basket_alert_fire` (info) with `{ project_id, channel, basket_total, target_total }`
- `basket_alert_cooldown` (info) with `{ project_id, channel, minutes_until_ready }`
- `basket_alert_failed` (warn) with `{ project_id, channel, err }`
- `basket_eval_unexpected` (error) with `{ project_id, err }` — should never happen; signals bug

Project notifications are visible to the project owner via `GET /api/projects/:id` (last 10 rows in the response).

## Testing

| Layer | File | Approx tests |
|---|---|---|
| Pure basket eval | `server/src/projects/basket.test.ts` | ~20 — eligibility states (eligible / over-target / missing-price / errored / no-items), exact-target boundary, partial last_price, multi-member edge cases |
| Migration v9 | `server/src/db/migration-v9.test.ts` | ~6 — three tables created, FKs in place, indexes present, idempotent under repeated `runMigrations()` |
| Project DB queries | `server/src/db/queries.project.test.ts` | ~12 — create/get/update/delete, addTracker/removeTracker, getActiveProjectIdsForTracker, cross-user isolation |
| Firer (mocked channels) | `server/src/projects/firer.test.ts` | ~15 — eligible→fires, ineligible→silent, per-channel cooldown gate, partial channel failure (one fails, others succeed), AI commentary timeout fallback, no enabled channels, archived project skipped |
| Channel basket renderers | `discord-basket.test.ts` (etc.) | ~8 — 2 per channel × 4 channels: with/without `aiCommentary` |
| Cron integration | `server/src/scheduler/cron-projects.test.ts` | ~4 — re-eval fires for each project containing scraped tracker, scrape pipeline unaffected by firer failures, archived projects skipped, no projects → no-op |
| API routes | `server/src/routes/projects.test.ts` | ~15 — auth required, list filters by user, create validation (name required, target_total > 0), member CRUD, can't add same tracker twice (PK violation handled), can't add cross-user tracker, archive flow |

**Target: ~80 new tests.** Server suite goes from 364 → ~444.

## Rollout

1. **Migration v9** runs on deploy. Three new tables created. Zero data backfill needed.
2. **API routes** are live immediately — `/api/projects` and friends.
3. **Frontend** ships the new `/projects` route + `Projects` link in nav.
4. **Existing tracker UX** is untouched — projects are purely additive.
5. **No feature flag.** Unlike the AI Buyer's Assistant, the bundle tracker is deterministic and has no external API dependency. If something breaks, the rollback is `git revert` + redeploy + (optionally) drop the three new tables.

**Manual smoke after deploy:**
- Create a project named "Test Bundle"
- Add 2-3 existing trackers
- Set `target_total` slightly above current basket total → wait for next scrape → confirm alert fires
- Set `target_total` slightly below current basket total → confirm no alert
- Archive → confirm alerts stop

## Out of scope for v1

Deferred to v2 if v1 lands well:

- Drag-and-drop reorder of project members
- Basket-total history mini-chart on project detail
- Suggested items based on category match (bulk-add)
- "Buy now" affiliate links per item
- Project sharing across users
- Auto-archive after first fired alert (`'fulfilled'` intermediate status)
- Multi-currency project totals (today everything is USD)
- Project-level AI narrative summary (basket state too volatile for a stale paragraph)
- Per-channel cooldown override per project (today reuses user's per-channel hours)
- "Add to project" dropdown on the existing tracker-create flow

## Open questions resolved

- **Empty project alert behavior:** allowed at create time (useful for setting up structure first); `evaluateBasket` returns `eligible: false, ineligible_reason: 'no_items'` — silent no-op until items are added.
- **Single-tracker projects:** allowed. Behaviorally redundant with per-tracker threshold alerts, but harmless and cheaper than enforcing a min-2 rule.
- **Cross-user trackers:** rejected. The `POST /:id/trackers` route filters tracker_id by `req.user.id`; cross-user requests return 404 (don't leak existence).
