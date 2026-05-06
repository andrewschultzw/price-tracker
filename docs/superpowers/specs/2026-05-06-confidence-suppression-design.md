# Confidence Suppression — Design Spec

**Date:** 2026-05-06
**Status:** Approved (rolling into implementation)
**Branch:** `feature/confidence-suppression`

## Goal

Per-channel filter so users can suppress LOW (or LOW+MEDIUM) confidence alerts on noisy channels while keeping HIGH-confidence alerts on the channels they actually watch. Small, surgical follow-up to the confidence-scored alerts feature (PR #18). Completes the "rules judge, LLM narrates" + "user-controlled noise floor" loop.

## UX

In Settings, each notification channel card gets a new dropdown labeled "Minimum confidence":

| Setting | Behavior |
|---|---|
| **All deals (default)** | LOW + MEDIUM + HIGH all fire (today's behavior) |
| **Good deals only** | MEDIUM + HIGH fire; LOW suppressed |
| **Strong deals only** | Only HIGH fires; LOW + MEDIUM suppressed |

Default is "All deals" (preserves today's behavior — no breaking change).

## Architecture

Reuses the existing `settings` table pattern. New keys, one per channel:

- `discord_min_confidence`
- `ntfy_min_confidence`
- `webhook_min_confidence`
- `email_min_confidence`
- `web_push_min_confidence`

Values: `'LOW' | 'MEDIUM' | 'HIGH'`. Missing/null = `'LOW'` (= "All deals").

### Filtering in firePriceAlerts

After confidence is computed (already happens — PR #18), filter the channel list:

```typescript
const channelOrder: ChannelName[] = ['discord', 'ntfy', 'webhook', 'email', 'web_push'];
const minConfRanks = { LOW: 0, MEDIUM: 1, HIGH: 2 };
const alertRank = confidence ? minConfRanks[confidence.level] : 0;

const allowedChannels = channelOrder.filter(ch => {
  const userMin = getSetting(`${ch}_min_confidence`, userId) || 'LOW';
  const channelMinRank = minConfRanks[userMin as keyof typeof minConfRanks] ?? 0;
  return alertRank >= channelMinRank;
});
```

When `confidence === null` (insufficient signal data), treat as LOW — still fires under default setting, suppressed under "MEDIUM/HIGH only." Safe-default.

When the suppression filter excludes ALL channels, log it (`alert_suppressed_by_min_confidence` with tracker_id, level, count) and skip the alert entirely. Do NOT bypass the filter to "force at least one channel" — the user explicitly asked for the suppression.

### No basket-alert suppression v1

Basket alerts use a separate `firePriceAlertsForBasket`-equivalent flow. Out of scope. Same as confidence-scored alerts didn't apply to basket alerts in PR #18.

## Files modified or created

**Server:**
- Modify `server/src/routes/settings.ts` — add 5 new keys to `ALLOWED_SETTING_KEYS`
- Modify `server/src/scheduler/cron.ts` — apply min-confidence filter in `firePriceAlerts`
- Create or extend `server/src/scheduler/cron-confidence-suppression.test.ts` — filter unit tests

**Client:**
- Modify `client/src/pages/Settings.tsx` — add dropdown to each channel card

## Tests

Server (5-7 new tests):
1. Default behavior (no setting) → LOW alert fires on all channels (regression check)
2. `discord_min_confidence='MEDIUM'` → LOW alert skips Discord but fires on other channels
3. `discord_min_confidence='HIGH'` AND `ntfy_min_confidence='HIGH'` → MEDIUM alert skips both, fires only on remaining default channels
4. ALL channels set to HIGH + alert is LOW → no channels fire, log emitted
5. `confidence === null` (insufficient signal data) → treated as LOW → fires under default
6. Cohabitation: cooldown filter and confidence filter both apply (cooldown still wins when triggered)

Client (1-2 component tests):
1. Settings dropdown renders for each channel; persists value via existing settings update flow

## Out of scope / future

- Per-tracker override (e.g., "suppress LOW everywhere EXCEPT for these specific watched products")
- Channel-level "test alert" button that respects min-confidence
- "Quiet hours" per channel
- `web_push_cooldown_hours` (note: missing from existing per-channel cooldown set; not adding here, but flagging)

Estimated scope: ~120 LOC + tests.
