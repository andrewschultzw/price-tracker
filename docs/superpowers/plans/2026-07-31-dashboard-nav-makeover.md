# Dashboard + Nav Makeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slim the crowded top nav to 3 links + bell + avatar menu, and give the dashboard a real toolbar (search, filter chips, sort) that absorbs the `/active`, `/below-target`, `/errors` pages.

**Architecture:** All changes in the `client` workspace. New pure functions in `lib/` carry the logic (testable without DOM); new components `UserMenu`, `NotificationBell`, `DashboardToolbar` are hand-rolled in house style. Filter state lives in the URL (`useSearchParams`), so old routes become `<Navigate>` redirects. Two vendored ReactBits effects (`CountUp`, glow CSS) with zero new runtime deps.

**Tech Stack:** React 19, TypeScript 5.9, Tailwind CSS v4 (CSS-first `@theme` tokens in `src/index.css`), react-router-dom 7, vitest 4 + @testing-library/react, lucide-react.

## Global Constraints

- **No new runtime dependencies.** ReactBits effects are vendored/reimplemented with CSS + rAF — never install GSAP/framer-motion.
- All animation no-ops under `prefers-reduced-motion` (existing house convention).
- Work on branch `feature/dashboard-nav-makeover`; PR to main (CI runs 3 workspaces; deploy fires on merge via webhook).
- Run all client checks from `/root/price-tracker/client`: `npx vitest run`, `npx tsc --noEmit -p tsconfig.app.json` (or `npm run build` which typechecks), `npx eslint src`.
- No server/API/Tracker-shape changes (extension parity drift-detector must stay green).
- Spec: `docs/superpowers/specs/2026-07-31-dashboard-nav-makeover-design.md`.

---

### Task 1: Filter + sort logic (`lib/dashboard-filter.ts`)

**Files:**
- Create: `client/src/lib/dashboard-filter.ts`
- Test: `client/src/lib/dashboard-filter.test.ts`

**Interfaces:**
- Produces:
  - `type DashboardFilter = 'all' | 'active' | 'below-target' | 'errors' | 'paused' | 'purchased'`
  - `parseFilter(raw: string | null): DashboardFilter` — unknown/null → `'all'`
  - `filterTrackers(trackers: Tracker[], filter: DashboardFilter, query: string): Tracker[]`
  - `filterCounts(trackers: Tracker[]): Record<DashboardFilter, number>`
  - `type DashboardSortMode = 'smart' | 'price' | 'recent' | 'alpha'`
  - `parseSort(raw: string | null): DashboardSortMode`
  - `sortTrackers(trackers: Tracker[], mode: DashboardSortMode): Tracker[]` — for `'smart'` returns input unchanged (caller uses `buildDashboardLayout`)
- Consumes: `isErrored` from `client/src/lib/dashboard-sort.ts`; `Tracker` from `client/src/types.ts` (fields used: `status: 'active' | 'paused' | 'purchased'`, `threshold_price`, `last_price`, `title`, `url`, `last_checked`).

- [ ] **Step 1: Write the failing tests**

```typescript
// client/src/lib/dashboard-filter.test.ts
import { describe, it, expect } from 'vitest'
import { parseFilter, parseSort, filterTrackers, filterCounts, sortTrackers } from './dashboard-filter'
import type { Tracker } from '../types'

// Minimal tracker factory — only fields the filter logic reads.
const t = (o: Partial<Tracker>): Tracker => ({
  id: 1, url: 'https://example.com/x', title: 'Widget', status: 'active',
  threshold_price: null, last_price: null, last_checked: null,
  consecutive_errors: 0, last_error: null,
  ...o,
} as Tracker)

const fixture: Tracker[] = [
  t({ id: 1, title: 'SSD 1TB', status: 'active', threshold_price: 80, last_price: 70 }),        // below target
  t({ id: 2, title: 'GPU', status: 'active', threshold_price: 500, last_price: 600 }),          // active
  t({ id: 3, title: 'Router', status: 'active', consecutive_errors: 5, last_error: 'boom' }),   // errored (isErrored)
  t({ id: 4, title: 'Desk', status: 'paused' }),                                                // paused
  t({ id: 5, title: 'Chair', status: 'purchased', url: 'https://wayfair.com/chair' }),          // purchased
]

describe('parseFilter', () => {
  it('passes through valid filters', () => expect(parseFilter('errors')).toBe('errors'))
  it('falls back to all on null', () => expect(parseFilter(null)).toBe('all'))
  it('falls back to all on junk', () => expect(parseFilter('bogus')).toBe('all'))
})

describe('filterTrackers', () => {
  it('all hides purchased', () =>
    expect(filterTrackers(fixture, 'all', '').map(x => x.id)).toEqual([1, 2, 3, 4]))
  it('purchased shows only purchased', () =>
    expect(filterTrackers(fixture, 'purchased', '').map(x => x.id)).toEqual([5]))
  it('active excludes paused, errored, purchased', () =>
    expect(filterTrackers(fixture, 'active', '').map(x => x.id)).toEqual([1, 2]))
  it('below-target matches threshold rule', () =>
    expect(filterTrackers(fixture, 'below-target', '').map(x => x.id)).toEqual([1]))
  it('errors uses isErrored', () =>
    expect(filterTrackers(fixture, 'errors', '').map(x => x.id)).toEqual([3]))
  it('paused shows only paused', () =>
    expect(filterTrackers(fixture, 'paused', '').map(x => x.id)).toEqual([4]))
  it('query matches title case-insensitively', () =>
    expect(filterTrackers(fixture, 'all', 'ssd').map(x => x.id)).toEqual([1]))
  it('query matches hostname', () =>
    expect(filterTrackers(fixture, 'purchased', 'wayfair').map(x => x.id)).toEqual([5]))
})

describe('filterCounts', () => {
  it('counts every bucket', () =>
    expect(filterCounts(fixture)).toEqual({
      all: 4, active: 2, 'below-target': 1, errors: 1, paused: 1, purchased: 1,
    }))
})

describe('sortTrackers', () => {
  it('smart returns input order untouched', () =>
    expect(sortTrackers(fixture, 'smart').map(x => x.id)).toEqual([1, 2, 3, 4, 5]))
  it('price sorts ascending, null prices last', () => {
    const ids = sortTrackers(fixture, 'price').map(x => x.id)
    expect(ids.slice(0, 3)).toEqual([1, 2, 3].sort((a, b) => {
      const p = (id: number) => fixture.find(f => f.id === id)!.last_price ?? Infinity
      return p(a) - p(b)
    }))
    expect(ids.indexOf(4)).toBeGreaterThan(ids.indexOf(2)) // null price after real prices
  })
  it('alpha sorts by title', () =>
    expect(sortTrackers(fixture, 'alpha').map(x => x.title)).toEqual(
      [...fixture.map(x => x.title)].sort((a, b) => a.localeCompare(b))))
})
```

Note: check `client/src/types.ts` for the real `Tracker` required fields and adjust the factory's base object so it typechecks — add missing required fields with dummy values rather than casting more loosely.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /root/price-tracker/client && npx vitest run src/lib/dashboard-filter.test.ts`
Expected: FAIL — module `./dashboard-filter` not found.

- [ ] **Step 3: Implement**

```typescript
// client/src/lib/dashboard-filter.ts
import type { Tracker } from '../types'
import { isErrored } from './dashboard-sort'

export type DashboardFilter = 'all' | 'active' | 'below-target' | 'errors' | 'paused' | 'purchased'
export type DashboardSortMode = 'smart' | 'price' | 'recent' | 'alpha'

const FILTERS: DashboardFilter[] = ['all', 'active', 'below-target', 'errors', 'paused', 'purchased']
const SORTS: DashboardSortMode[] = ['smart', 'price', 'recent', 'alpha']

export function parseFilter(raw: string | null): DashboardFilter {
  return FILTERS.includes(raw as DashboardFilter) ? (raw as DashboardFilter) : 'all'
}

export function parseSort(raw: string | null): DashboardSortMode {
  return SORTS.includes(raw as DashboardSortMode) ? (raw as DashboardSortMode) : 'smart'
}

const isBelowTarget = (t: Tracker) =>
  !!(t.threshold_price && t.last_price && t.last_price <= t.threshold_price)

function matchesFilter(t: Tracker, filter: DashboardFilter): boolean {
  switch (filter) {
    case 'all': return t.status !== 'purchased'
    case 'active': return t.status === 'active' && !isErrored(t)
    case 'below-target': return isBelowTarget(t) && t.status !== 'purchased'
    case 'errors': return isErrored(t)
    case 'paused': return t.status === 'paused'
    case 'purchased': return t.status === 'purchased'
  }
}

function matchesQuery(t: Tracker, q: string): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  if (t.title.toLowerCase().includes(needle)) return true
  try { return new URL(t.url).hostname.toLowerCase().includes(needle) } catch { return false }
}

export function filterTrackers(trackers: Tracker[], filter: DashboardFilter, query: string): Tracker[] {
  return trackers.filter(t => matchesFilter(t, filter) && matchesQuery(t, query.trim()))
}

export function filterCounts(trackers: Tracker[]): Record<DashboardFilter, number> {
  const counts = Object.fromEntries(FILTERS.map(f => [f, 0])) as Record<DashboardFilter, number>
  for (const f of FILTERS) counts[f] = trackers.filter(t => matchesFilter(t, f)).length
  return counts
}

export function sortTrackers(trackers: Tracker[], mode: DashboardSortMode): Tracker[] {
  if (mode === 'smart') return trackers
  const copy = [...trackers]
  switch (mode) {
    case 'price':
      return copy.sort((a, b) => (a.last_price ?? Infinity) - (b.last_price ?? Infinity))
    case 'recent':
      return copy.sort((a, b) =>
        new Date(b.last_checked ?? 0).getTime() - new Date(a.last_checked ?? 0).getTime())
    case 'alpha':
      return copy.sort((a, b) => a.title.localeCompare(b.title))
  }
}
```

Check `isErrored`'s exact signature in `client/src/lib/dashboard-sort.ts` first and match it (the /errors page and stat cards use it — the spec requires lockstep counts).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/price-tracker/client && npx vitest run src/lib/dashboard-filter.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
cd /root/price-tracker && git add client/src/lib/dashboard-filter.ts client/src/lib/dashboard-filter.test.ts
git commit -m "feat(client): dashboard filter/sort logic

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Vendored bits — `CountUp` + below-target glow CSS

**Files:**
- Create: `client/src/components/bits/CountUp.tsx`
- Create: `client/src/components/bits/bits.css`
- Modify: `client/src/index.css` (one `@import`)
- Test: `client/src/components/bits/CountUp.test.tsx`

**Interfaces:**
- Produces: `<CountUp value={number} prefix?: string decimals?: number className?: string />` — animates 0→value over 600ms with rAF; renders final value immediately under reduced motion. CSS class `bit-border-glow` for card glow.

- [ ] **Step 1: Write the failing test**

```tsx
// client/src/components/bits/CountUp.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import CountUp from './CountUp'

describe('CountUp', () => {
  beforeEach(() => {
    // jsdom has matchMedia only if mocked
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  })
  it('renders the final value immediately under prefers-reduced-motion', () => {
    render(<CountUp value={42} />)
    expect(screen.getByText('42')).toBeInTheDocument()
  })
  it('applies prefix and decimals', () => {
    render(<CountUp value={12.5} prefix="$" decimals={2} />)
    expect(screen.getByText('$12.50')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /root/price-tracker/client && npx vitest run src/components/bits/CountUp.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CountUp (ReactBits-style, CSS/rAF reimplementation — no GSAP)**

```tsx
// client/src/components/bits/CountUp.tsx
// Vendored-in-spirit from reactbits.dev Count Up, reimplemented on rAF to
// honor the no-new-runtime-deps constraint.
import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  prefix?: string
  decimals?: number
  durationMs?: number
  className?: string
}

const prefersReducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export default function CountUp({ value, prefix = '', decimals = 0, durationMs = 600, className }: Props) {
  const [display, setDisplay] = useState(() => (prefersReducedMotion() ? value : 0))
  const frame = useRef<number | null>(null)

  useEffect(() => {
    if (prefersReducedMotion()) { setDisplay(value); return }
    const start = performance.now()
    const from = 0
    const tick = (now: number) => {
      const p = Math.min((now - start) / durationMs, 1)
      const eased = 1 - Math.pow(1 - p, 3) // easeOutCubic
      setDisplay(from + (value - from) * eased)
      if (p < 1) frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => { if (frame.current) cancelAnimationFrame(frame.current) }
  }, [value, durationMs])

  return <span className={className}>{prefix}{display.toFixed(decimals)}</span>
}
```

- [ ] **Step 4: Add the glow CSS and import it**

```css
/* client/src/components/bits/bits.css */
/* Vendored-in-spirit from reactbits.dev Border Glow (new) — plain CSS. */
.bit-border-glow {
  position: relative;
  border-color: color-mix(in srgb, var(--color-success) 45%, var(--color-border)) !important;
  box-shadow: 0 0 14px rgba(16, 185, 129, 0.12);
  transition: box-shadow 0.3s ease;
}
.bit-border-glow:hover { box-shadow: 0 0 22px rgba(16, 185, 129, 0.22); }
@media (prefers-reduced-motion: reduce) {
  .bit-border-glow, .bit-border-glow:hover { transition: none; }
}
```

In `client/src/index.css`, immediately after the existing top-of-file imports, add:

```css
@import './components/bits/bits.css';
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cd /root/price-tracker/client && npx vitest run src/components/bits/CountUp.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /root/price-tracker && git add client/src/components/bits client/src/index.css
git commit -m "feat(client): vendor CountUp + border-glow bits (CSS/rAF, no deps)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Dashboard toolbar + URL-synced filtering

**Files:**
- Create: `client/src/components/DashboardToolbar.tsx`
- Modify: `client/src/pages/Dashboard.tsx`
- Test: extend `client/src/pages/Dashboard.test.tsx`

**Interfaces:**
- Consumes: everything from Task 1; existing `buildDashboardLayout` (smart sort), `StatCards`, `TrackerCard`, `CategoryCard`.
- Produces: `<DashboardToolbar filter counts sort query onQueryChange onFilterChange onSortChange />` with props typed:

```typescript
interface DashboardToolbarProps {
  filter: DashboardFilter
  counts: Record<DashboardFilter, number>
  sort: DashboardSortMode
  query: string
  onQueryChange: (q: string) => void
  onFilterChange: (f: DashboardFilter) => void
  onSortChange: (s: DashboardSortMode) => void
}
```

- [ ] **Step 1: Write failing component tests** (extend `Dashboard.test.tsx` — follow its existing render/mocking pattern for api calls; read the file first and reuse its helpers)

Test cases to add (use the file's existing mock-tracker fixtures, extended to cover paused/purchased/errored/below-target):

```tsx
it('filter chips show live counts and filter the grid', async () => {
  // render dashboard with fixture of 5 trackers as in lib test
  // click chip "Errors" → only errored tracker's title visible
  // chip has text like "Errors" and count badge "1"
})
it('search input filters by title', async () => {
  // type "ssd" → only SSD tracker visible
})
it('filter state syncs to URL and back', async () => {
  // render at /?filter=errors → Errors chip is selected on load
  // click "Paused" chip → URL contains filter=paused (assert via window.location.search
  //   or the router's location when using MemoryRouter + a location probe)
})
it('unknown filter param falls back to All', async () => {
  // render at /?filter=bogus → All chip selected, no crash
})
it('purchased chip replaces the old checkbox', async () => {
  // no checkbox labeled "Show purchased" anymore
  // Purchased chip shows count 1 and reveals the purchased tracker
})
```

- [ ] **Step 2: Run tests, verify the new cases fail**

Run: `cd /root/price-tracker/client && npx vitest run src/pages/Dashboard.test.tsx`
Expected: new cases FAIL (missing toolbar), pre-existing cases still pass.

- [ ] **Step 3: Implement `DashboardToolbar`**

```tsx
// client/src/components/DashboardToolbar.tsx
import { Search } from 'lucide-react'
import type { DashboardFilter, DashboardSortMode } from '../lib/dashboard-filter'

const CHIP_LABELS: Record<DashboardFilter, string> = {
  all: 'All', active: 'Active', 'below-target': 'Below target',
  errors: 'Errors', paused: 'Paused', purchased: 'Purchased',
}
const CHIP_ORDER: DashboardFilter[] = ['all', 'active', 'below-target', 'errors', 'paused', 'purchased']
const SORT_LABELS: Record<DashboardSortMode, string> = {
  smart: 'Smart', price: 'Price', recent: 'Recently checked', alpha: 'A–Z',
}

interface DashboardToolbarProps {
  filter: DashboardFilter
  counts: Record<DashboardFilter, number>
  sort: DashboardSortMode
  query: string
  onQueryChange: (q: string) => void
  onFilterChange: (f: DashboardFilter) => void
  onSortChange: (s: DashboardSortMode) => void
}

export default function DashboardToolbar({ filter, counts, sort, query, onQueryChange, onFilterChange, onSortChange }: DashboardToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <input
          type="search"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          placeholder="Filter trackers…"
          aria-label="Filter trackers"
          className="pl-9 pr-3 py-2 w-56 bg-surface border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-primary/60"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
        {CHIP_ORDER.map(f => {
          // Hide empty niche chips (paused/purchased/errors with 0) to avoid clutter;
          // All / Active / Below target always show.
          if (counts[f] === 0 && (f === 'paused' || f === 'purchased' || f === 'errors')) return null
          const selected = filter === f
          return (
            <button
              key={f}
              type="button"
              aria-pressed={selected}
              onClick={() => onFilterChange(f)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                selected
                  ? 'bg-primary text-white border-primary'
                  : 'bg-surface text-text-muted border-border hover:text-text hover:border-primary/50'
              }`}
            >
              {CHIP_LABELS[f]} <span className={selected ? 'opacity-80' : 'opacity-60'}>{counts[f]}</span>
            </button>
          )
        })}
      </div>
      <label className="ml-auto flex items-center gap-2 text-xs text-text-muted">
        Sort
        <select
          value={sort}
          onChange={e => onSortChange(e.target.value as DashboardSortMode)}
          className="bg-surface border border-border rounded-lg px-2 py-1.5 text-sm text-text focus:outline-none focus:border-primary/60"
        >
          {Object.entries(SORT_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
    </div>
  )
}
```

- [ ] **Step 4: Wire into `Dashboard.tsx`**

Replace the `showPurchased` state + checkbox with URL-driven state. Key edits:

```tsx
import { useSearchParams } from 'react-router-dom'
import DashboardToolbar from '../components/DashboardToolbar'
import { parseFilter, parseSort, filterTrackers, filterCounts, sortTrackers } from '../lib/dashboard-filter'
```

```tsx
const [searchParams, setSearchParams] = useSearchParams()
const [query, setQuery] = useState('')
const filter = parseFilter(searchParams.get('filter'))
const sort = parseSort(searchParams.get('sort'))

const setParam = (key: 'filter' | 'sort', value: string, defaultValue: string) => {
  const next = new URLSearchParams(searchParams)
  if (value === defaultValue) next.delete(key); else next.set(key, value)
  setSearchParams(next, { replace: true })
}

const counts = useMemo(() => filterCounts(trackers), [trackers])
const visibleTrackers = useMemo(
  () => sortTrackers(filterTrackers(trackers, filter, query), sort),
  [trackers, filter, query, sort],
)
```

Grid selection: when `sort === 'smart'` keep `buildDashboardLayout(visibleTrackers)` (categories + buckets); for any other sort, render `visibleTrackers` as a flat `TrackerCard` list (no `CategoryCard` grouping — explicit sort overrides grouping). Header row keeps the h1/counts and Add Tracker button; the checkbox block is deleted; `<DashboardToolbar …/>` renders between the header row and `<StatCards>`, passing `onFilterChange={f => setParam('filter', f, 'all')}` and `onSortChange={s => setParam('sort', s, 'smart')}`.

Also pass the below-target glow: where `TrackerCard` is rendered, compute `const below = !!(item.tracker.threshold_price && item.tracker.last_price && item.tracker.last_price <= item.tracker.threshold_price)` and pass `glow={below}` (Task 5 adds the prop).  Until Task 5 lands, skip the prop — note it and add in Task 5.

- [ ] **Step 5: Run the full dashboard test file, verify pass**

Run: `cd /root/price-tracker/client && npx vitest run src/pages/Dashboard.test.tsx`
Expected: PASS including pre-existing cases.

- [ ] **Step 6: Commit**

```bash
cd /root/price-tracker && git add client/src/components/DashboardToolbar.tsx client/src/pages/Dashboard.tsx client/src/pages/Dashboard.test.tsx
git commit -m "feat(client): dashboard toolbar — search, filter chips, sort, URL sync

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Fold the three filter pages into redirects

**Files:**
- Modify: `client/src/App.tsx` (routes)
- Delete: `client/src/pages/Active.tsx`, `client/src/pages/BelowTarget.tsx`, `client/src/pages/Errors.tsx` (+ their `.test.tsx` files if present)
- Test: create `client/src/App.redirects.test.tsx`

**Interfaces:**
- Consumes: `DashboardFilter` values from Task 1 (`active`, `below-target`, `errors`).

- [ ] **Step 1: Write failing redirect tests**

```tsx
// client/src/App.redirects.test.tsx
// Follow the render/mock pattern used by Dashboard.test.tsx (auth context +
// api mocks) — reuse its setup helpers. Assert that navigating to the legacy
// routes lands on the dashboard with the right filter param.
import { describe, it, expect } from 'vitest'
// render <App/> inside MemoryRouter with initialEntries=['/errors'] etc.

it('/errors redirects to /?filter=errors', async () => { /* assert location.search === '?filter=errors' and dashboard heading present */ })
it('/below-target redirects to /?filter=below-target', async () => { /* … */ })
it('/active redirects to /?filter=active', async () => { /* … */ })
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /root/price-tracker/client && npx vitest run src/App.redirects.test.tsx`
Expected: FAIL (routes render the old pages).

- [ ] **Step 3: Swap routes for redirects and delete the pages**

In `App.tsx`: remove the three `lazy()` imports (`BelowTarget`, `Errors`, `Active`), add `Navigate` to the react-router import, and replace the three routes:

```tsx
<Route path="/below-target" element={<Navigate to="/?filter=below-target" replace />} />
<Route path="/errors" element={<Navigate to="/?filter=errors" replace />} />
<Route path="/active" element={<Navigate to="/?filter=active" replace />} />
```

Then `git rm client/src/pages/Active.tsx client/src/pages/BelowTarget.tsx client/src/pages/Errors.tsx` (and their test files if they exist — check with `ls client/src/pages/*.test.tsx`). Grep for imports of the deleted pages (`grep -rn "pages/Active\|pages/BelowTarget\|pages/Errors" client/src`) — must be zero hits.

- [ ] **Step 4: Run full test suite** (deleting pages can break other tests)

Run: `cd /root/price-tracker/client && npx vitest run`
Expected: PASS. Fix any test that referenced the deleted pages by re-pointing it at the redirect behavior.

- [ ] **Step 5: Commit**

```bash
cd /root/price-tracker && git add -A client/src
git commit -m "refactor(client): fold Active/BelowTarget/Errors pages into dashboard filter redirects

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: StatCards select chips in place + CountUp; TrackerCard glow

**Files:**
- Modify: `client/src/components/StatCards.tsx`
- Modify: `client/src/components/TrackerCard.tsx`
- Modify: `client/src/pages/Dashboard.tsx` (pass `glow`)
- Test: extend `client/src/pages/Dashboard.test.tsx`

**Interfaces:**
- Consumes: `CountUp` (Task 2), `bit-border-glow` class (Task 2), `DashboardFilter` (Task 1).
- Produces: `StatCards` gains `onSelectFilter: (f: DashboardFilter) => void` prop; `TrackerCard` gains optional `glow?: boolean` prop.

- [ ] **Step 1: Write failing tests** (in `Dashboard.test.tsx`)

```tsx
it('clicking the Errors stat card selects the Errors chip in place (no navigation)', async () => {
  // click stat card "Errors" → Errors chip aria-pressed=true, URL has filter=errors,
  // location.pathname still '/'
})
it('below-target cards carry the glow class', async () => {
  // the SSD tracker card's root element has class 'bit-border-glow'
})
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /root/price-tracker/client && npx vitest run src/pages/Dashboard.test.tsx`

- [ ] **Step 3: Implement**

`StatCards.tsx`:
- Add `onSelectFilter: (f: DashboardFilter) => void` to `Props`; import the type from `../lib/dashboard-filter` and `CountUp` from `./bits/CountUp`.
- Replace the `href` fields: Active → `onClick: () => onSelectFilter('active')` (when count > 0), Below Target → `'below-target'`, Errors → `'errors'`. Remove the `Link` branch entirely (Potential Savings keeps its celebration `onClick`). Every clickable card renders as the existing `<button>` branch.
- Value rendering: `<div className="text-xl font-bold">` becomes `<CountUp value={…} />` — for Active/Below Target/Errors pass the raw number; for Potential Savings pass `value={totalSavings} prefix="$" decimals={2}` when `totalSavings > 0`, else keep the `--` string as-is.

`TrackerCard.tsx`:
- Add `glow?: boolean` to its props interface; on the root card element append `` `${glow ? ' bit-border-glow' : ''}` `` to the existing className template.

`Dashboard.tsx`:
- `<StatCards trackers={trackers} onSelectFilter={f => setParam('filter', f, 'all')} />`
- Pass `glow={below}` per Task 3 Step 4's `below` computation.

- [ ] **Step 4: Run the client suite + typecheck**

Run: `cd /root/price-tracker/client && npx vitest run && npm run build`
Expected: all PASS, build clean (build runs tsc).

- [ ] **Step 5: Commit**

```bash
cd /root/price-tracker && git add client/src/components/StatCards.tsx client/src/components/TrackerCard.tsx client/src/pages/Dashboard.tsx client/src/pages/Dashboard.test.tsx
git commit -m "feat(client): stat cards filter in place + CountUp; below-target card glow

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: NotificationBell + UserMenu + slim nav

**Files:**
- Create: `client/src/components/NotificationBell.tsx`
- Create: `client/src/components/UserMenu.tsx`
- Modify: `client/src/App.tsx`
- Test: `client/src/components/UserMenu.test.tsx`, extend/create `client/src/App.nav.test.tsx`

**Interfaces:**
- Consumes: `useAuth()` (`user.display_name`, `user.role`, `logout`), existing notifications API — check `client/src/api.ts` for the notifications listing function (search `notification`) and reuse it; if it returns items with a read/unread flag, unread = count of unread, else badge = total count capped at `9+`.
- Produces: `<NotificationBell />` (self-fetching), `<UserMenu />` (self-contained, uses `useAuth`).

- [ ] **Step 1: Write failing UserMenu tests**

```tsx
// client/src/components/UserMenu.test.tsx
// Mock useAuth to return { user: { display_name: 'Andrew', role: 'admin' }, logout: vi.fn() }
it('opens on click and shows menu items', async () => { /* click trigger → Purchased, Settings, Admin, Logout visible */ })
it('hides Admin for non-admin users', async () => { /* role: 'user' → no Admin item */ })
it('closes on Escape and returns focus to trigger', async () => { /* open, press Escape → menu gone, document.activeElement === trigger */ })
it('closes on outside click', async () => { /* open, click body → menu gone */ })
it('logout item calls logout', async () => { /* click Logout → logout mock called */ })
```

- [ ] **Step 2: Run, verify fail**

Run: `cd /root/price-tracker/client && npx vitest run src/components/UserMenu.test.tsx`

- [ ] **Step 3: Implement `UserMenu`**

```tsx
// client/src/components/UserMenu.tsx
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ShoppingBag, Settings as SettingsIcon, Shield, LogOut, ChevronDown, CircleUserRound } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const location = useLocation()

  useEffect(() => { setOpen(false) }, [location.pathname])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick) }
  }, [open])

  if (!user) return null

  const itemClass = 'flex items-center gap-2 px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-surface-hover no-underline w-full text-left'

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
      >
        <CircleUserRound className="w-5 h-5" />
        <span className="hidden lg:inline">{user.display_name}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-48 bg-surface border border-border rounded-xl shadow-lg py-1.5 z-50">
          <div className="px-4 py-2 text-xs text-text-muted border-b border-border">{user.display_name}</div>
          <Link role="menuitem" to="/purchased" className={itemClass}><ShoppingBag className="w-4 h-4" />Purchased</Link>
          <Link role="menuitem" to="/settings" className={itemClass}><SettingsIcon className="w-4 h-4" />Settings</Link>
          {user.role === 'admin' && (
            <Link role="menuitem" to="/admin" className={itemClass}><Shield className="w-4 h-4" />Admin</Link>
          )}
          <div className="border-t border-border my-1" />
          <button role="menuitem" type="button" onClick={logout} className={itemClass}><LogOut className="w-4 h-4" />Logout</button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Implement `NotificationBell`**

```tsx
// client/src/components/NotificationBell.tsx
import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Bell } from 'lucide-react'
// Use the real notifications fetcher from ../api — check its name/shape first
// (grep "notification" client/src/api.ts) and adapt the count logic.
import { getNotifications } from '../api'

export default function NotificationBell() {
  const [count, setCount] = useState(0)
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    getNotifications()
      .then(items => { if (!cancelled) setCount(Array.isArray(items) ? items.filter((n: { read?: boolean }) => !n.read).length : 0) })
      .catch(err => { console.error('Notification count failed', err) /* badge hidden, bell still links */ })
    return () => { cancelled = true }
  }, [location.pathname])

  return (
    <Link
      to="/notifications"
      title="Notifications"
      className="relative flex items-center justify-center p-2 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
    >
      <Bell className="w-5 h-5" />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  )
}
```

If `api.ts` has no plain list fetcher or the shape lacks a read flag, badge = total count from whatever the `/notifications` page itself uses (mirror its data call exactly); if nothing suits, badge shows nothing and the bell is just a link — do NOT invent a server endpoint.

- [ ] **Step 5: Slim the nav in `App.tsx`**

Desktop block (replace lines 118–139 content):

```tsx
<div className="hidden md:flex items-center gap-2">
  {navLink('/', 'Dashboard', <BarChart3 className="w-4 h-4" />)}
  {navLink('/deals', 'Deals', <TrendingUp className="w-4 h-4" />)}
  {navLink('/projects', 'Projects', <Package className="w-4 h-4" />)}
  <Link
    to="/add"
    className="flex items-center gap-2 px-4 py-2 ml-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors no-underline"
  >
    <Plus className="w-4 h-4" />
    Add Tracker
  </Link>
  <NotificationBell />
  <UserMenu />
</div>
```

Mobile panel mirrors the grouping: primary links (Dashboard, Deals, Projects, Add Tracker), divider, secondary (Notifications, Purchased, Settings, Admin when admin), divider, name + Logout — reuse the existing `navLink` helper and the existing bottom block. Remove now-unused icon imports (`Inbox`, `ShoppingBag`, `SettingsIcon`, `Shield`, `LogOut` move into the new components; keep what the mobile panel still uses).

- [ ] **Step 6: Nav tests**

```tsx
// client/src/App.nav.test.tsx — same auth/api mocking pattern as other App tests
it('desktop nav shows exactly Dashboard, Deals, Projects as links', () => { /* Settings/Purchased/Notifications not top-level links */ })
it('bell links to /notifications', () => { /* role link with title Notifications */ })
```

- [ ] **Step 7: Run everything**

Run: `cd /root/price-tracker/client && npx vitest run && npm run build && npx eslint src`
Expected: all green, zero lint errors.

- [ ] **Step 8: Commit**

```bash
cd /root/price-tracker && git add client/src/components/NotificationBell.tsx client/src/components/UserMenu.tsx client/src/components/UserMenu.test.tsx client/src/App.tsx client/src/App.nav.test.tsx
git commit -m "feat(client): slim nav — bell + user menu, 3 primary links

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Full verification + PR

**Files:** none (verification).

- [ ] **Step 1: Full client gate**

Run: `cd /root/price-tracker/client && npx vitest run && npm run build && npx eslint src`
Expected: every test green, build clean, lint clean.

- [ ] **Step 2: Cross-workspace sanity** (CI runs all three; run server tests locally to avoid a surprise)

Run: `cd /root/price-tracker/server && npm test 2>/dev/null || echo "check server test script name in server/package.json"`
Expected: green (no server files were touched).

- [ ] **Step 3: LAN-exposed preview + real-browser smoke** (house rule; Playwright MCP cannot reach localhost)

Run: `cd /root/price-tracker/client && npx vite preview --host 0.0.0.0 --port 4173` (background), then drive the Playwright MCP browser at `http://192.168.1.79:4173`:
- log in, dashboard renders, chips filter, search filters, stat card selects chip, user menu opens/closes, bell visible, mobile viewport (resize 390px) hamburger shows grouped items, no console errors.
Note: preview serves the built SPA against the real API only if `/api` is reachable — if the preview 404s API calls, run the smoke against the deployed app post-merge instead and say so in the PR.

- [ ] **Step 4: Push branch + open PR**

```bash
cd /root/price-tracker && git push -u origin feature/dashboard-nav-makeover
gh pr create --title "Dashboard + nav makeover: slim top bar, filter toolbar, folded filter pages" --body "$(cat <<'EOF'
Implements docs/superpowers/specs/2026-07-31-dashboard-nav-makeover-design.md

- Slim nav: Dashboard/Deals/Projects + Add button + notification bell + user menu
- Dashboard toolbar: search, 6 filter chips w/ live counts, sort dropdown, URL-synced
- /active, /below-target, /errors folded into redirects (pages deleted)
- Stat cards filter in place; CountUp + below-target border glow (vendored, no new deps)

Browser smoke: [what was exercised + result]

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Watch CI to green, then merge** (house rule: no `--auto` on unprotected repo — watch then merge; merge triggers the CT302 deploy webhook). Post-merge: verify deployed app loads and chips work, then delete the branch.

---

## Self-Review Notes

- Spec coverage: nav (T6), toolbar+URL (T3), redirects/deletions (T4), stat-cards-in-place + CountUp + glow (T5), light-flavor no-deps rule (T2), tests+smoke (T1–T7). Reduced-motion covered in T2 components.
- `/category/:domain`, CategoryCard, confetti celebration untouched — per spec.
- Sort modes beyond `smart` intentionally flatten category grouping — stated in T3 Step 4.
