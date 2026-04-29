# Per-Channel Cooldowns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single per-`(tracker, seller)` cooldown with per-`(tracker, seller, channel)` cooldowns, each with a user-configurable duration.

**Architecture:** New `getLastNotificationForSellerChannel` query reuses the existing `notifications.channel` column (no migration). Cooldown gate moves out of `checkTrackerUrl` into the per-channel fanout in `firePriceAlerts`. New per-user encrypted-not-needed settings `{discord,ntfy,webhook,email}_cooldown_hours` default to `config.notificationCooldownHours` (6).

**Tech Stack:** Existing — TypeScript, better-sqlite3, vitest, React.

**Spec:** `docs/superpowers/specs/2026-04-29-per-channel-cooldowns-design.md`

**Branch:** `feature/per-channel-cooldowns` (already checked out).

---

## Task 1: Add `getLastNotificationForSellerChannel` query

**Files:**
- Modify: `server/src/db/queries.ts`

- [ ] **Step 1:** Add the new query just below `getLastNotificationForSeller`. Reuse its `NotificationRecord` type. Body:

```typescript
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

- [ ] **Step 2:** Typecheck: `cd server && npx tsc --noEmit`. Expect clean.

- [ ] **Step 3:** Commit:

```bash
git add server/src/db/queries.ts
git commit -m "feat(server): add per-channel notification lookup query"
```

---

## Task 2: Add cooldown-resolution helper + whitelist new setting keys

**Files:**
- Modify: `server/src/scheduler/cron.ts` (helper)
- Modify: `server/src/routes/settings.ts` (whitelist + non-negative-int validation)

- [ ] **Step 1:** In `cron.ts`, add `ChannelName` type and `getCooldownHoursForChannel(userId, channel)` helper near the top, alongside `getEnabledChannels`:

```typescript
type ChannelName = 'discord' | 'ntfy' | 'webhook' | 'email';

function getCooldownHoursForChannel(userId: number, channel: ChannelName): number {
  const raw = getSetting(`${channel}_cooldown_hours`, userId);
  if (raw === undefined || raw === '') return config.notificationCooldownHours;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return config.notificationCooldownHours;
  return parsed;
}
```

- [ ] **Step 2:** In `routes/settings.ts`, add four keys to `ALLOWED_SETTING_KEYS`:

```typescript
'discord_cooldown_hours',
'ntfy_cooldown_hours',
'webhook_cooldown_hours',
'email_cooldown_hours',
```

Add a server-side validation block in the PUT handler that rejects values which are non-empty AND not a non-negative integer string:

```typescript
if (key.endsWith('_cooldown_hours') && value !== '') {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    res.status(400).json({ error: `Invalid cooldown for ${key} — must be a non-negative integer` });
    return;
  }
}
```

- [ ] **Step 3:** Typecheck. Expect clean.

- [ ] **Step 4:** Commit:

```bash
git add server/src/scheduler/cron.ts server/src/routes/settings.ts
git commit -m "feat(server): per-user cooldown_hours settings + resolver helper"
```

---

## Task 3: Refactor `firePriceAlerts` to gate per channel

**Files:**
- Modify: `server/src/scheduler/cron.ts`

- [ ] **Step 1:** Update `firePriceAlerts` signature to accept `seller` and `bypassCooldown`, and to perform the per-channel cooldown check + log inline. Drop the helper functions if not needed; keep things in the function body. Roughly:

```typescript
async function firePriceAlerts(
  alertTracker: Tracker,
  currentPrice: number,
  channels: EnabledChannels,
  seller: TrackerUrl,
  bypassCooldown: boolean,
): Promise<string[]> {
  const userId = alertTracker.user_id!;
  const tasks: { name: ChannelName; promise: Promise<boolean> }[] = [];

  const channelDispatch: Record<ChannelName, () => Promise<boolean>> = {
    discord: () => sendDiscordPriceAlert(alertTracker, currentPrice, channels.discord!),
    ntfy: () => sendNtfyPriceAlert(alertTracker, currentPrice, channels.ntfy!, channels.ntfyToken),
    webhook: () => sendGenericPriceAlert(alertTracker, currentPrice, channels.webhook!),
    email: () => sendEmailPriceAlert(alertTracker, currentPrice, channels.email!),
  };

  for (const name of ['discord', 'ntfy', 'webhook', 'email'] as const) {
    if (!channels[name]) continue;
    if (!bypassCooldown) {
      const last = getLastNotificationForSellerChannel(alertTracker.id, seller.id, name);
      const cooldownHours = getCooldownHoursForChannel(userId, name);
      const cooldownMs = cooldownHours * 60 * 60 * 1000;
      if (last && Date.now() - new Date(last.sent_at + 'Z').getTime() < cooldownMs) {
        const sentAtMs = new Date(last.sent_at + 'Z').getTime();
        const minutesUntilReady = Math.ceil((cooldownMs - (Date.now() - sentAtMs)) / 60000);
        logger.info(
          {
            trackerId: alertTracker.id,
            trackerUrlId: seller.id,
            trackerName: alertTracker.name,
            channel: name,
            cooldownHours,
            lastSentAt: last.sent_at,
            minutesUntilReady,
          },
          `Cooldown active for ${name} on this seller — alert suppressed for ${minutesUntilReady} more minute(s)`,
        );
        continue;
      }
    }
    tasks.push({ name, promise: channelDispatch[name]() });
  }

  const results = await Promise.all(tasks.map(t => t.promise));
  return tasks.filter((_, i) => results[i]).map(t => t.name);
}
```

- [ ] **Step 2:** Update `checkTrackerUrl` to:
  - Remove the early `getLastNotificationForSeller` cooldown check + log block (lines roughly 204–226 in current `cron.ts`).
  - Pass `seller` and `bypassCooldown` to every `firePriceAlerts(...)` call inside the plausibility branches.
  - Keep `addNotification(...)` writes inside each plausibility branch as before — they operate on whatever channels `firePriceAlerts` reports as actually fired.

- [ ] **Step 3:** Add the new import: `getLastNotificationForSellerChannel` alongside `getLastNotificationForSeller` in the queries import block. Leave `getLastNotificationForSeller` imported only if still referenced; otherwise remove from the import.

- [ ] **Step 4:** Typecheck. Expect clean.

- [ ] **Step 5:** Commit:

```bash
git add server/src/scheduler/cron.ts
git commit -m "refactor(scheduler): move cooldown gate into per-channel fanout"
```

---

## Task 4: Update + extend `cron-cooldown.test.ts`

**Files:**
- Modify: `server/src/scheduler/cron-cooldown.test.ts`

- [ ] **Step 1:** Run the existing suite once with the new code: `cd server && npx vitest run cron-cooldown`. Expected: all six cases pass unchanged. (If they don't, fix the implementation, not the tests — the existing invariants are correct.)

- [ ] **Step 2:** Add a new `describe('per-channel cooldowns', ...)` block with these cases:

  - **Channel duration of 0 means no cooldown.** Configure ntfy with `setSetting('ntfy_cooldown_hours', '0')`. Two back-to-back `checkTrackerUrl` calls. Expect two ntfy rows.

  - **One channel in cooldown does not block another channel.** Set Discord URL + ntfy URL + leave both at default. Insert a Discord notification row 1h ago for the seller manually. Call `checkTrackerUrl`. Expect: ntfy row written (no prior ntfy row exists), no new Discord row. The mocked `sendDiscordPriceAlert` is NOT called; `sendNtfyPriceAlert` IS called.

  - **`bypassCooldown=true` fires every enabled channel.** Insert recent rows for both Discord and ntfy. Call `checkTrackerUrl(seller.id, true)`. Expect both channels fire and write new rows.

  - **Per-channel duration is read from settings.** Set `discord_cooldown_hours='2'`, leave ntfy at default 6. Insert rows for both 3h ago. Call `checkTrackerUrl`. Expect Discord fires (3h > 2h) and ntfy is suppressed (3h < 6h).

  - **Non-numeric setting falls back to default.** Set `discord_cooldown_hours='not-a-number'`. Insert a row 1h ago. Call `checkTrackerUrl`. Expect Discord suppressed (default 6h applied).

  - **Negative setting falls back to default.** Set `discord_cooldown_hours='-5'`. Insert row 1h ago. Call `checkTrackerUrl`. Expect Discord suppressed.

- [ ] **Step 3:** Mock the ntfy and webhook senders in the test file (`vi.mock` for `../notifications/ntfy.js` and `../notifications/webhook.js`) — both are already mocked in the existing file. Add email mock if needed for any of the new cases.

- [ ] **Step 4:** Run: `cd server && npx vitest run cron-cooldown`. Expect 6 existing + 6 new = 12 cases pass.

- [ ] **Step 5:** Commit:

```bash
git add server/src/scheduler/cron-cooldown.test.ts
git commit -m "test(scheduler): cover per-channel cooldown durations and independence"
```

---

## Task 5: Add cooldown input to each Settings card

**Files:**
- Modify: `client/src/pages/Settings.tsx`

- [ ] **Step 1:** Extend the `ChannelConfig` type with `cooldownKey`:

```typescript
interface ChannelConfig {
  // existing fields...
  cooldownKey: 'discord_cooldown_hours' | 'ntfy_cooldown_hours' | 'webhook_cooldown_hours' | 'email_cooldown_hours';
}
```

Add the matching key to each of the 4 `CHANNELS` entries.

- [ ] **Step 2:** Add a `cooldowns` state object alongside `values`:

```typescript
const [cooldowns, setCooldowns] = useState<Record<ChannelKey, string>>({ discord: '', ntfy: '', webhook: '', email: '' });
```

Populate it in the `useEffect` from `s.discord_cooldown_hours || ''` etc.

- [ ] **Step 3:** Update `handleSave` to include the cooldown field in the payload:

```typescript
const payload: Record<string, string> = { [ch.settingKey]: values[ch.key], [ch.cooldownKey]: cooldowns[ch.key] };
if (ch.key === 'ntfy') payload.ntfy_token = ntfyToken;
await updateSettings(payload);
```

- [ ] **Step 4:** In the per-channel card render block, add a number input below the URL/recipient input, above the Save/Test buttons:

```tsx
<label className="block text-sm font-medium text-text-muted mb-1.5">
  Cooldown (hours) <span className="text-text-muted/60 font-normal">(0 = no cooldown, blank = default 6h)</span>
</label>
<input
  type="number"
  min={0}
  step={1}
  value={cooldowns[ch.key]}
  onChange={e => setCooldowns(c => ({ ...c, [ch.key]: e.target.value }))}
  placeholder="6"
  className="w-full bg-bg border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary mb-4"
/>
```

- [ ] **Step 5:** Typecheck: `cd client && npx tsc --noEmit`. Expect clean.

- [ ] **Step 6:** Commit:

```bash
git add client/src/pages/Settings.tsx
git commit -m "feat(client): per-channel cooldown input on Settings"
```

---

## Task 6: Full typecheck + test suite + manual smoke

**Files:** none modified at this step.

- [ ] **Step 1:** `cd server && npx tsc --noEmit && npx vitest run`. Expect zero TS errors, all server tests pass (≥172 + 6 new = ≥178).

- [ ] **Step 2:** `cd client && npx tsc --noEmit && npx vitest run`. Expect zero TS errors, all client tests pass (≥61).

- [ ] **Step 3:** Manual smoke: skip in this session unless deploying. Note in the PR body what was NOT manually tested.

---

## Task 7: Update `tasks/todo.md`, commit, push, open PR

**Files:**
- Modify: `tasks/todo.md`

- [ ] **Step 1:** Move the `Per-channel cooldowns` entry from the open list to a new `### 2026-04-29` block under `## Done`. Mark `[x]`. Strikethrough the original blurb. Add a one-paragraph summary linking to the spec, plan, and PR.

- [ ] **Step 2:** Commit:

```bash
git add tasks/todo.md
git commit -m "docs(todo): mark per-channel cooldowns done"
```

- [ ] **Step 3:** Push:

```bash
git push -u origin feature/per-channel-cooldowns
```

- [ ] **Step 4:** Open PR via `gh pr create`. Title: `feat: per-channel notification cooldowns`. Body summarizes the spec's "Decisions" section + a Test Plan checklist.

---

## Risks / known gaps

- **The user might want to see the current cooldown state on the Notifications page or Tracker Detail.** Out of scope here. Note in the PR body for follow-up.
- **The `getLastNotificationForSeller` query becomes unused after this change.** Left in place for one cycle. Add a `TODO(debt):` comment + a tasks/todo.md entry.
- **No DB migration test.** Not needed — the schema didn't change. Existing migration tests still cover the surrounding tables.
