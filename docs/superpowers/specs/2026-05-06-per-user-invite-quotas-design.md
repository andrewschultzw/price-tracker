# Per-User Invite Quotas — Design Spec

**Date:** 2026-05-06
**Status:** Approved (rolling into implementation)
**Branch:** `feature/per-user-invite-quotas`

## Goal

Let non-admin users invite friends, gated by a small quota (default 3 invites). Closes the actual 1→20-user growth gap — currently only admins can invite, which means users can't onboard their own family/friends without bothering an admin. Pairs with PR #22's polished registration flow: a regular user shares a clean invite link, the invitee lands on a validated registration page, both done.

## Decisions

1. **Default quota:** **3 unused invites per user.** Admins remain unlimited (existing behavior preserved). Quota is a soft cap on UNUSED invites — once an invite is used by an invitee, the slot frees up. This keeps spam pressure low while still enabling normal household/friend onboarding.

2. **Counting model:** dynamic — `quota - count(invites where created_by=user_id AND used_by IS NULL AND not expired)`. No `quota_remaining` column to keep in sync. Simpler.

3. **UI:** new **"Invites"** card on Settings → visible to all users. Shows current count + remaining quota + list of invites + "Generate" button (disabled when quota full). Admins see the same card; their card just shows "Unlimited" instead of a count.

4. **Expiry default:** **30 days from creation.** Server-side default if request body omits `expires_at`. Reduces the long-tail dangling-invite problem.

## Architecture

### No migration needed

Reuse existing `users` table — just one new admin-tunable env var or hardcoded constant. No DB column. Quota calculation done on the fly.

Pick a constant `DEFAULT_INVITE_QUOTA = 3` in `config.ts`. (Could be made env-tunable later — `INVITE_QUOTA_DEFAULT` env var — but YAGNI for v1.)

### New helper

```typescript
// server/src/db/user-queries.ts
export function countActiveInvitesByUser(userId: number): number {
  return Number(
    getDb().prepare(`
      SELECT COUNT(*) AS n
      FROM invite_codes
      WHERE created_by = ?
        AND used_by IS NULL
        AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).get(userId).n
  );
}
```

Add a quota check helper:

```typescript
export function getInviteQuotaState(userId: number, isAdmin: boolean): { used: number; remaining: number | null } {
  if (isAdmin) return { used: 0, remaining: null }; // null = unlimited
  const used = countActiveInvitesByUser(userId);
  return { used, remaining: Math.max(0, DEFAULT_INVITE_QUOTA - used) };
}
```

### New routes — `/api/invites/*` (any authenticated user)

Mounted at `/api/invites`, `apiKeyMiddleware + authMiddleware`. NOT `adminMiddleware`. Logic:

- **`POST /api/invites`** — body `{expires_at?: string}`. Default `expires_at = now + 30 days` if omitted. Refuses (HTTP 429) if user already has `DEFAULT_INVITE_QUOTA` unused/active invites. Admins bypass the quota.
- **`GET /api/invites`** — returns user's own invite codes (only their own — NOT all). Admins still use `/api/admin/invites` for "all users' invites" view.
- **`GET /api/invites/quota`** — returns `{used, remaining, default: DEFAULT_INVITE_QUOTA}`. UI renders the count.
- **`DELETE /api/invites/:id`** — lets a user delete their OWN unused invite (ownership check via `created_by = req.user.userId`). 404 if it doesn't exist OR isn't owned by this user OR is already used.

### Settings UI

**File:** `client/src/pages/Settings.tsx`

New "Invites" card visible to all users:

```
┌──────────────────────────────────────────┐
│  📩 Invites                              │
│  Used: 1 of 3 · 2 remaining              │
│                                          │
│  [Generate invite link]                  │
│                                          │
│  Active invites:                         │
│  pt-abc-123  •  expires May 15  [Copy] [✕]│
└──────────────────────────────────────────┘
```

Admins see "Unlimited" instead of "X of N · M remaining."

`Copy` → copies `https://prices.schultzsolutions.tech/register?code=<code>` to clipboard, identical to admin flow.
`✕` → DELETE /api/invites/:id (own invites only).
Generate button disabled when `remaining === 0` for non-admins.

### Existing admin route stays as-is

`/api/admin/invites` continues to work exactly as today — admins use it to see ALL invites system-wide via the Admin page. The new `/api/invites` is the per-user view. Two distinct surfaces, no overlap.

## Files modified or created

**Server:**
- Modify `server/src/config.ts` — add `defaultInviteQuota: 3` constant
- Modify `server/src/db/user-queries.ts` — `countActiveInvitesByUser`, `getInviteQuotaState`, plus a `getInviteCodesByUser(userId)` helper
- Create `server/src/routes/invites.ts` — the four new endpoints
- Create `server/src/routes/invites.test.ts` — quota enforcement, ownership scoping
- Modify `server/src/index.ts` — mount `/api/invites`
- Modify `server/src/db/user-queries.ts` `createInviteCode` to default `expires_at` to now+30 days when omitted (this affects /api/admin/invites too — verify the admin code already passes expires_at or starts inheriting the default)

**Client:**
- Modify `client/src/api.ts` — `getInvitesForMe`, `createInviteForMe`, `deleteInviteForMe`, `getInviteQuota`
- Modify `client/src/pages/Settings.tsx` — render the new Invites card, fetch quota + list on mount
- Create `client/src/components/InvitesCard.tsx` — the standalone card
- Create `client/src/components/InvitesCard.test.tsx`

## Tests

Server (~10 new):
- POST /api/invites without auth → 401
- POST /api/invites for non-admin under quota → 201, returns invite
- POST /api/invites for non-admin AT quota → 429
- POST /api/invites for admin AT quota equivalent → 201 (no quota)
- POST /api/invites with no expires_at → defaults to 30 days
- GET /api/invites returns user's OWN codes only (not other users')
- GET /api/invites/quota returns correct shape `{used, remaining, default}`
- DELETE /api/invites/:id for own unused → 204
- DELETE /api/invites/:id for own used → 404 (idempotent contract)
- DELETE /api/invites/:id for another user's invite → 404 (no existence leak)

Client (~3 new for the card):
- Renders empty state with "0 of 3 used" when no invites
- Renders list when invites present
- Generate button disabled when quota full
- Copy button copies the right URL

## Out of scope / future

- Configurable per-user override (admin can grant user X a higher quota)
- Email-delivered invites (sends an invite email with the link)
- Invite analytics (who signed up via whose invite)
- Quota rollover / reset on cycle

Estimated scope: ~250 LOC + tests.
