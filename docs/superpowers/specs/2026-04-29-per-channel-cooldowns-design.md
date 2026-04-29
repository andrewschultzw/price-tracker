# Per-Channel Cooldowns Design

**Date:** 2026-04-29
**Status:** Approved
**Author:** Andrew Schultz + Claude

## Overview

The notification cooldown today is per-`(tracker, seller)` and global-fixed at 6 hours (`config.notificationCooldownHours`). Every enabled channel for that user shares one cooldown clock — Discord firing silences ntfy and webhook for the same window. The whole point of having multiple channels is that they serve different purposes (ntfy for "right now on my phone", webhook for "log this to Home Assistant", email for "weekly digest"), so collapsing them under a single 6-hour gate is wrong.

This change makes the cooldown per-`(tracker, seller, channel)` with a per-channel duration that the user picks in Settings. The plausibility guard, manual `bypassCooldown=true` flow, and the per-seller invariant locked down by `cron-cooldown.test.ts` all stay correct.

## Decisions

- **Granularity:** cooldown is per-`(tracker, seller, channel)`. The existing `notifications` table already has a `channel` column populated by `addNotification` — we use it. No DB migration needed.
- **Where the gate runs:** moved from a single check before fanout (line 204 of `cron.ts` today) into the per-channel loop inside `firePriceAlerts`. Each channel queries its own most-recent `notifications` row, applies its own duration, and either fires or skips independently.
- **Plausibility guard placement:** stays exactly where it is (per-seller, before the fanout). The guard's `pending_confirmation_at` flag is per-seller and decides "is this price real?" — once confirmed, the alert *should* fire on every channel that isn't in cooldown.
- **Per-channel duration storage:** new per-user encrypted-not-needed setting keys, one per channel:
  - `discord_cooldown_hours`
  - `ntfy_cooldown_hours`
  - `webhook_cooldown_hours`
  - `email_cooldown_hours`
- **Default:** when a key is unset or empty, fall back to `config.notificationCooldownHours` (6). Existing single-channel users see no behavior change after deploy.
- **Zero is a valid value:** `0` means "no cooldown — fire every time the threshold is met". This is the "ntfy instant" case from the todo.
- **Non-negative integer hours:** validated server-side. The existing `getSetting`/`setSetting` plumbing stores strings, so we parse on read. Negative or non-numeric values fall back to the default (defensive — UI prevents this).
- **Settings whitelist:** four new keys added to `ALLOWED_SETTING_KEYS` in `routes/settings.ts`.
- **`bypassCooldown=true` semantics unchanged:** the manual "Check Now" path still bypasses every channel's cooldown. The flag was never about per-channel granularity — it's "the user explicitly asked, fire everything that's enabled".

## Architecture

### New DB query

```typescript
// server/src/db/queries.ts
export function getLastNotificationForSellerChannel(
  trackerId: number,
  trackerUrlId: number,
  channel: string,
): NotificationRecord | undefined {
  return getDb().prepare(`
    SELECT * FROM notifications
    WHERE tracker_id = ? AND tracker_url_id = ? AND channel = ?
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(trackerId, trackerUrlId, channel) as NotificationRecord | undefined;
}
```

The existing `getLastNotificationForSeller(trackerId, trackerUrlId)` becomes unused. Kept in place for one cycle in case anything else references it; flagged for removal in a follow-up.

### New cooldown-resolution helper

```typescript
// server/src/scheduler/cron.ts (or a new server/src/notifications/cooldown.ts if cleaner)
function getCooldownHoursForChannel(userId: number, channel: ChannelName): number {
  const raw = getSetting(`${channel}_cooldown_hours`, userId);
  if (raw === undefined || raw === '') return config.notificationCooldownHours;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return config.notificationCooldownHours;
  return parsed;
}
```

`channel` is a string literal type `'discord' | 'ntfy' | 'webhook' | 'email'` — same string used for the `notifications.channel` column and for the setting key prefix.

### Refactored fanout in `cron.ts`

The cooldown gate moves out of `checkTrackerUrl` and into `firePriceAlerts`. Pseudocode shape:

```typescript
async function firePriceAlerts(
  alertTracker: Tracker,
  currentPrice: number,
  channels: EnabledChannels,
  seller: TrackerUrl,
  bypassCooldown: boolean,
): Promise<string[]> {
  const sentChannels: string[] = [];
  const tasks: Array<{ name: ChannelName; promise: Promise<boolean> }> = [];

  for (const name of ['discord', 'ntfy', 'webhook', 'email'] as const) {
    if (!channels[name]) continue;
    if (!bypassCooldown && isChannelInCooldown(alertTracker.id, seller.id, name, alertTracker.user_id!)) {
      logCooldownSuppression(...);
      continue;
    }
    tasks.push({ name, promise: dispatch(name, alertTracker, currentPrice, channels) });
  }

  const results = await Promise.all(tasks.map(t => t.promise));
  return tasks.filter((_, i) => results[i]).map(t => t.name);
}
```

The single "is in cooldown? log + skip" block in `checkTrackerUrl` (around `cron.ts:204-226`) goes away. The plausibility guard branches around it stay; what changes is that the four "fire alerts + write notifications" lines inside each plausibility branch all call the same `firePriceAlerts(..., seller, bypassCooldown)` and the per-channel gate happens inside it.

The cooldown-suppressed log line keeps its `info` level and current shape (per the "silent skip is worse than loud" lesson from 2026-04-09), now emitted once per suppressed channel rather than once per scrape.

### Settings UI

Each channel card in `client/src/pages/Settings.tsx` gets a small "Cooldown (hours)" number input below the URL/recipient field:

```tsx
<label>Cooldown (hours) <span>(0 = no cooldown, blank = default 6h)</span></label>
<input type="number" min={0} step={1} value={cooldowns[ch.key]} onChange={...} />
```

Persistence reuses the existing `updateSettings({ [`${ch.key}_cooldown_hours`]: value })` PUT. No new endpoints, no new test buttons. The Save button on each card already POSTs the channel's settings as one batch — the cooldown field saves alongside the URL.

When the user types blank, we send empty string and the server treats it as "use default".

### `tasks/todo.md`

Move the per-channel cooldowns entry from "only when it bites" to a Done-section entry dated today, with a short summary referencing this spec and the shipping PR.

## Tests

### Existing tests that must still pass unchanged

`server/src/scheduler/cron-cooldown.test.ts` — all six cases. The "Amazon-vs-Newegg" invariant survives because `(tracker, seller, channel)` is strictly more specific than `(tracker, seller)`. The "same-seller cooldown suppresses next alert" case still passes when only Discord is configured (the only test channel) and no per-channel duration setting is written: default = 6h, behavior identical.

### New cases

1. **Discord 6h + ntfy 0h → discord skipped, ntfy fires every scrape.** Configure both channels for one user, set `ntfy_cooldown_hours=0`, run two scrapes back-to-back. Expect Discord called once, ntfy called twice, two ntfy notification rows + one Discord row.
2. **Per-channel windows are independent.** Configure both channels with default 6h, fire once. Then sleep-mock `Date.now()` forward 4 hours, manually fire a Discord-only test (e.g., via direct DB manipulation simulating one channel hitting threshold differently) — actually simpler: just verify that one channel's row doesn't shadow another's lookup. Test by inserting a Discord notif row 4h ago, calling `checkTrackerUrl`, and asserting ntfy fires (no ntfy row exists yet) while Discord is suppressed.
3. **Setting=0 means no cooldown.** Set `discord_cooldown_hours=0`, fire twice in quick succession, expect two Discord rows.
4. **Non-numeric / negative setting falls back to default.** Set `discord_cooldown_hours=-5`, fire once, then again immediately, expect cooldown active (default 6h applied).
5. **`bypassCooldown=true` still bypasses every channel.** Insert recent rows for all four channels, call `checkTrackerUrl(seller.id, true)`, expect all four channels fire (one new row each).
6. **Plausibility guard interaction unchanged:** suspicious price → no fire on any channel; pending + confirmed → fire all enabled (subject to their per-channel cooldowns).

### Existing tests that need a small adjustment

The `getLastNotificationForSeller` direct usages in tests, if any, become `getLastNotificationForSellerChannel` calls. Quick grep audit during implementation.

## Out of scope

- **Cooldown-per-tracker overrides.** A heavy user might want "this one tracker bypasses cooldown entirely" — handled today by the manual Check Now button. Not building per-tracker overrides until the user asks.
- **Cooldown for error alerts.** `fireErrorAlerts` has no cooldown today and stays that way. Errors are rare and noisy by design — the existing `maxConsecutiveFailures` threshold gates them.
- **Cooldown analytics on the Notifications page.** "Last sent X minutes ago, cooldown until Y" would be a nice future affordance but isn't in this scope.
- **Server-wide cooldown override by admin.** The setting is per-user. Cross-user policy would be a separate admin feature.
