# Stock + Refurb Tracking — Design Spec

**Date:** 2026-05-06
**Status:** Approved (rolling into implementation)
**Branch:** `feature/stock-refurb-tracking`

## Goal

Let users track refurbished, open-box, and warehouse listings as variants of a product alongside the new listing — surface that "Amazon Warehouse $239 (used-like-new)" beats "$279 new" right in the alert. The existing `tracker_urls` multi-seller infra already supports multiple URLs per tracker; we just need to label each URL's condition and surface it through the UI + alerts.

## Decisions

1. **Modeling:** add a `condition` enum column to `tracker_urls`. Values: `'new' | 'warehouse' | 'refurb' | 'open_box'`. Default `'new'`. Backfill existing rows to `'new'`.
2. **No new scrape adapters in v1.** Amazon Warehouse, Newegg refurb, Best Buy open-box pages all hit existing extractor strategies (jsonld / opengraph / regex) that already work. User just pastes the URL + selects the condition.
3. **Condition is per-URL, not per-tracker.** A single tracker can mix conditions (e.g., one URL is `new`, another is `warehouse`). The lowest price across all URLs still wins for alert-firing; the alert message names the condition of the winning URL.

## Architecture

### Migration v14

```sql
ALTER TABLE tracker_urls ADD COLUMN condition TEXT NOT NULL DEFAULT 'new'
  CHECK(condition IN ('new', 'warehouse', 'refurb', 'open_box'));
```

(SQLite supports `ALTER TABLE ... ADD COLUMN` with `CHECK` constraints.)

Backfill: existing rows already get `'new'` via the default.

### Query layer

- Modify `getTrackerUrlsForTracker` to return `condition` in the row shape
- Modify `addTrackerUrl` to accept an optional `condition` parameter (default `'new'`)
- Update existing types: `TrackerUrl` interface gains `condition: 'new' | 'warehouse' | 'refurb' | 'open_box'`

### Routes

- `POST /api/trackers/:id/urls` — accept `condition` in request body (zod validated, default `'new'`)
- `PATCH /api/trackers/:id/urls/:urlId` (NEW if missing — likely missing) — allow updating `condition` on an existing URL

### Alert message integration

When `firePriceAlerts` fires, look up which `tracker_url` produced the winning price and include its condition. Concretely:

- **Discord:** if condition !== 'new', append condition tag after the price: `$239 (Amazon Warehouse)` instead of just `$239`
- **ntfy / email / web push:** same — concise condition tag in the body
- **Webhook:** add `condition` field to the alert JSON payload

The condition's display name comes from a lookup map:

```typescript
const CONDITION_LABEL = {
  new: '',  // no tag — default
  warehouse: 'Warehouse',
  refurb: 'Refurbished',
  open_box: 'Open Box',
};
```

Empty label for `'new'` means today's alerts look unchanged (no "(New)" tag).

### Client UI

**AddTracker page (`client/src/pages/AddTracker.tsx`):** When user adds multiple seller URLs, each row gains a small dropdown after the URL field — `[New | Warehouse | Refurb | Open Box]`. Default `New`.

**TrackerDetail page (`client/src/pages/TrackerDetail.tsx`):** seller URL list shows a small badge next to non-`'new'` URLs (`Warehouse` / `Refurb` / `Open Box`). Inline editor (where existing edit-URL UI is) gains the same dropdown.

**Visual:** condition badges use distinct colors:
- Warehouse: amber `bg-warning/15 text-warning`
- Refurb: blue `bg-primary/15 text-primary`
- Open Box: green `bg-success/15 text-success`

## Files modified or created

**Server:**
- Modify `server/src/db/migrations.ts` — append v14
- Create `server/src/db/migration-v14.test.ts`
- Modify `server/src/db/queries.ts` — type + helpers
- Modify `server/src/db/queries.test.ts` (or related) — assert condition round-trips
- Modify `server/src/routes/trackers.ts` — accept condition on POST + new PATCH for URL edit
- Modify `server/src/routes/trackers.test.ts` (or wherever URL-CRUD tests live) — condition coverage
- Modify each notification module's price-alert function to render condition (if winning URL is non-'new')
- Modify `server/src/scheduler/cron.ts` — pass winning URL's condition into the alert pipeline

**Client:**
- Modify `client/src/types.ts` — add `condition` to TrackerUrl
- Modify `client/src/api.ts` — pass condition through `addTrackerUrl` + new `updateTrackerUrl`
- Modify `client/src/pages/AddTracker.tsx` — condition dropdown per URL row
- Modify `client/src/pages/TrackerDetail.tsx` — condition badges in URL list + edit dropdown

## Tests

Server:
- Migration v14 idempotent + backfill produces `'new'` for existing rows
- `addTrackerUrl(..., condition: 'warehouse')` round-trips
- POST route accepts and persists `condition`
- Invalid condition value returns 400
- PATCH route updates condition
- Alert formatting: when winning URL is `'warehouse'`, alert text includes "(Warehouse)" tag; when `'new'`, no tag (regression check)

Client:
- AddTracker condition dropdown defaults to "New" and persists chosen value
- TrackerDetail renders correct badge for each condition

## Out of scope / future

- New scrape adapters specifically tuned for Amazon Warehouse / Newegg refurb listings (existing extractors handle them well enough for v1)
- Auto-condition-detection from URL pattern (e.g., URL contains `/refurbished/` → auto-set to `refurb`)
- Per-condition threshold prices (e.g., "alert me if Warehouse goes below $200 OR if New goes below $250")
- "Stock status" tracking (in stock / out of stock / temporarily unavailable) — separate feature
- Condition filter on /deals public feed

## Estimated scope

~400 LOC + tests. One PR.
