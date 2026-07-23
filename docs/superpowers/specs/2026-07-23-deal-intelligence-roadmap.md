# Deal Intelligence Roadmap — Design Spec (Phases 1–4)

**Date:** 2026-07-23
**Status:** Approved direction (Andy, 2026-07-23); phases implement as separate PRs
**Branches:** `feature/p1-deal-intelligence`, `feature/p2-share-target`, `feature/p3-weekly-digest`, `feature/p4-back-in-stock`

## Context

The app has 34 trackers, ~12.4k price points, and has sent 2,118 notifications —
but every alert is a *static threshold* comparison. The history is never used
for judgment, mobile add is high-friction, slow failures rot silently (2
trackers sitting at >3 consecutive failures today), and availability is only
handled as an error-avoidance special case. These four phases attack that, in
order of value. Extension-assisted scraping for blocked retailers (Best
Buy/Home Depot) was considered and deliberately deferred — single-browser
household today, low impact.

Shared foundation (lands in Phase 1, used by 3 and 4):

```sql
-- Migration v20
ALTER TABLE notifications ADD COLUMN alert_type TEXT NOT NULL DEFAULT 'threshold'
  CHECK(alert_type IN ('threshold','low_30d','low_90d','low_all_time','back_in_stock','digest'));
```

Cross-phase rules:

- Any new column on `trackers` MUST update the extension's Tracker parity type
  or CI's drift-detector fails the extension workspace.
- Each phase: own branch + PR, CI green, auto-deploy via the merge webhook,
  then a real-browser smoke on https://prices.schultzsolutions.tech (mandatory
  for the UI-touching phases 1, 2, 4).
- Migrations numbered sequentially from v20; later phases renumber if they land
  out of order.

---

## Phase 1 — History-aware deal intelligence

### Goal

Use the price history we already have to (a) alert on *record lows* even when no
threshold is set, (b) suggest sane thresholds, and (c) flag stale thresholds —
attacking alert fatigue (62 notifications/tracker) and the stale-threshold
problem in one move.

### Decisions

1. **Daily-min basis.** All stats and record-low comparisons use per-day
   minimum prices (the same downsampling `getDailyMinHistoryForNormalizedUrl`
   uses), across ALL of a tracker's sellers but **only `condition='new'`
   rows** — a warehouse price is not an "all-time low" for the product.
2. **Three low tiers, fire highest only:** `low_all_time` > `low_90d` >
   `low_30d`. One alert per scrape, tagged via `alert_type`.
3. **Coverage gates** (no trivial lows on young trackers): `low_30d` needs ≥21
   days of history span; `low_90d` ≥60 days; `low_all_time` ≥90 days AND ≥25
   distinct daily points. Additionally `low_all_time` requires ≥1% below the
   previous record (penny-noise guard).
4. **Fires without a threshold.** This is the big unlock — trackers with no
   `threshold_price` currently never alert. Record-low alerts respect the
   existing per-channel cooldowns and min-confidence suppression unchanged.
5. **Per-tracker mode, not per-channel:** `trackers.low_alert_mode` —
   `'all'` (default) | `'record_only'` (all-time only) | `'off'`.
6. **Threshold suggestion = 10th percentile of 90-day daily mins** (fallback:
   all-time when <60d of data). Displayed, never auto-applied.
7. **Stale-threshold detector** (pure fn, also feeds Phase 3):
   - `stale_low`: threshold < 0.95 × all-time min with ≥60d tracked (unreachable)
   - `stale_high`: threshold ≥ 30-day median (fires trivially)

### Architecture

- **Migration v20:** `alert_type` (above) plus
  `ALTER TABLE trackers ADD COLUMN low_alert_mode TEXT NOT NULL DEFAULT 'all'
  CHECK(low_alert_mode IN ('all','record_only','off'))`.
  ⚠️ Extension Tracker parity type gains `low_alert_mode`.
- **New pure module `server/src/stats/price-stats.ts`:**
  `computePriceStats(dailyMins, now)` → per-window {30d, 90d, 365d, all}:
  min/max/median + current-price percentile + coverage (span days, point
  count); `evaluateLowTier(candidatePrice, stats, mode)` → tier | null;
  `suggestThreshold(stats)`; `thresholdStaleness(threshold, stats)`.
- **Pipeline hook:** in the scrape success path (post-plausibility-guard,
  pre-insert), load daily mins EXCLUDING the candidate scrape, evaluate tier,
  then insert + alert. Reuses the existing alert fan-out; alert copy gains
  context: `"$412 — lowest ever seen (prev. $429 on Mar 3 · 289 days tracked)"`.
- **Route:** `GET /api/trackers/:id/stats` → windows + suggestion + staleness
  (computed on demand; 12.4k rows total makes caching unnecessary).
- **Client:** TrackerDetail gains a Price Context card (window min/median,
  "current price is in the Nth percentile", suggested threshold + Apply
  button, staleness note); TrackerCard + dashboard get an `All-time low` /
  `90-day low` chip (server-computed in the list payload, shown ≤48h after the
  record was set); low-alert-mode select in tracker edit.
- **Public product pages** reuse the same chip.

### Testing

Unit: price-stats pure fns (gates, tiers, percentile, staleness edge cases —
empty history, single seller, mixed conditions). Integration: pipeline fires
correct tier once, respects mode/cooldown/no-threshold case. Extension parity
build. Browser smoke on prod post-deploy.

**Estimate:** the biggest phase — roughly two focused sessions.

---

## Phase 2 — PWA share-target (mobile add)

### Goal

Phone flow becomes: product page → Share → Price Tracker → confirm. Today it's
copy URL / open PWA / paste, and it shows: 2 web-push subscriptions across 4
users.

### Decisions

1. **GET share_target** (no files, no POST needed):

```json
"share_target": {
  "action": "/share",
  "method": "GET",
  "params": { "title": "title", "text": "text", "url": "url" }
}
```

2. **URL extraction precedence:** `url` param → first `https?://` match in
   `text` (many Android apps put the URL there) → same match in `title` →
   none: friendly "no link found" screen with a manual-add link.
3. **Dedup first:** if the shared URL normalizes to an existing tracker,
   navigate straight to its detail page with an "Already tracking" toast —
   sharing a tracked product becomes the fastest way to check it.
4. **Otherwise prefill `/add`** (url + name from shared title, retailer
   boilerplate suffixes stripped). No auto-submit — user confirms threshold.
5. **iOS limitation documented, not fought:** iOS Safari PWAs don't support
   share_target. Android-first; an iOS Shortcut hitting `/add?url=` is a
   possible later workaround, out of scope.

### Architecture

Client-only (no server changes): manifest entry; new authed route `/share`
(login redirect must preserve the query string — verify the existing redirect
plumbing does); AddTracker accepts prefill params. Service worker: confirm
`/share` navigations are network-first/not cached stale. Note: manifest changes
propagate on the PWA's next SW update — installed apps may need a
close-reopen before the share sheet shows the app.

### Testing

Unit: URL-extraction precedence + title cleanup. Acceptance (Andy, phone):
share from mobile Chrome and from the Amazon app; verify dedup path and login
round-trip. Browser smoke on prod.

**Estimate:** half a session. Bolt-on candidate to ship right after Phase 1.

---

## Phase 3 — Weekly digest

### Goal

A once-a-week summary that catches slow rot the instant-alert system
structurally misses: silent failures, stale thresholds, unbought wins.

### Decisions

1. **Per-user settings** (existing `settings` key/value store):
   `digest_enabled` (default `true`), `digest_channel` (explicit, else first
   configured of ntfy → discord → email → webhook), `digest_day` (0–6, default
   0 = Sunday), `digest_hour` (0–23 server TZ America/Chicago, default 8),
   `digest_last_sent_at` (idempotency).
2. **Sections** (skip empty sections; skip the whole digest when empty unless
   `digest_always=true`):
   - Biggest drops this week (top 5 by % on daily-min basis)
   - Record lows hit (from `notifications` where `alert_type LIKE 'low_%'`)
   - Needs attention: error/blocked/auto-paused sellers + days since last OK
   - Stale thresholds (Phase-1 detector)
   - Unclaimed wins: threshold met in last 30d, no purchase logged, still active
   - Footer: active/paused counts, checks run this week
3. **One channel per user in v1.** Digest sends log a `notifications` row with
   `alert_type='digest'` (visible in alert history).

### Architecture

Hourly node-cron job: for each eligible user, `now` matches day+hour AND
`digest_last_sent_at` > 6 days ago → build + send + stamp. Pure content
builder `server/src/digest/build.ts` (tested with fixture data); renderers:
markdown-ish text (ntfy/discord/webhook) + minimal HTML (email); delivery
through the existing channel senders.

### Testing

Unit: builder sections + empty-skip logic + channel fallback order.
Integration: idempotency across restarts (stamp honored). Manual: force-send
to Andy's ntfy once (`digest_last_sent_at` reset), eyeball formatting.

**Estimate:** one session. No UI work beyond a Settings block.

---

## Phase 4 — Back-in-stock alerts

### Goal

Track availability as a first-class signal; alert on restock with price.
Also fixes a real current defect: an out-of-stock Amazon item today walks the
consecutive-failures path and eventually **auto-pauses**, killing exactly the
tracker you most want alive for the restock moment.

### Decisions

1. **Positive signals only.** JSON-LD `offers.availability`
   (InStock/LimitedAvailability → `in_stock`; OutOfStock/SoldOut/Discontinued
   → `out_of_stock`); Amazon "Currently unavailable" special case →
   `out_of_stock`. A scrape *failure* NEVER implies OOS; no signal →
   availability unchanged.
2. **OOS is healthy, not an error:** an OOS scrape records no price row,
   resets `consecutive_failures`, keeps status `active`. (Behavior change from
   today's Amazon-unavailable path — this is the defect fix.)
3. **Alert on `out_of_stock` → `in_stock` only** (`alert_type='back_in_stock'`,
   "Back in stock at $X — Amazon"), through normal cooldown/confidence gates.
   Going OOS just sets a badge (v1) — no alert, no setting.
4. **Transitions require a known prior state** — `unknown` → anything is
   silent state adoption.

### Architecture

- **Migration (v21+):**
  `ALTER TABLE tracker_urls ADD COLUMN availability TEXT NOT NULL DEFAULT 'unknown'
  CHECK(availability IN ('unknown','in_stock','out_of_stock'))` +
  `availability_changed_at TEXT`. (Per-URL ⇒ no extension parity impact.)
- Extractor returns `{price?, availability?}`; strategies contribute
  availability where structured data provides it.
- Pipeline: state-adopt/transition logic beside the price path; restock alert
  reuses fan-out.
- Client: per-seller OOS badge on TrackerDetail + card-level badge when ALL
  sellers are OOS; digest gains a restock line.

### Testing

Unit: signal mapping (each schema.org value), transition matrix
(unknown/in/out × signal), failure-≠-OOS. Integration: Amazon-unavailable no
longer increments failures. Fixture-page scrape test. Browser smoke.

**Estimate:** one session.

### Phase 2 addendum (2026-07-24): the iOS path

Andy (and likely the whole household) is on iPhone, where share_target will
never appear. The equivalent flow on iOS is a one-time Shortcut, since
`/share` is just a URL:

1. Shortcuts → new shortcut → ⓘ → **Show in Share Sheet**, receive **URLs and Text**
2. Action **Get URLs from Input** — REQUIRED. Without it, Safari shares its
   page as full page TEXT (nav, prices, footer — no link), and /share
   correctly reports nothing to track. Field-debugged 2026-07-23 via the NPM
   access log for proxy-host-11: Andy's first attempt arrived as ~4 KB of
   store.ui.com page text with zero URLs in it. This action coerces a Safari
   page share to its URL and extracts links from text shares.
3. Action **URL Encode** (encodes the extracted URL)
4. Action **Text**: `https://prices.schultzsolutions.tech/share?text=` + *URL Encoded Text*
5. Action **Open URLs**; name it "Track Price"

Share → Track Price then behaves identically to the Android path (dedup jump
or prefilled add). The `text=` param is used on purpose — it survives apps
that wrap the link in prose, which `extractSharedUrl` handles.
