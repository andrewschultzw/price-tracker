# AI Buyer's Assistant Design

**Date:** 2026-05-04
**Status:** Approved
**Author:** Andrew Schultz + Claude

## Overview

Price Tracker today renders price history. It does not tell the user what to do with that history. This change layers a Claude-powered advisor over the existing data: every tracker gets a `BUY` / `WAIT` / `HOLD` verdict pill, every alert gets a one-line AI commentary appended to the existing channel template, and TrackerDetail gains a multi-sentence price-history narrative. The AI feature is purely additive: scrape, alert, and dashboard reliability are unchanged when Claude is unavailable.

The defining design principle is **rules judge, LLM narrates**. Deterministic code computes structured signals from price history (current percentile, vs-all-time-low ratio, dwell behavior, fake-MSRP detection, etc.) and maps those signals to one of three verdict tiers via a pure rule tree. Claude's only job is to compose the natural-language prose around the signals it is given. Claude never decides the tier and never invents facts not present in the signal payload — the cached system prompt explicitly forbids it. This eliminates the "the LLM said something wrong" failure mode that kills user trust on day one.

## Decisions

- **Capabilities in v1 (three of four).** Smarter alert copy, verdict pill on tracker cards, price-history summary on TrackerDetail. The fourth capability from brainstorming — review digest at tracker creation — is deferred to v2; it requires a separate review-extraction problem (each retailer's review markup) that is out of scope.
- **Model.** Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) with prompt caching. Estimated cost: ~$0.20/month at current scale (~600 calls/month).
- **Cadence.**
  - Verdict pill: regenerated when `last_price` changes (price-change-driven).
  - Alert copy: generated synchronously inside `firePriceAlerts` with a hard 3-second timeout; on timeout or failure, the alert dispatches with the existing plain template.
  - Price-history summary: regenerated weekly per tracker via a nightly backfill cron, *or* on-demand the first time the user opens TrackerDetail past the staleness threshold.
- **Authority pattern.** Rules-based deterministic verdict tier; LLM-composed prose. The verdict logic is a pure function with full unit-test coverage. Claude receives the tier, the dominant reason key, and the structured signals object — and is instructed to reference only those exact values.
- **Verdict states.** Three: `BUY` (green), `WAIT` (amber), `HOLD` (slate). Resolution lives in the prose, not in the pill — `"BUY — strongest deal in 14 months"` and `"BUY — at 30-day low, modest deal"` use the same pill but differ in the words underneath.
- **Failure philosophy.** AI is decoration, never infrastructure. Claude failures never block scrapes, alerts, or page loads. Stale verdicts stay on screen; alerts fall back to plain copy; nothing the user sees breaks when the API is down. The existing 184-test scrape/notify reliability bar is unchanged.
- **Architecture.** Inline async fire-and-forget on the scrape pipeline, plus a nightly backfill cron for summaries. No new job queue, no new worker process. Promotable to a queue later if volume warrants it (it almost certainly will not at this scale).
- **History window.** Multi-window signals (vs all-time, vs 90d, vs 30d). New trackers with `<14 days` of price history are pinned to `HOLD` with reason `gathering_data`. The pill renders blank for these (no `gathering_data` chip — keeps the dashboard quiet for new trackers).
- **AI is opt-in via env.** Single `AI_ENABLED` env var defaulting to `false` for the initial deploy. Flipped to `true` after manual sanity-check on a single tracker. UI gracefully degrades when off.

## Architecture

### New module map

| Path | Purpose | Talks to Claude? |
|---|---|---|
| `server/src/ai/client.ts` | Thin Anthropic SDK wrapper. Model selection (Haiku 4.5), prompt caching, retry/backoff, length validation, env config (`ANTHROPIC_API_KEY`, `AI_ENABLED`). | yes — only module that does |
| `server/src/ai/signals.ts` | Pure: `computeSignals(priceHistory, currentPrice, threshold) → Signals \| null`. Returns `null` when data is too sparse. | no |
| `server/src/ai/verdict.ts` | Pure: `signalsToVerdict(signals) → { tier, reasonKey }`. Deterministic rule tree; cannot fail. | no |
| `server/src/ai/prompts.ts` | Builders for `verdict`, `summary`, `alertCopy` prompts. Stable cached system blocks + small variable user blocks. | no |
| `server/src/ai/generators.ts` | Orchestrators: `generateVerdictForTracker(id)`, `generateSummaryForTracker(id)`, `generateAlertCopy(ctx)`. Composes signals + prompts + client; only place that mutates `ai_*` columns. | indirectly via `client.ts` |
| `server/src/ai/backfill-cron.ts` | Nightly sweep at 03:00 — refreshes summaries older than 7 days; retries verdicts marked stale (high failure count). | indirectly |

### Modified modules

- `server/src/scheduler/cron.ts`
  - After successful scrape detects a price change: fire-and-forget `generateVerdictForTracker(id)` (non-awaited).
  - Inside `firePriceAlerts`, after the cooldown gate, before per-channel fanout: `Promise.race(generateAlertCopy(ctx), 3sTimeout)` → result passed into each channel's payload builder.
  - Registers `backfill-cron.ts` to run nightly at 03:00.
- `server/src/db/queries.ts` — read/write helpers for the new AI columns.
- Migration v7 — adds the AI columns to `trackers`.
- `server/src/routes/trackers.ts` — includes `ai_*` fields in tracker payloads.
- `server/src/routes/health.ts` — exposes new admin-only AI observability fields.
- Channel renderers (`notifications/discord.ts`, `notifications/ntfy.ts`, `notifications/email.ts`, `notifications/webhook.ts`) — accept optional `aiCommentary` and render conditionally.
- `client/src/components/TrackerCard.tsx` — verdict pill next to current price.
- `client/src/pages/TrackerDetail.tsx` — new "AI Insights" card section above the chart.

### Boundaries

- `signals.ts` and `verdict.ts` are pure with zero IO — fully unit-testable without ever invoking Claude.
- `client.ts` is the only Claude-aware module. Mockable in tests via dependency injection in `generators.ts`.
- `generators.ts` is the only writer of `ai_*` columns. Single auditable mutation point.
- All AI code lives under `server/src/ai/`. Disabling the feature is `AI_ENABLED=false` + restart; deleting the feature is `rm -rf server/src/ai/` plus reverting the cron-call sites.

### Data flow on price change

```
scrape succeeds
    ├─→ price stored in price_history (existing path, unchanged)
    ├─→ tracker_urls.last_price updated (existing)
    ├─→ refreshTrackerAggregates() (existing)
    └─→ if price changed:
            ├─→ firePriceAlerts() (existing path)
            │       │
            │       └─→ before each channel dispatch:
            │             Promise.race(generateAlertCopy(ctx), 3000ms)
            │             on null/error: dispatch with plain template
            │
            └─→ fire-and-forget generateVerdictForTracker(id)
                    ├─ load price_history (last 365d)
                    ├─ computeSignals() — pure
                    ├─ signalsToVerdict() — pure → { tier, reasonKey }
                    ├─ buildVerdictPrompt(signals, tier, reasonKey)
                    ├─ client.ts → Claude (Haiku, cached system block)
                    ├─ on success: UPDATE trackers SET ai_verdict_*
                    └─ on failure (after 1 retry):
                          - log structured error
                          - increment ai_failure_count
                          - leave previous values intact
                          - admin metric exposed via /api/health
```

## Data model

### Migration v7 — new columns on `trackers`

| Column | Type | Default | Purpose |
|---|---|---|---|
| `ai_verdict_tier` | TEXT | NULL | `'BUY'` \| `'WAIT'` \| `'HOLD'` \| `NULL` |
| `ai_verdict_reason` | TEXT | NULL | one-sentence Claude-generated prose |
| `ai_verdict_reason_key` | TEXT | NULL | enum identifying the dominant signal that drove the tier |
| `ai_verdict_updated_at` | INTEGER | NULL | unix ms |
| `ai_summary` | TEXT | NULL | multi-sentence price-history narrative |
| `ai_summary_updated_at` | INTEGER | NULL | unix ms |
| `ai_signals_json` | TEXT | NULL | snapshot of signals at time of verdict — audit trail |
| `ai_failure_count` | INTEGER | 0 | consecutive failures since last success; resets on success |

No new tables. Verdict history is *not* preserved (latest-only); a `tracker_ai_history` table is a future option if we want "verdict over time" charts.

Alert copy is generated per-dispatch and *not* stored on the `notifications` rows — it is ephemeral. (Open question for v2: should the Notifications page show "what Claude said"? If yes, add `ai_commentary` column to `notifications`.)

### Signals shape

```ts
interface Signals {
  // data sufficiency
  data_days: number              // span of history available
  data_points: number            // observation count

  // price position
  current_price: number
  all_time_low: number
  all_time_high: number
  current_percentile: number     // 0-1, percentile across all observations

  // window comparisons (ratios; 1.0 means "at the window low")
  vs_30d_low: number
  vs_90d_low: number
  vs_all_time_low: number
  vs_all_time_high: number       // small drop → fake-MSRP markup

  // recency
  days_since_all_time_low: number | null
  days_at_current_or_lower: number

  // dwell behavior
  times_at_or_below_current: number
  avg_dwell_days_at_low: number | null

  // direction
  trend_30d: 'falling' | 'flat' | 'rising'
  consecutive_drops: number

  // user-relative
  threshold: number | null
  pct_below_threshold: number | null

  // cohort (reuses existing community-low feature from migration v6)
  community_low: number | null
  vs_community_low: number | null
}
```

Multi-seller-aware: signals are computed against the tracker's *aggregate* price (lowest across sellers, the price the user actually sees) over time, not against any single seller's history.

### Verdict rules

```
if data_days < 14:
    return { tier: 'HOLD', reasonKey: 'gathering_data' }

// strong BUY
if vs_all_time_low <= 1.02:
    return { tier: 'BUY', reasonKey: 'at_all_time_low' }
if current_percentile <= 0.10 and data_days >= 30:
    return { tier: 'BUY', reasonKey: 'in_bottom_decile' }
if pct_below_threshold >= 5 and vs_30d_low <= 1.00:
    return { tier: 'BUY', reasonKey: 'below_threshold_at_window_low' }

// WAIT
if vs_all_time_high <= 1.05 and current_percentile >= 0.80:
    return { tier: 'WAIT', reasonKey: 'fake_msrp_or_near_high' }
if trend_30d == 'rising' and current_percentile >= 0.70:
    return { tier: 'WAIT', reasonKey: 'rising_trend' }

// soft BUY
if vs_30d_low <= 1.02:
    return { tier: 'BUY', reasonKey: 'at_30d_low' }

return { tier: 'HOLD', reasonKey: 'no_notable_signal' }
```

`reasonKey` enum values: `gathering_data`, `at_all_time_low`, `in_bottom_decile`, `below_threshold_at_window_low`, `fake_msrp_or_near_high`, `rising_trend`, `at_30d_low`, `no_notable_signal`.

The reason key feeds two consumers: (1) the prompt builder, telling Claude which angle to lead with; (2) the UI, allowing future iconography or filtering.

## Prompts

All three prompts use Anthropic prompt caching with a stable system block (instructions, tone, tier definitions, reason-key glossary, "no fact invention" rule, max length) and a small variable user block (the per-call signals + tier).

| Prompt | Variable block | Output |
|---|---|---|
| `buildVerdictPrompt` | `{ signals, tier, reasonKey }` | one sentence, ≤150 chars |
| `buildSummaryPrompt` | `{ signals, recent_observations: [...] }` (last ~30 data points, downsampled if needed) | 2-4 sentences, ≤400 chars |
| `buildAlertCopyPrompt` | `{ tracker_name, old_price, new_price, signals, reasonKey }` | one sentence, ≤120 chars |

### Hallucination guard

The cached system block explicitly states: "every claim in your output must correspond to a value present in the signals object — do not invent percentile rankings, time windows, or comparisons not provided." We pass exact numbers; Claude composes prose around them. Combined with length validation in `client.ts`, this is the primary defense against the "Claude said the wrong number" failure mode.

### Validation

`client.ts` rejects outputs that:
- Exceed the length limit
- Are empty after whitespace trim
- Contain banned phrases (TBD short list — e.g., "I cannot", "as an AI")

On rejection: retry once with a "be shorter" prompt nudge; on second invalid output, treat as failure.

### Cost estimate

Haiku 4.5 with prompt caching:
- Cached input: ~$0.10/MTok
- Output: ~$5/MTok
- Per call: ~500 input tokens (mostly cached) + ~50 output tokens → roughly $0.0003
- ~600 calls/month → **~$0.20/month**

Even if the estimate is 5× off, monthly cost stays under $1.

## UI

### TrackerCard — verdict pill

Inline with the current price. Compact, color-coded chip with the tier text. Tooltip on hover/tap shows the AI reason. No pill rendered when `ai_verdict_tier IS NULL` (gathering-data state shows nothing — keeps cards quiet for new trackers).

```
┌──────────────────────────────────────────┐
│ Samsung 990 Pro 4TB                      │
│ $279.00  [BUY]   ↓ from $349.99          │
│ ▁▂▃▂▁▂▃▂▁▁▂▃▂▁▁▂▃▂                       │
│ 2 sellers · checked 12m ago              │
└──────────────────────────────────────────┘
```

Color tokens (matching existing design system):
- `BUY` — `bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20`
- `WAIT` — `bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20`
- `HOLD` — `bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20`

### TrackerDetail — AI Insights card

New card directly below the page header, above the existing stat tiles. Three rows:

```
┌─────────────────────────────────────────────────────┐
│  [BUY]   Updated 4h ago                   [Refresh] │
│                                                     │
│  At the all-time low — last hit this price 3 months │
│  ago and stayed for ~4 days before rebounding.      │
│                                                     │
│  This product has bounced between $279 and $389     │
│  over the last 9 months. Current price matches the  │
│  all-time low set in February. Past visits to this  │
│  level lasted 3-5 days on average. The $399 listed  │
│  MSRP is consistent — this is a real discount, not  │
│  inflated baseline pricing.                         │
└─────────────────────────────────────────────────────┘
```

- Top row: large verdict pill + "Updated [relative time]" + admin-only "Refresh" button
- Middle row: `ai_verdict_reason` (medium font, semibold)
- Bottom row: `ai_summary` (smaller font, italic, lighter weight)

Refresh button is gated on `req.user.is_admin` for v1 — a manual regeneration tool for the operator. Not exposed to regular users.

If `ai_summary IS NULL` but `ai_verdict_*` is populated, only the top two rows render.

## Alert copy integration

Inside `firePriceAlerts`, after the cooldown gate but before the per-channel fanout:

```ts
const aiCommentary: string | null = await Promise.race([
  generateAlertCopy({ tracker, oldPrice, newPrice, signals, reasonKey }),
  new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
]).catch(() => null);
```

`aiCommentary` is then passed into every channel's payload builder:

- **Discord** — appended to embed description, blank-line separator
- **ntfy** — appended to message body
- **Email** — appended to HTML body and plaintext body; subject stays clean
- **Webhook** — included as `ai_commentary` JSON field (consumer-opt-in)

Existing channel tests continue to pass with `aiCommentary: null` since each builder treats it as optional. The change is strictly additive in the alert payload.

## Error handling

| Failure | Behavior | User impact |
|---|---|---|
| Claude API timeout / 5xx / rate limit | `client.ts` retries once with exponential backoff; on second failure throws `AIGenerationError`. `generators.ts` catches, increments `ai_failure_count`, logs structured error, does NOT touch the AI columns. | None — stale verdict shown |
| Claude returns oversized / empty / banned-phrase output | `client.ts` validates, retries once with "be shorter" nudge; on second invalid, treats as failure | None |
| Signals computation fails (sparse data) | `signals.ts` returns `null`; generators skip Claude entirely | Tracker shows no pill |
| Verdict logic fails | Cannot fail by construction — every rule branch ends in a defined `{ tier, reasonKey }` | n/a |
| DB write fails after Claude succeeds | Logged, surface in `/api/health`. Next refresh retries. | None — stale until next refresh |
| Alert copy 3s timeout | `Promise.race` resolves to `null`; channels dispatch with plain template; structured log + metric | Plain alert delivered |
| Anthropic key missing/invalid | Startup check in `client.ts`. Production: log fatal, set `AI_ENABLED=false` implicitly. Dev: throw at startup. | No pills anywhere |
| `AI_ENABLED=false` kill switch | Generators short-circuit. Zero Claude calls, zero DB writes. | Same as missing key — graceful degradation |

## Observability

New admin-only fields on `/api/health`:

- `ai_enabled: boolean`
- `ai_verdict_failures_24h: number`
- `ai_summary_failures_24h: number`
- `ai_alert_copy_timeouts_24h: number`
- `ai_avg_latency_ms_24h: number`
- `ai_cache_hit_rate_24h: number` (from Anthropic response metadata)

Structured logs at every Claude call with: `tracker_id`, `prompt` (`verdict` | `summary` | `alert`), `model`, `input_tokens`, `output_tokens`, `cached_tokens`, `latency_ms`, `status`. Never log raw signals or prompts at info level (volume + future privacy concern if user data ever lands in signals).

## Testing

| Layer | File | Approx tests |
|---|---|---|
| Pure signals math | `signals.test.ts` | ~25 — every computation, sparse-data edges, multi-seller aggregation |
| Pure verdict logic | `verdict.test.ts` | ~20 — every rule branch + boundary + reason-key correctness |
| Prompt construction | `prompts.test.ts` | ~10 — cache marker present, variable-block serialization, system-block snapshot |
| Generators (mocked Claude) | `generators.test.ts` | ~15 — success writes, failure counter, length validation, empty-output rejection |
| Cron integration (in-memory SQLite + mocked Claude) | `cron-ai.test.ts` | ~10 — fire-and-forget doesn't block scrape, backfill skips fresh, retries stale |
| Channel rendering with AI copy | extends existing `email.test.ts`, `discord.test.ts`, etc. | ~8 — each channel renders with and without `aiCommentary` |
| Real-Claude smoke (gated on env) | `npm run ai-smoke` | manual, pre-deploy |

Target: **~85 new tests**. Server suite goes from 172 → ~257.

## Rollout

1. **Migration v7** runs on deploy. All AI columns exist, all NULL. Zero behavior change.
2. **Code merged with `AI_ENABLED=false`** in `.env.production`. AI module exists but no calls happen, no UI surfaces render.
3. **Flip flag on a single tracker first** (manual override during dev) — generate verdict + summary, eyeball the output for tone, accuracy, hallucination.
4. **Flip global flag.** Verdicts populate naturally as price changes happen. Backfill cron fills summaries overnight.
5. **Monitor `/api/health`** for 24-48 hours. If failure rate spikes, flip flag off and dig in.

Rollback: flip the env flag, restart the systemd unit, AI calls stop. UI gracefully shows no pills (existing fallback behavior).

## Out of scope for v1

Deferred to v2 if v1 lands well:

- Verdict history table (snapshot every change for "verdict over time" charts)
- Per-user prompt-tone preferences ("terse" / "verbose" / "aggressive")
- Tunable verdict-rule thresholds via Settings UI
- Alert commentary stored on `notifications` rows (Notifications page shows "what Claude said")
- Multi-language output
- Review digest at tracker creation (the fourth capability from brainstorming — needs separate review-extraction work)

## Open questions

- **Banned-phrase list for output validation.** Need a short list — e.g., `"I cannot"`, `"as an AI"`, anything that would tell the user there's an LLM behind the curtain. To be finalized during implementation.
- **Backfill cadence for summaries.** Spec says weekly; could be biweekly to halve cost. Decide during rollout based on observed staleness vs. cost.
- **TrackerDetail "Refresh" button — admin-only or per-user?** Admin-only for v1; reconsider if regular users start asking for it.
