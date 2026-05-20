# Purchased Tracking & Savings Rollup — Design

**Date:** 2026-05-20
**Status:** Draft, pending implementation plan

## Summary

Add a "Purchased" action to each tracker that logs the buy event, calculates money saved against the first-seen price, and surfaces a running total in both an admin view and a public footer/page. Trackers can be re-purchased over time, and individual trackers can opt into "keep watching" after purchase for repeat buys.

## Goals

- One-click purchase logging from a tracker detail page, with editable defaults pre-filled from the latest scrape
- Per-tracker purchase history with optional "keep watching" for repeatable purchases
- Authenticated admin view: total saved, purchase count, full purchase log with edit/delete
- Public proof-of-value: footer line on every page + dedicated `/savings` page with cumulative sparkline
- Zero leakage of product names or retailers through public surfaces

## Non-Goals

- Receipt/order-number tracking (out of scope; YAGNI)
- Per-purchase notes/comments (dropped during brainstorming)
- Negative-savings accounting (purchases above first-seen count as $0 saved, not negative)
- Tax, shipping, or fee modeling — `purchase_price` is whatever the user paid, period
- Pruning old `price_history` rows as part of this feature

## Decisions Made During Brainstorming

| Question | Decision | Reason |
|----------|----------|--------|
| Savings baseline | `first_price − purchase_price` (vs. first seen) | Honest, no per-purchase typing, matches mental model |
| Behavior after purchase | Soft archive with per-purchase "keep watching" toggle | Most purchases are one-off, but consumables/gifts need repeat support |
| Capture fields | price, date, seller, quantity (no notes) | Cover real divergence (coupon, gift card, multi-buy) without bloat |
| Visibility | Admin log + public number | Headline number is shareable, log is private |
| Public placement | Footer everywhere + `/savings` page | Always-visible credibility line + linkable shareable URL |
| Savings stat freshness | Live SQL query on each public request | Trivial query, no cache-invalidation foot-gun |
| Missing price history at purchase time | Set `first_price = purchase_price` (savings $0) | Don't block the user; reflect reality |

## Data Model

### New table: `purchases` (migration v18)

```sql
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
  purchase_price REAL NOT NULL CHECK(purchase_price >= 0),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
  first_price REAL NOT NULL,
  purchased_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_purchases_tracker_id ON purchases(tracker_id);
CREATE INDEX idx_purchases_purchased_at ON purchases(purchased_at);
```

**`first_price` is snapshotted, not recomputed.** If `price_history` is ever pruned or a tracker is imported mid-life, the savings number stays stable. Same reasoning as snapshotting `amount` on an invoice row — the historical fact shouldn't drift.

### Tracker status enum extended

Existing CHECK constraint on `trackers.status` widens to:
```
status IN ('active', 'paused', 'error', 'blocked', 'purchased')
```

Use the same `unsafeMode` + `writable_schema` pattern as migration v17 (rebuild-the-table approach hit FK cascade issues per lessons.md).

`tracker_urls.status` is **not** changed — `purchased` is a tracker-level state, not per-seller.

### Computed values (not stored)

- Per-purchase savings: `MAX(0, (first_price − purchase_price) × quantity)`
- Total saved: `SUM` of the above across all purchases
- Negative deltas (paid more than first-seen) clamp to $0 — they don't subtract from the total

## Backend API

### Authenticated endpoints

| Method | Path | Body / Query | Returns |
|--------|------|--------------|---------|
| `POST` | `/api/trackers/:id/purchases` | `{ purchase_price, quantity, purchased_at?, tracker_url_id?, keep_watching? }` | `{ purchase, tracker }` |
| `GET` | `/api/purchases` | `?limit=50&offset=0&order=purchased_at:desc` | `{ purchases: [...], total }` with tracker name + primary URL joined |
| `PATCH` | `/api/purchases/:id` | Any subset of `purchase_price, quantity, purchased_at, tracker_url_id` | Updated purchase row |
| `DELETE` | `/api/purchases/:id` | — | `{ ok: true }`; if this was the only purchase and tracker is `purchased`, status flips back to `active` |

### Public endpoint

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/api/public/savings` | `{ total_saved, purchase_count, since, monthly: [{ month: 'YYYY-MM', saved }] }` |

No product names, retailer names, URLs, or per-tracker amounts in the public payload. Just aggregates.

### `POST /api/trackers/:id/purchases` logic

1. Validate tracker exists and belongs to the authenticated user.
2. Snapshot `first_price` (the earliest recorded price for this tracker, matching the "vs. first seen" semantic):
   - Primary: `SELECT price FROM price_history WHERE tracker_id = ? ORDER BY recorded_at ASC LIMIT 1`
   - Fallback: `tracker.last_price` if `price_history` is empty
   - Last resort: `purchase_price` itself (savings = $0)
3. Default `purchase_price = tracker.last_price` if not provided.
4. Default `purchased_at = datetime('now')` if not provided.
5. Insert purchase row.
6. Set `tracker.status`:
   - `keep_watching === true` → `'active'` (re-activates a previously-purchased tracker if needed)
   - `keep_watching !== true` → `'purchased'`
7. Log at `info`: `purchase_logged tracker_id=… saved=… keep_watching=…`.

Multiple purchases per tracker are explicitly supported. Logging a purchase on an already-`purchased` tracker is allowed — it just appends a new row and re-applies the status decision based on the new `keep_watching` value.

### Validation

- `purchase_price` required, must be `>= 0`
- `quantity` defaults to 1, must be integer `>= 1`
- `purchased_at` if provided must parse as ISO8601
- `tracker_url_id` if provided must belong to the same tracker

## Scheduler & Scrape Behavior

The whole feature is additive — no changes to scrape pipeline, browser code, notification code, or block-detection logic.

- `getDueTrackers()` excludes `status='purchased'` the same way it currently excludes `'paused'`. Single line addition to the existing filter.
- "Keep watching" purchases leave `status='active'`, so the tracker continues scraping. The purchase row exists only for the savings rollup.

## Frontend UI

### Tracker detail page — "Purchased" button

Green button in the existing action row (Edit / Pause / Delete). Click opens a modal:

```
┌─ Log Purchase ──────────────────────────┐
│ Price paid:    [$  47.99 ]              │
│ Quantity:      [ 1 ▾ ]                  │
│ Date:          [ 2026-05-20 ]           │
│ Seller:        [ Amazon       ▾ ]   (only if multi-seller)
│                                          │
│ Estimated savings: $32.00                │
│                                          │
│ [ ] Keep watching after purchase         │
│                                          │
│     [ Cancel ]    [ Confirm Purchase ]  │
└─────────────────────────────────────────┘
```

- Price defaults to current `last_price`; date defaults to today; seller defaults to the currently-selected seller (if multi-seller).
- "Estimated savings" updates live as the user edits price or quantity: `max(0, (first_price − price) × qty)`.
- If tracker already has purchases, button label becomes **"Log Another Purchase"**.

After successful submit:
- Modal closes, toast: "Purchase logged — saved $32.00"
- Detail page refreshes; if `keep_watching=false`, tracker now shows the purchased banner (see below)

### Tracker detail after `status='purchased'`

A green/success-styled banner at the top of the detail page:
```
✓ Purchased on May 12, 2026 — saved $32.00 (1 × $47.99)
```
The existing price history chart remains visible below — past-purchase context is still useful.

If multiple purchases exist for a tracker, banner shows the most recent purchase summary and a "View all N purchases" link to the admin Purchased page filtered to that tracker.

### Dashboard

- `purchased` trackers are hidden by default in the main dashboard list.
- Add a **"Show purchased"** toggle to the existing filter bar. When on, purchased trackers appear with a visual indicator (✓ icon or muted styling) so they're distinguishable.

### New `/purchased` admin page

Linked from the main nav. Layout:

**Header card (three stats):**
```
TOTAL SAVED         PURCHASES         AVG PER PURCHASE
$1,247.83              23                $54.25
```

**Table below** (re-uses existing dashboard table styling):
| Product | Seller | Paid | First Seen | Saved | Qty | Date | |
|---------|--------|------|------------|-------|-----|------|---|
| (link to tracker) | Amazon | $47.99 | $79.99 | $32.00 | 1 | May 12 | [edit] [delete] |

- Newest first by default; clickable column headers for sort
- Pagination at 50/page
- Edit opens the same modal as the create flow, pre-filled
- Delete confirms inline ("Delete this purchase? Tracker status will be restored if this was its only purchase.")

### Footer (every page)

Subtle line in the existing footer:
```
Saved $1,247.83 since Apr 2026 →
```
Link goes to `/savings`. Refreshes on page load (it's cheap).

### `/savings` (public)

Unauthenticated page. Layout:
- Hero number: huge `$1,247.83`
- Subhead: `saved across 23 purchases since April 2026`
- Recharts area chart: cumulative savings over time, monthly buckets from `/api/public/savings`
- No product names, no retailers, no per-tracker breakdowns

## Testing

Follow existing patterns (123 server + 61 client = 184 tests baseline).

### Server tests (~12 new)

- **Migration v18**: purchases table created with correct columns and indexes; `purchase_price >= 0` and `quantity >= 1` CHECK enforced; `trackers.status` CHECK includes `'purchased'`; FK cascade deletes purchases when tracker is deleted; FK `SET NULL` for `tracker_url_id` when a seller row is removed
- **`POST /api/trackers/:id/purchases`**:
  - happy path with full body
  - defaults `purchase_price` to `tracker.last_price`
  - defaults `purchased_at` to now
  - snapshots `first_price` from the earliest `price_history` row (oldest `recorded_at`)
  - fallback to `tracker.last_price` when history empty
  - last-resort `first_price = purchase_price` when no history and no last_price (savings = $0)
  - `keep_watching=true` leaves `status='active'` (or re-activates an already-purchased tracker)
  - `keep_watching=false` (default) sets `status='purchased'`
  - logging a second purchase on an already-`purchased` tracker succeeds and appends a row
- **`GET /api/purchases`**: pagination, ordering, joined tracker name
- **`PATCH /api/purchases/:id`**: partial updates, rejects out-of-range values
- **`DELETE /api/purchases/:id`**: removes row, reverts tracker `purchased`→`active` if it was the only purchase, no revert if other purchases exist
- **`GET /api/public/savings`**: no auth required, returns expected shape, monthly buckets correct, savings floored at $0 for negative deltas, empty state (no purchases) returns zeros not error
- **Scheduler**: `purchased` trackers excluded from `getDueTrackers()`; `active` trackers with purchases (keep-watching) still appear

### Client tests (~6 new)

- **Purchase modal**: pre-fill, live savings calc, validation (required price, quantity ≥ 1, valid date)
- **Tracker detail**: purchased banner renders with correct copy, chart still visible
- **Purchased admin page**: totals computed correctly, table renders, edit and delete flows work
- **Dashboard**: `purchased` trackers hidden by default, toggle reveals them with visual distinction
- **Footer**: savings line renders with public-endpoint value, links to `/savings`
- **`/savings` page**: hero number, sparkline renders from monthly data, accessible without login

### Manual exercise checklist

- Log a purchase end-to-end on a real tracker; confirm DB row, status change, dashboard hides it
- Toggle "keep watching"; verify tracker keeps scraping on next scheduler tick
- Open footer + `/savings` from an unauthenticated browser session; confirm the number matches
- Delete a purchase; verify tracker re-activates and dashboard shows it again
- `curl https://prices.schultzsolutions.tech/api/public/savings` — confirm no product or retailer names in payload
- Log a purchase on a tracker with no `price_history` (newly created, never scraped); verify $0 savings, no crash

## Migration & Rollout

- Migration v18 applies on next deploy via the existing `runMigrations()` flow
- DB backup runs automatically in `rebuild.sh` before `npm ci`
- Feature is purely additive — no existing endpoints change shape, no data is rewritten
- Zero-risk deploy; rollback = drop v18 + drop column extension (manual SQL if needed, but the migration framework runs forward-only)

## Open Risks

- **Public endpoint abuse**: `/api/public/savings` has no auth and no rate limit today. Existing reverse proxy (NPM on CT 100) has basic rate limiting that should cover this — if it doesn't, add the same per-IP throttle the wishlist endpoints use. Track as a follow-up if it becomes an issue.
- **Edit/delete UX on the admin page**: inline edit modal vs. a separate edit page. Spec assumes modal for consistency with create; revisit if it gets cramped.
- **Multi-currency**: existing system is USD-only; this feature inherits that assumption. If multi-currency is ever added, `purchases.purchase_price` will need a currency column too.

## Out of Scope (Tracked for Later)

- Receipt/order-number capture
- Per-purchase notes
- "Most-saved-on" leaderboard (private)
- Slack/Discord notification when a purchase is logged
- Export purchases as CSV
