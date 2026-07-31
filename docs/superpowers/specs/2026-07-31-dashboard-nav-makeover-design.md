# Price-Tracker Dashboard + Nav Makeover — Design

**Date:** 2026-07-31
**Status:** approved (brainstormed with Andrew via visual companion; Option A chosen)
**Scope:** client workspace only. No server/API changes.

## Problem

The global nav bar (`App.tsx`) carries 8 icon+text links plus the display name plus
logout on one row — crowded and growing. The dashboard itself has almost no
controls (one checkbox), which is why four near-duplicate filter pages exist
(`/active`, `/below-target`, `/errors`, plus stat-card links out): the dashboard
can't filter, so every filter became a page.

## Design

### 1. Slim top bar (Option A)

Visible, left→right:

- Wordmark (BarChart3 + "Price Tracker") → `/`
- Nav links: **Dashboard**, **Deals**, **Projects**
- Spacer
- **+ Add Tracker** — the one primary button
- **NotificationBell** — icon button with unread-count badge → `/notifications`
- **UserMenu** — avatar/initial dropdown: display name (header), Purchased,
  Settings, Admin (only when `user.role === 'admin'`), divider, Logout

Mobile (`< md`): hamburger keeps the existing drawer pattern, mirroring the same
grouping (primary links, then a divider, then the user-menu items).

New components (hand-rolled, matching house style — no component library):

- `components/UserMenu.tsx` — dropdown; closes on route change, Escape, and
  click-outside; `aria-expanded`/`aria-haspopup`; focus returns to trigger.
- `components/NotificationBell.tsx` — badge count from the existing
  notifications API; polls at most on mount + route change (no new socket).

### 2. Dashboard toolbar

Header row (`Dashboard.tsx`) becomes a real toolbar:

- **Search input** — client-side filter over tracker title + hostname.
- **Filter chips with live counts:** All · Active · Below target · Errors ·
  Paused · Purchased. Single-select. Default **All** (purchased hidden, as
  today). Active = tracking normally (not paused/errored/purchased).
- **Sort dropdown:** Smart (current `dashboard-sort.ts` bucketing, default) ·
  Price · Recently checked · A–Z.

Chip state syncs to the URL: `/?filter=errors` etc. Old routes become redirects
into the dashboard (`/active` → `/?filter=active`,
`/below-target` → `/?filter=below-target`, `/errors` → `/?filter=errors`), and
`pages/Active.tsx`, `pages/BelowTarget.tsx`, `pages/Errors.tsx` are deleted.
Bookmarks keep working. `/category/:domain` and `CategoryCard` are unchanged
(grouping, not a filter). Stat cards stay but select the matching chip in place
instead of navigating away; Potential Savings keeps its confetti.

"Show purchased (N)" checkbox is replaced by the Purchased chip.

### 3. Light ReactBits flavor

Vendored (copy-paste model) into `client/src/components/bits/`, plain-CSS/TS
variants, adapted to the Tailwind v4 token theme:

- **Count Up** on the four stat-card numbers (one-shot on mount/value change).
- **Border Glow** on below-target tracker cards only.

Rule: no new runtime dependencies. If a bit's upstream version wants GSAP, it
gets reimplemented with CSS/rAF. Both effects no-op under
`prefers-reduced-motion` (site already has this convention for celebrations).

## Error handling

- Notification count fetch failure → badge hidden, no error surface (log to
  console); bell still links to `/notifications`.
- Unknown `?filter=` value → fall back to All (no crash, no redirect loop).

## Testing

- Extend vitest suite: chip filtering + counts, search filter, URL⇄chip sync,
  redirect routes land on the right filter, sort orders, UserMenu
  open/close/Escape/click-outside, Admin item role-gating, reduced-motion no-op.
- Full client suite green; extension parity drift-detector unaffected (no
  Tracker shape changes).
- Real-browser smoke on the deployed preview before merge (house rule:
  tsc+unit green is not enough).

## Out of scope

TrackerCard density, TrackerDetail, mobile app-ification, server changes,
command palette (Option C — revisit if tracker count grows past ~50).
