# Confidence-Scored Alerts — Design Spec

**Date:** 2026-05-06
**Status:** Approved (rolling into implementation)
**Branch:** `feature/confidence-scored-alerts`

## Goal

When a price alert fires, tell the user *how rare this deal is*. Today every alert just says "$279 — Samsung 990 Pro 4TB"; the user has no way to distinguish "12-month low, first time we've seen this" from "this happens every other Tuesday." Adding a confidence score (HIGH/MEDIUM/LOW) plus 1-2 supporting facts to every alert turns the firehose into a signal — replaces gut-feel with data on every alert.

## Non-goals (v1)

- New verdict tiers — the existing BUY/WAIT/HOLD verdict is unchanged
- Confidence-aware suppression — every alert still fires; LOW alerts just look different
- Channel-specific config (some users want LOW alerts, some don't)
- Confidence on basket-alert path — v1 covers per-tracker price alerts only

## Architecture

Pure deterministic layer on top of the existing `computeSignals` engine. **No API cost — works whether `AI_ENABLED` is on or off.** When AI IS on, the confidence facts get injected into the alert-copy prompt as cached context so Claude can reference them naturally.

```
computeSignals (existing)
    │
    ▼
computeConfidence (NEW — server/src/ai/confidence.ts)
    │ returns { level: 'HIGH' | 'MEDIUM' | 'LOW', reasons: string[] }
    ▼
firePriceAlerts (existing — cron.ts)
    │ injects into per-channel send fns + AI alert-copy prompt
    ▼
per-channel templates render confidence prefix/badge
```

## Confidence levels

**HIGH** (rare deal, signal-worthy):
- `current_percentile <= 0.10` (current price is in lowest 10% of dataset) AND
- `times_at_or_below_current <= max(3, data_points * 0.05)` (rare in absolute count)

**MEDIUM** (cheap but not unprecedented):
- `current_percentile <= 0.25` AND not HIGH

**LOW** (common price):
- anything else

## Reason templates

Generate at most 2 short reasons per alert from this priority-ordered list (first 2 that match):

1. **All-time low** — `vs_all_time_low === 1.0` → "all-time low"
2. **12-month low** — `vs_all_time_low === 1.0 AND data_days >= 365` → "12-month low" (replaces #1 when both apply)
3. **30-day low** — `vs_30d_low === 1.0` → "30-day low"
4. **Rare in dataset** — `times_at_or_below_current <= 3` → "3rd time at this price" (or "1st time", etc.)
5. **Percentile statement** — `current_percentile <= 0.10` → "top 10% lowest in dataset"
6. **Days since ATL** — `days_since_all_time_low > 60` → "first time below $X in 4+ months"
7. **Average dwell** — `avg_dwell_days_at_low !== null` → "typically holds ~5 days"

## Per-channel rendering

| Channel | Format |
|---|---|
| **Discord** | Embed title gets prefix `🟢 STRONG BUY` (HIGH) / `🟡 GOOD DEAL` (MEDIUM) / no prefix (LOW). Reasons appended to embed description on a new line: `12-month low · typically holds ~5 days` |
| **ntfy** | Title prefix `[STRONG]` / `[GOOD]` / no prefix. Body adds reasons on new line. |
| **Email** | Subject prefix `[Strong Buy]` / `[Good Deal]` / no prefix. Body adds an "About this deal" line with reasons. |
| **Webhook** | Adds top-level `confidence: {level, reasons}` to JSON payload. No formatting change to existing fields. |
| **Web Push** | Body line prefix `🟢 ` / `🟡 ` / no prefix. Reasons appended after the existing `aiCommentary` (if present), separated by ` · ` |

LOW alerts get no prefix or emoji — they look like today's alerts. Reasons still get rendered (gives the user the "why this isn't special" context).

## AI integration

The existing AI alert-copy prompt builder (`buildAlertCopyPrompt` in `prompts.ts`) gets `confidence` injected into the cached signals block so Claude can reference it. Example narration: "Strong buy — Samsung 990 Pro at 12-month low, first time in 4 months."

Cost impact: zero new tokens. Confidence facts are already in the cached block; we just add 2-3 fields.

## Files modified or created

- **Create** `server/src/ai/confidence.ts` — pure `computeConfidence(signals): { level, reasons }`
- **Create** `server/src/ai/confidence.test.ts` — unit tests (cover all 3 levels + each reason template + reason ordering)
- **Modify** `server/src/scheduler/cron.ts` — `firePriceAlerts` computes confidence once, passes to each channel + AI prompt
- **Modify** `server/src/notifications/discord.ts` — accept `confidence` parameter, render prefix + reasons
- **Modify** `server/src/notifications/ntfy.ts` — same
- **Modify** `server/src/notifications/email.ts` — same
- **Modify** `server/src/notifications/webhook.ts` — add `confidence` field to payload
- **Modify** `server/src/notifications/web-push.ts` — same
- **Modify** `server/src/ai/prompts.ts` — `buildAlertCopyPrompt` accepts `confidence` in context
- **Modify** existing channel test files to assert prefix + reasons render correctly per level

Total scope estimate: ~400 LOC + tests. ~10 tasks.

## Out of scope / future

- Confidence on basket alerts (separate `firePriceAlertsForBasket` path; defer)
- User-configurable suppression (e.g., "don't alert me on LOW") — defer to v2
- Confidence history / trends ("price hasn't been MEDIUM-or-better in 3 weeks") — interesting, but not v1
