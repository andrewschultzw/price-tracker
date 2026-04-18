# Cross-User Tracker Overlap Design

**Date:** 2026-04-18
**Status:** Approved
**Author:** Andrew Schultz + Claude

## Overview

When multiple users on the same Price Tracker instance track the same product, surface a cross-user overlap indicator so users notice that shared interest — and optionally see who else tracks it (opt-in) plus the current community low price (anonymous). Homelab/household context: small user counts (1-5), already-trusted relationships, but the app still treats per-user data (thresholds, alerts, price history) as private.

## Decisions

- **Matching strategy:** Canonical URL normalization, resolved via Playwright's final URL at tracker creation. Stored as a new `normalized_url` column on `trackers`. Per-retailer ASIN/SKU parsers are not worth the maintenance burden for homelab scale.
- **Privacy model:** Anonymous count surfaced always; per-user display names revealed only for users who opt in via a global setting. Everything else per-user stays private.
- **Surface:** Badge on `TrackerCard` (passive dashboard discovery) + section on `TrackerDetail` (depth). No add-tracker toast.
- **Community low:** Included — `MIN(last_price)` across all trackers with the same `normalized_url`, shown on TrackerDetail as an anonymous aggregate.

## Schema

### New column

```sql
ALTER TABLE trackers ADD COLUMN normalized_url TEXT;
CREATE INDEX idx_trackers_normalized_url ON trackers(normalized_url);
```

`normalized_url` is nullable. Legacy trackers populated via migration-time normalization of their existing `url`; any that don't normalize cleanly stay null and never match in overlap queries (fail-safe).

### Existing `trackers.url` unchanged

The user-facing `url` field keeps exactly what the user pasted, so the UI, category grouping, and favicon lookups work as before. `normalized_url` is internal.

## Normalization

New shared helper `server/src/lib/normalize-url.ts`:

```ts
export function normalizeTrackerUrl(url: string): string | null
```

Pipeline:
1. Parse as `URL`. On failure → return `null`.
2. Lowercase the hostname and run it through the existing `canonicalDomain()` helper (moved from `client/src/lib/domains.ts` to a shared module so both server and client can import — the helper is pure, zero dependencies).
3. Lowercase the pathname.
4. Drop tracking/session query params. Deny-list: `tag`, `ref`, `ref_`, `_encoding`, `psc`, `srsltid`, `cm_sp`, any `utm_*`, `_gl`, `_ga*`. Keep everything else (Newegg's `Item=`, etc.).
5. Strip trailing slashes and URL fragments.
6. Reassemble as `canonicalDomain + pathname + sorted remaining query string`.

Pure function, fully testable without I/O.

### Short-link resolution

On tracker creation, the existing test-scrape flow already fetches the URL via Playwright. Capture `response.url()` (the final URL after redirects) and pass THAT into `normalizeTrackerUrl`. This resolves `a.co/d/xyz` → `amazon.com/dp/B0XXX` without new network calls. `createTracker` gains an optional `final_url` parameter; when present, it's used in place of the input `url` for normalization.

Migration-time backfill normalizes from the stored `url` only — no Playwright during migration. Short-link trackers in existing data stay unresolved until next manual edit or re-scrape enhancement (out of scope).

## API

### Per-tracker overlap

```
GET /api/trackers/:id/overlap
```

Response body:
```json
{
  "count": 2,
  "names": ["Alice", "Bob"],
  "communityLow": 35.99
}
```

- Authenticated. 404 if the tracker isn't owned by the requesting user (keeps the enumeration surface closed).
- `count`: number of OTHER users (not self) whose trackers share this `normalized_url`.
- `names`: display names of those OTHER users who have `share_display_name = true`. Always a subset of `count`; may be empty even when `count > 0`.
- `communityLow`: `MIN(last_price)` across ALL trackers with this `normalized_url` that have a non-null `last_price` (including this user's own). `null` if no user has a price yet. The UI hides this line when it doesn't actually beat the user's own best, so including self is a no-op visually but keeps the value self-consistent: every viewer sees the same `MIN` across the same population.

### Batch overlap counts

```
GET /api/trackers/overlap-counts
```

Response body:
```json
{
  "1": 0,
  "2": 2,
  "3": 5
}
```

Returns a map from tracker ID to overlap count for every tracker owned by the requesting user. Prevents N+1 on the dashboard where every card would otherwise fire its own overlap request. Computed via a single SQL `GROUP BY normalized_url` over all trackers, then projected to the user's tracker IDs.

### Settings wiring

New allowed setting key: `share_display_name`. Stored as `'true'` / `'false'` strings (consistent with how the other settings handle booleans). Not encrypted — the value is a user preference, not a credential.

## UI

### TrackerCard pill

When `count > 0` (from the batch endpoint), render a small pill below the tracker name:

```
🧑‍🤝‍🧑 Also tracked by 2
```

Uses the existing pill styling (Lucide `Users` icon + `bg-surface-hover` background). Hidden when count is 0. Not clickable — depth lives on the detail page.

### TrackerDetail Community card

New card between the existing "Sellers" and "Recent Alerts" cards. Shown only when `count > 0`:

```
┌─ Community ────────────────────────────┐
│ Also tracked by 2 others               │
│ Shared by Alice, Bob                   │   ← only if opted-in names > 0
│ Community low: $35.99  ↓               │   ← only if communityLow < user's last_price
└────────────────────────────────────────┘
```

Community low only renders when it's actually BETTER than the user's current best — otherwise it's noise. Arrow indicator matches the existing "below target" styling.

### Settings card

New card in `Settings.tsx` below the notification channels, titled **"Community"**:

- Single checkbox: "Show my display name to other users on trackers we share"
- Helper text: "When on, other users who track the same product see your name. Default off."
- Save uses the existing `updateSettings` PUT flow with `share_display_name: 'true' | 'false'`.

## Privacy model

| Data | Exposure |
|------|----------|
| Tracker URL | Shared (matched via `normalized_url`) |
| Threshold prices | **Never shared** — always private |
| Notification settings (channels, recipients) | **Never shared** — always private |
| Alert history | **Never shared** — always private |
| Individual price history | **Never shared** — always private |
| `last_price` (current only) | Shared as anonymous `MIN` aggregate only |
| Display name | Shared only for users with `share_display_name = true` |

Every cross-user query is scoped by `normalized_url`. There is no query that walks another user's price_history, notifications, or settings. Tests lock down this boundary.

## Normalization edge cases

- **Malformed URL** → store `null`; tracker works normally but never matches in overlap. No error to the user.
- **Empty path (`https://amazon.com/`)** → normalizes to `amazon.com/`. Unlikely to collide meaningfully, acceptable.
- **Different ports** → port is preserved in normalization. An unusual case; no known real-world issue.
- **URL-encoded paths** → normalized by the `URL` class's default behavior. Consistent input → consistent output.
- **Retailer changes short-link target** → we store whatever the final URL was at create time; subsequent changes to where the short link points don't retro-update. Acceptable for homelab scale.

## Testing

- `lib/normalize-url.test.ts` — pure function tests: tracking params stripped, hostname canonicalized, short-link-resolved URLs match their canonical `/dp/` equivalent, malformed URLs return null, deterministic output for equivalent inputs.
- `db/overlap.test.ts` — integration tests using the in-memory DB fixture pattern from `refresh-aggregates.test.ts`:
  - Overlap count excludes self, counts two other users correctly.
  - `names` respects opt-in (only opted-in users appear; others counted but nameless).
  - `communityLow` returns the MIN across all users INCLUDING self; null when no prices exist.
  - 404 when requesting overlap for a tracker not owned by the caller.
- `migration-v6.test.ts` — backfill populates `normalized_url` for existing rows; idempotent re-run is a no-op.
- Client: TrackerCard pill renders/hides based on the batch endpoint; TrackerDetail Community card renders names correctly; community low shows only when lower than the user's price; Settings card saves `share_display_name`.

## Out of scope

- Per-tracker name-reveal toggle (global only).
- "Community" page showing all shared trackers across the instance.
- Add-tracker toast offering to show community low before save.
- Historical community data / community-low-over-time chart.
- Re-resolution of short links for legacy trackers.
- Cross-tenant formal access control audits (homelab context).
