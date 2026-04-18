import type { Tracker } from '../types'
import { canonicalDomain } from './domains'

export const CATEGORY_COLLAPSE_THRESHOLD = 10

export function isErrored(t: Tracker): boolean {
  // A tracker counts as errored if:
  //   - aggregated status flipped to 'error' (all sellers errored), OR
  //   - any individual seller has a current scrape error (exposed via
  //     errored_seller_count from the admin query), OR
  //   - legacy: last_error set with consecutive_failures > 0 (pre-multi-
  //     seller rows, still the fallback for single-seller trackers where
  //     the aggregate hasn't flipped yet).
  if (t.status === 'error') return true
  if ((t.errored_seller_count ?? 0) > 0) return true
  return t.last_error != null && t.consecutive_failures > 0
}

export function isBelowTarget(t: Tracker): boolean {
  return (
    t.status === 'active' &&
    t.threshold_price != null &&
    t.last_price != null &&
    t.last_price <= t.threshold_price
  )
}

/**
 * Sort trackers by `last_checked_at` descending — most-recently-checked
 * first. Trackers with no last_checked_at (newly added, never scraped)
 * fall to the bottom. Stable across equal timestamps. Used by the
 * /active page so the user sees fresh data at the top.
 */
export function sortByLastCheckedDesc(trackers: Tracker[]): Tracker[] {
  return [...trackers].sort((a, b) => {
    const at = a.last_checked_at ?? ''
    const bt = b.last_checked_at ?? ''
    if (at === bt) return 0
    if (!at) return 1
    if (!bt) return -1
    return bt.localeCompare(at)
  })
}

export type DashboardItem =
  | { kind: 'tracker'; tracker: Tracker }
  | { kind: 'category'; hostname: string; trackers: Tracker[] }

export interface DashboardLayout {
  items: DashboardItem[]
  totalErrored: number
  totalActive: number
}

/**
 * Arrange trackers into the dashboard grid. Rules:
 *   1. Group by canonical domain. Any domain with more than
 *      CATEGORY_COLLAPSE_THRESHOLD trackers collapses into a single
 *      CategoryCard so the dashboard doesn't drown in one retailer.
 *   2. A category's placement is its "worst" contained state: any error
 *      inside → errored bucket, else any below-target → below-target bucket,
 *      else active bucket, else paused. This way problems and deals still
 *      surface at the top even when individual items are hidden behind a
 *      category.
 *   3. Within each bucket categories render before individual trackers.
 *
 * The function is pure so it can be unit-tested in isolation.
 */
export function buildDashboardLayout(trackers: Tracker[]): DashboardLayout {
  const byDomain = new Map<string, Tracker[]>()
  for (const t of trackers) {
    const h = canonicalDomain(t.url)
    if (!h) continue
    const arr = byDomain.get(h)
    if (arr) arr.push(t); else byDomain.set(h, [t])
  }

  const collapsedDomains = new Set<string>()
  const categories: { hostname: string; trackers: Tracker[] }[] = []
  for (const [domain, group] of byDomain) {
    if (group.length > CATEGORY_COLLAPSE_THRESHOLD) {
      collapsedDomains.add(domain)
      categories.push({ hostname: domain, trackers: group })
    }
  }

  const individuals = trackers.filter(t => !collapsedDomains.has(canonicalDomain(t.url)))

  const erroredItems = individuals.filter(isErrored)
  const erroredIds = new Set(erroredItems.map(t => t.id))
  const remaining = individuals.filter(t => !erroredIds.has(t.id))
  const pausedItems = remaining.filter(t => t.status === 'paused')
  const activeItems = remaining.filter(t => t.status === 'active')
  const belowTargetItems = activeItems.filter(isBelowTarget)
  const belowTargetIds = new Set(belowTargetItems.map(t => t.id))
  const activeOtherItems = activeItems.filter(t => !belowTargetIds.has(t.id))

  const categoryBuckets: Record<'errored' | 'belowTarget' | 'active' | 'paused', typeof categories> = {
    errored: [],
    belowTarget: [],
    active: [],
    paused: [],
  }
  for (const cat of categories) {
    if (cat.trackers.some(isErrored)) categoryBuckets.errored.push(cat)
    else if (cat.trackers.some(isBelowTarget)) categoryBuckets.belowTarget.push(cat)
    else if (cat.trackers.some(t => t.status === 'active')) categoryBuckets.active.push(cat)
    else categoryBuckets.paused.push(cat)
  }

  const toTrackerItem = (tracker: Tracker): DashboardItem => ({ kind: 'tracker', tracker })
  const toCategoryItem = (c: { hostname: string; trackers: Tracker[] }): DashboardItem =>
    ({ kind: 'category', hostname: c.hostname, trackers: c.trackers })

  const items: DashboardItem[] = [
    ...categoryBuckets.errored.map(toCategoryItem),
    ...erroredItems.map(toTrackerItem),
    ...categoryBuckets.belowTarget.map(toCategoryItem),
    ...belowTargetItems.map(toTrackerItem),
    ...categoryBuckets.active.map(toCategoryItem),
    ...activeOtherItems.map(toTrackerItem),
    ...categoryBuckets.paused.map(toCategoryItem),
    ...pausedItems.map(toTrackerItem),
  ]

  const totalErrored =
    erroredItems.length + categories.reduce((n, c) => n + c.trackers.filter(isErrored).length, 0)
  const totalActive = trackers.filter(t => t.status === 'active').length

  return { items, totalErrored, totalActive }
}
