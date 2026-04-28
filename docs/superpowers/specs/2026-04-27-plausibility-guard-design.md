# Plausibility-Guarded Alert Path — Design

**Status:** Spec, awaiting implementation
**Date:** 2026-04-27
**Author:** Andrew Schultz (with Claude)
**Related:** PR #8 (`fix(scrape): bypass page-wide regex fallback on Amazon hosts`)

## Background

On 2026-04-27, five false price-drop Discord alerts fired across trackers 17, 18, 22, 24, 26 — all Amazon hosts (`amazon.com`, `a.co`, `amzn.to`). Investigation traced the root cause to the page-wide regex strategy in `server/src/scraper/strategies/regex.ts`: when all structured strategies (`json-ld` / `microdata` / `opengraph` / `css-patterns`) returned null on Amazon pages with a degraded layout (bot-challenge, sparse short-link preview, layout drift), the regex's frequency-mode tiebreaker reliably selected `$10` from coupon, financing, and rewards copy ("Save $10 with coupon", "as low as $10/mo with Affirm", etc.).

PR #8 fixes the immediate root cause by skipping the regex fallback for Amazon hosts. This spec adds **defense-in-depth**: even if a future failure mode produces a wrong-but-plausible price (e.g. regex returning `$25` from "Free shipping over $25" copy on a non-Amazon retailer), the system never fires a Discord alert without independent confirmation.

## Goals

1. Suppress alerts whose price looks implausibly far below the tracker's recent norm.
2. Still fire alerts for genuine large drops, with at most ~5 minutes of added latency.
3. Keep `price_history` honest (record both suspicious and confirmed values, so charts reflect reality).
4. Never need to be configured per-tracker — a single global threshold ships sane defaults.
5. Restart-safe: a service restart mid-confirmation doesn't lose the pending check.

## Non-Goals

- Not a replacement for fix #1 (PR #8) — they are complementary.
- Not a UI feature in v1. Pino logs only; UI affordances are a follow-up.
- Not per-tracker tunable in v1. YAGNI; can be added later if needed.
- Not a generic anomaly detector — only triggers on prices that would have fired an alert.

## Detection Signal

`isPlausibilityGuardSuspicious(price, sellerId): boolean`

- Pull last 10 successful `price_history` entries for the given `tracker_url_id`.
- **Warm path** (`>= 5` entries): compute median; flag suspicious if `price < median * DROP_THRESHOLD`.
- **Cold-start path** (`1–4` entries): flag suspicious if `price < last_price * DROP_THRESHOLD`.
- **Empty path** (`0` entries): never suspicious. Brand-new trackers get the benefit of the doubt.

`DROP_THRESHOLD` defaults to `0.50` (any new value below 50% of the median is suspicious). Configured via env var `PLAUSIBILITY_GUARD_DROP_THRESHOLD`. Setting it to `0` disables the guard entirely.

The window of 10 entries balances signal stability against responsiveness to legitimate price trends. The cold-start cutoff at 5 prevents single-sample medians from being noisy.

## Trigger Condition

The guard runs only when an alert *would otherwise fire*, namely when all of these hold:
- `price <= tracker.threshold_price`
- The per-(tracker, seller) cooldown is clear (`getLastNotificationForSeller`).
- At least one notification channel is configured.

Suspicious-but-above-threshold scrapes are still recorded but skip the guard entirely — there's nothing to suppress.

## Schema Change — Migration v7

Add two columns to `tracker_urls`:

```sql
ALTER TABLE tracker_urls ADD COLUMN pending_confirmation_price REAL;
ALTER TABLE tracker_urls ADD COLUMN pending_confirmation_at TEXT;
```

Both NULL when no confirmation is in flight. `pending_confirmation_at` is an ISO-8601 datetime (matches the format used elsewhere in the schema, e.g. `created_at`, `last_checked_at`).

## Flow

```
scrape completes → write price_history row → check alert conditions
                                                   │
                                                   ▼
                              price <= threshold AND not on cooldown? AND channels configured?
                                                   │ yes
                                                   ▼
                                       isPlausibilityGuardSuspicious()?
                                                   │
                                            ┌──────┴──────┐
                                          yes             no
                                            │             │
                                            ▼             ▼
                       pending_confirmation_at set?    fire alert (existing path)
                                  │
                          ┌───────┴───────┐
                        no              yes
                          │               │
                          ▼               ▼
            set pending_confirmation_*    is the new scrape ALSO suspicious AND below threshold?
            enqueue 90s+jitter rescan,            │
            suppress alert,             ┌─────────┴─────────┐
            log "awaiting confirmation" yes                no
                                          │                 │
                                          ▼                 ▼
                              clear pending_*,   clear pending_*,
                              fire alert,         log "transient anomaly,
                              log "confirmed"     alert suppressed"
```

## Confirmation Re-Scrape

- Enqueued via the existing `p-queue` (concurrency 2). One-time `setTimeout` of `90s + jitter(0–90s)` defers the request enough to defeat anti-replay caching while keeping legit alert latency under ~5 min.
- Confirmation scrape uses the same `extractPrice()` pipeline. `ScrapeError` propagates as in any other scrape — increments `consecutive_failures` and feeds the existing error-alert path.
- **If confirmation throws:** keep `pending_confirmation_*` set, log it, and let the *next regular cron tick* serve as a fallback confirmation. Never auto-alert without a successful matching read. There is no retry counter — confirmations naturally clear when a successful read either confirms or refutes.
- **If confirmation succeeds but price went back to normal:** log "transient anomaly," clear `pending_*`, no alert. The user gets a chart dip but no notification. This is the intended behavior — flash sales that reverse within 90s are too short to act on.

## What Counts as "the Confirmation"

A confirmation is **any successful scrape** for the affected `tracker_url_id` while `pending_confirmation_at` is non-NULL — whether that scrape was the explicit `setTimeout`-based re-scrape, a regular cron tick, or a manual "Check Now" from the UI. Each successful scrape evaluates the new price against the suspiciousness check and resolves the flag accordingly. This makes the system idempotent: redundant scrapes are harmless, and lost timers are recovered automatically by the next regular tick.

A *failed* scrape (any `ScrapeError` or thrown exception) does not resolve the pending flag — the price hasn't been observed.

## Restart Safety

On service start, the scheduler scans `tracker_urls WHERE pending_confirmation_at IS NOT NULL`:

- If `pending_confirmation_at` is older than `10 min`: immediately enqueue a confirmation scrape (the `setTimeout` was lost on restart).
- If younger: do nothing — the next regular cron tick (which runs every minute) will satisfy the pending flag if it scrapes this `tracker_url_id`. We do not try to reconstruct the lost in-process `setTimeout`. Worst case: the user waits up to one extra minute for the alert.

## Observability

Pino log lines at every transition (structured):

| Event | Level | Message | Fields |
|-------|-------|---------|--------|
| Suspicious scrape, first detection | `info` | `Suspicious price detected, awaiting confirmation` | `trackerId`, `sellerId`, `price`, `medianBaseline`, `threshold` |
| Confirmation matched | `info` | `Confirmation matched, firing alert` | `trackerId`, `sellerId`, `firstPrice`, `secondPrice` |
| Confirmation diverged | `warn` | `Confirmation diverged, alert suppressed` | `trackerId`, `sellerId`, `firstPrice`, `secondPrice`, `medianBaseline` |
| Confirmation errored | `warn` | `Confirmation scrape errored, will retry on next regular tick` | `trackerId`, `sellerId`, `err` |
| Recovery from restart | `info` | `Re-enqueueing stale pending confirmation after restart` | `trackerId`, `sellerId`, `pendingPrice`, `pendingAgeMs` |

No UI changes in v1.

## Configuration

Single env var:

```
PLAUSIBILITY_GUARD_DROP_THRESHOLD=0.50  # default; set to 0 to disable
```

Hardcoded constants (promote to env if a tuning need ever appears):

- `PLAUSIBILITY_GUARD_MEDIAN_WINDOW = 10` — last N price_history entries used for median
- `PLAUSIBILITY_GUARD_COLD_START_CUTOFF = 5` — minimum entries to use median path
- `PLAUSIBILITY_GUARD_CONFIRM_DELAY_MS = 90_000` — base confirmation delay
- `PLAUSIBILITY_GUARD_CONFIRM_JITTER_MS = 90_000` — additional uniform jitter
- `PLAUSIBILITY_GUARD_RESTART_AGE_MS = 600_000` — pending older than this is considered stale on startup

## Tests

**Unit (`isPlausibilityGuardSuspicious`):**
- Empty history → not suspicious.
- Cold-start (1 entry, last_price=$100, new=$40) → suspicious (40 < 50).
- Cold-start (1 entry, last_price=$100, new=$60) → not suspicious.
- Warm (10 entries median=$100, new=$40) → suspicious.
- Warm (10 entries median=$100, new=$70) → not suspicious.
- Warm with internal volatility (median still steady) → median is robust, drop still flagged.

**Integration (alert path in `cron.ts`, with a stub price provider):**
- Suspicious scrape, no pending → `pending_*` is set, no alert fires, log line emitted.
- Confirmation matches → `pending_*` cleared, alert fires.
- Confirmation diverges (back to normal) → `pending_*` cleared, no alert.
- Confirmation throws ScrapeError → `pending_*` stays set, no alert.
- Service restart with old `pending_*` → confirmation re-enqueued at startup.
- Cooldown active → guard does not run, alert is suppressed by the existing cooldown mechanism (no double-suppression).

## Out of Scope (Possible Follow-Ups)

- UI affordance for "pending confirmation" state on tracker detail page.
- Per-tracker threshold override (e.g. items with high volatility might want a tighter threshold).
- Multi-confirmation requirement (require 2+ matching follow-ups for huge drops).
- Surface suppressed events in a dashboard tile or admin endpoint.

## Migration & Rollout

1. Schema migration v7 is additive (new nullable columns) — safe to deploy with running service.
2. Feature is on by default with `DROP_THRESHOLD = 0.50`. Can be disabled by setting env to `0` if it ever causes problems.
3. Deploy via existing `scripts/deploy.sh` workflow (rsync + `rebuild.sh` on CT 302).
4. Backfill: not needed. Existing trackers get the guard from their next alert-eligible scrape.
