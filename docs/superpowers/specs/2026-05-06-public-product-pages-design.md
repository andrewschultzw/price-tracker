# Public Product Pages — Design Spec

**Date:** 2026-05-06
**Status:** Approved (rolling into implementation)
**Branch:** `feature/public-product-pages`

## Goal

Anonymous, aggregated, publicly-accessible product price-history pages at `/p/<slug>`. CamelCamelCamel-for-the-long-tail positioning: drives Google traffic + serves as a reference utility for both members and non-members. Each unique `normalized_url` across all users gets one page.

## Decisions

1. **Privacy:** aggregated only. No usernames, no user counts, no per-user data. Lowest current price + price-history sparkline only. Daily aggregates (MIN per day across all trackers) instead of per-scrape to prevent timing-side-channel inference.
2. **Auth:** public-public. No login required. Goal is SEO + drive-by users finding via Google.
3. **URL pattern:** `/p/<slug-with-hash>` — slug derived from product name + 6-char hash of `normalized_url`. Stable across renames.

## Architecture

### New table — migration v13

```sql
CREATE TABLE public_product_slugs (
  slug TEXT PRIMARY KEY,
  normalized_url TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_public_product_slugs_normalized_url
  ON public_product_slugs(normalized_url);
```

The migration also backfills slugs for every existing distinct `normalized_url` in `trackers` so existing products get pages immediately. Backfill picks the most-recent tracker's `name` for `display_name`.

### Slug generation

```typescript
function buildSlug(displayName: string, normalizedUrl: string): string {
  const base = displayName
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  const hash = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 6);
  return `${base}-${hash}`;  // e.g. "samsung-990-pro-4tb-a3b9c2"
}
```

Stable: same `normalized_url` always produces the same hash suffix. Renaming the tracker does NOT change the existing slug (DB row already exists; we don't update on tracker rename).

### Where slugs get created

- **At `createTracker` (server/src/db/queries.ts)** — after inserting a tracker, `INSERT OR IGNORE` a row into `public_product_slugs` keyed on `normalized_url`. First tracker for a given URL "wins" the display name.
- **At migration v13** — one-shot backfill for all existing distinct `normalized_url` values.

### Public API endpoints (no auth)

Mounted at `/api/public/products/*` ahead of the existing auth-gated routes. No `apiKeyMiddleware`, no `authMiddleware`.

- **`GET /api/public/products/:slug`** — returns:
  ```json
  {
    "slug": "samsung-990-pro-4tb-a3b9c2",
    "display_name": "Samsung 990 Pro 4TB NVMe SSD",
    "normalized_url": "amazon.com/dp/...",
    "lowest_current_price": 279.00,
    "lowest_ever_price": 259.00,
    "price_history": [
      {"date": "2026-04-01", "price": 309.99},
      {"date": "2026-04-02", "price": 305.50},
      ...
    ],
    "sample_count": 612,
    "first_observed": "2026-01-15"
  }
  ```
  Aggregation: for the `normalized_url` resolved from `slug`, MIN(`last_price`) across all active trackers gives `lowest_current_price`. For `price_history`, group by `DATE(scraped_at)` taking MIN(price) per day across all trackers. 404 if slug doesn't exist.

- **`GET /sitemap.xml`** — returns an XML sitemap listing all `/p/<slug>` URLs. Simple, ungated.

- **`GET /robots.txt`** — already-static via `client/public/robots.txt`. Allow `/p/*`, disallow everything else by default.

### Client side

- **New route in `client/src/App.tsx`:** `<Route path="/p/:slug" element={<PublicProduct />} />` — added to the **public** Routes block (alongside `/login`, `/register`, `/setup`), NOT inside the auth-protected block.
- **New page component:** `client/src/pages/PublicProduct.tsx` — fetches `/api/public/products/<slug>`, renders display name + lowest current price + sparkline (reuse `PriceChart` lazy component from existing TrackerDetail) + "first observed" + "sample count" stats.
- **Header treatment:** simplified header for public pages — site title + "Sign in" link, no nav. Public pages do NOT use the existing app shell with sidebar.
- **Meta + OG tags:** use `react-helmet-async` (or set `document.title` and meta tags imperatively in `useEffect`). Title: `<display_name> Price History — Price Tracker`. OG title/description matched. Indexable.

## Caching

- Server: response includes `Cache-Control: public, max-age=900, s-maxage=900` (15 min). Aggregations are cheap to recompute; this just smooths burst traffic.
- Client: standard react-query / fetch caching is fine. No special handling.

## Files modified or created

**Server:**
- Modify `server/src/db/migrations.ts` — append migration v13
- Create `server/src/db/migration-v13.test.ts`
- Modify `server/src/db/queries.ts` — slug helpers (`createSlugForUrl`, `getSlugByNormalizedUrl`, `getProductBySlug`, `listAllSlugs`); modify `createTracker` to also call `createSlugForUrl`
- Create `server/src/db/public-products.test.ts` — slug query unit tests
- Create `server/src/lib/build-slug.ts` — pure function (with tests)
- Create `server/src/lib/build-slug.test.ts`
- Create `server/src/routes/public-products.ts` — `/api/public/products/:slug` + `/sitemap.xml`
- Create `server/src/routes/public-products.test.ts`
- Modify `server/src/index.ts` — mount the new routes ahead of the auth-gated mounts; serve `/sitemap.xml` + `/robots.txt` at root paths

**Client:**
- Modify `client/src/App.tsx` — add `<Route path="/p/:slug" element={<PublicProduct />} />` to the public block
- Create `client/src/pages/PublicProduct.tsx` — page component
- Create `client/src/pages/PublicProduct.test.tsx` — component test
- Modify `client/src/api.ts` — add `getPublicProduct(slug)` wrapper (no credentials)
- Create `client/public/robots.txt` — allow `/p/*`, sitemap reference

## Out of scope / future

- **Server-side rendering (SSR)** for true SEO. Modern Googlebot does run JS, but SSR would speed indexing significantly. v2.
- **Affiliate links** on public pages. Not now (separate feature in todo).
- **Trending / popular** sections on the homepage of public surface. Just per-product pages for v1.
- **Per-seller breakdowns** (multi-seller trackers). v1 aggregates across all sellers.
- **Suppression of public pages on opt-out.** No mechanism for users to hide their tracker from public aggregation. Future feature if asked.

## Privacy threat-model

The aggregated-only constraint (no user counts, daily aggregates only) eliminates the obvious leaks. Two remaining vectors:

1. **Single-tracker products.** If only one user is tracking a product, the aggregate IS that user's data. Mitigation: still aggregate (it's just MIN of one value), but DON'T expose any timing detail finer than daily. Anyone visiting the page can't distinguish "1 user tracks this" from "100 users track this."
2. **Inference via correlation.** A determined attacker could correlate scrape timing with their own probes. Mitigation: daily aggregates only — nightly granularity defeats this without a major data loss for users.

Acceptable for v1.
