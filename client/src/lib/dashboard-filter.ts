import type { Tracker } from '../types'
import { isErrored } from './dashboard-sort'

export type DashboardFilter = 'all' | 'active' | 'below-target' | 'errors' | 'paused' | 'purchased'
export type DashboardSortMode = 'smart' | 'price' | 'recent' | 'alpha'

const FILTERS: DashboardFilter[] = ['all', 'active', 'below-target', 'errors', 'paused', 'purchased']
const SORTS: DashboardSortMode[] = ['smart', 'price', 'recent', 'alpha']

// Shared human-readable labels — used by both the toolbar chips and the
// Dashboard empty state, so a filter name only has one spelling in the UI.
export const FILTER_LABELS: Record<DashboardFilter, string> = {
  all: 'All', active: 'Active', 'below-target': 'Below target',
  errors: 'Errors', paused: 'Paused', purchased: 'Purchased',
}

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
  if (t.name.toLowerCase().includes(needle)) return true
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
        new Date(b.last_checked_at ?? 0).getTime() - new Date(a.last_checked_at ?? 0).getTime())
    case 'alpha':
      return copy.sort((a, b) => a.name.localeCompare(b.name))
  }
}
