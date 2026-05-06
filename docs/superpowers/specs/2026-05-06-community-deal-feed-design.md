# Community Deal Feed — Design Spec

**Date:** 2026-05-06
**Status:** Approved (rolling into implementation)
**Branch:** `feature/community-deal-feed`

## Goal

Public anonymous trending feed at `/deals` showcasing the biggest threshold-beating deals across all opted-in users in the last 7 days. CamelCamelCamel feel: "what's hot right now." Each entry links to `/p/<slug>` (the public product pages just shipped). Reuses existing `notifications` + `public_product_slugs` infra — no schema changes beyond a new per-user setting.

## Decisions

1. **Opt-in granularity:** per-user, not per-tracker. Single Settings toggle "Share my biggest drops with the community feed." When ON, this user's `notifications` rows become eligible. Default OFF.
2. **Trending metric:** `drop_pct = (threshold_price - price) / threshold_price`, sorted desc, recency tiebreak. Last 7 days of `notifications.sent_at`. The user already chose the threshold = "this is a good deal" by definition; sorting by drop % surfaces the biggest beat.
3. **Surface:** new public-public route `/deals`. No login required. Header same as public product pages (site title + Sign in link). 50 entries max.

## Architecture

### New per-user setting

Use existing `settings` table (`key = 'share_in_deal_feed'`, value `'true'` or `'false'`, scoped to `user_id`). No migration needed — same pattern as `share_display_name`.

Default = absent = treated as `false`. Only users who explicitly enable participation contribute to the feed.

### Query: build feed

```typescript
export interface DealFeedEntry {
  slug: string;             // from public_product_slugs join
  display_name: string;
  current_price: number;
  threshold_price: number;
  drop_pct: number;         // 0..1
  hours_ago: number;
  normalized_url: string;
}

export function getCommunityDealFeed(limit: number = 50): DealFeedEntry[];
```

SQL shape (single query, joins are cheap):

```sql
SELECT pps.slug, pps.display_name, pps.normalized_url,
       n.price AS current_price,
       n.threshold_price,
       (n.threshold_price - n.price) * 1.0 / n.threshold_price AS drop_pct,
       (julianday('now') - julianday(n.sent_at)) * 24 AS hours_ago
  FROM notifications n
  JOIN trackers t ON t.id = n.tracker_id
  JOIN public_product_slugs pps ON pps.normalized_url = t.normalized_url
  JOIN settings s ON s.user_id = t.user_id AND s.key = 'share_in_deal_feed' AND s.value = 'true'
 WHERE n.sent_at >= datetime('now', '-7 days')
   AND t.normalized_url IS NOT NULL
   AND n.threshold_price > 0
 GROUP BY pps.slug
HAVING n.id = MAX(n.id)            -- pick the most recent notification per product
 ORDER BY drop_pct DESC, n.sent_at DESC
 LIMIT ?;
```

The `GROUP BY pps.slug HAVING n.id = MAX(n.id)` collapses multiple notifications for the same product down to the most recent — keeps the feed varied. (SQLite supports the bare `n.id = MAX(n.id)` idiom in HAVING when grouped — verify with a test.)

### Public API endpoint

**File:** extend `server/src/routes/public-products.ts`:

```typescript
router.get('/deals', (req, res) => {
  const entries = getCommunityDealFeed(50);
  res.set('Cache-Control', 'public, max-age=300, s-maxage=300'); // 5 min
  res.json({ entries, generated_at: new Date().toISOString() });
});
```

Mounted at `/api/public/deals`. No auth.

### Settings UI — opt-in toggle

**File:** modify `client/src/pages/Settings.tsx` and the existing settings card pattern.

Add a small new card (or extend an existing "Sharing" section if one exists — check first) with one labeled toggle: "Share my biggest drops with the community deal feed." Toggle calls existing `updateSettings({ share_in_deal_feed: 'true' | 'false' })`. Caption: "Anonymous. Other users see the price + product, never your name."

### Client public page — `/deals`

**File:** `client/src/pages/CommunityDeals.tsx` (new), `CommunityDeals.test.tsx`.

Mounted in `App.tsx` in the same public Routes block as `/p/:slug` (and the early-return path-prefix check should add `/deals` so logged-in users see the same view).

Render: simplified header (site title + Sign in link), then a grid of cards:

```
┌─────────────────────────────────┐
│  Samsung 990 Pro 4TB            │
│  $279                            │
│  18% below threshold • 2h ago   │
│  → View price history            │
└─────────────────────────────────┘
```

Each card links to `/p/<slug>`. Drop % rendered as `${(drop_pct * 100).toFixed(0)}% below threshold`. Hours-ago rendered as "Nh ago" / "Nd ago" / "Just now."

### Sitemap update

`/deals` added to `server/src/index.ts`'s sitemap.xml output (one extra `<url>` entry).

## Files modified or created

**Server:**
- Modify `server/src/db/queries.ts` — add `getCommunityDealFeed(limit)` + types
- Create `server/src/db/community-deals.test.ts` — query unit tests
- Modify `server/src/routes/public-products.ts` — add `/deals` route
- Modify `server/src/routes/public-products.test.ts` — add `/deals` route tests
- Modify `server/src/index.ts` — add `/deals` to sitemap

**Client:**
- Modify `client/src/api.ts` — add `getCommunityDeals()` wrapper
- Create `client/src/pages/CommunityDeals.tsx`
- Create `client/src/pages/CommunityDeals.test.tsx`
- Modify `client/src/pages/Settings.tsx` — add opt-in toggle
- Modify `client/src/App.tsx` — mount `/deals` public route + extend public-prefix early-return

## Privacy posture

- No usernames in any response
- `tracker_id` and `user_id` never exposed
- Only opted-in users contribute (default OFF)
- Anonymous aggregation matches public product pages posture
- `notifications.sent_at` rounded to hours-ago in the response (no minute-precision timing)

## Out of scope / future

- "Pin" / "save" deals to a personal list (logged-in feature)
- Per-category feed (`/deals/laptops`)
- Email/Discord deal-feed digest
- Trending derivatives (rate of change, "deal of the day")

## Test coverage

- Query test: feed contains opted-in users' alerts; non-opted-in users excluded; orphan notifications (tracker without normalized_url or no public_product_slug) excluded
- Query test: HAVING MAX(id) correctly collapses duplicate-product notifications to most recent
- Route test: 200 + entries shape; no auth required (verify no cookies / no X-API-Key passes); cache header set
- Component test: empty feed renders graceful "No deals yet"; entries render with correct drop % + hours-ago format
- Settings test: toggle persists via existing settings update flow

Estimated total: ~250 LOC + tests.
