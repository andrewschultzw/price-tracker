import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Package } from 'lucide-react'
import { getTrackers, getSparklines } from '../api'
import type { Tracker } from '../types'
import TrackerCard from '../components/TrackerCard'
import CategoryCard from '../components/CategoryCard'
import StatCards from '../components/StatCards'
import useTitle from '../useTitle'
import { canonicalDomain } from '../lib/domains'

const CATEGORY_COLLAPSE_THRESHOLD = 10

function isErrored(t: Tracker): boolean {
  return t.status === 'error' || (t.last_error != null && t.consecutive_failures > 0)
}

function isBelowTarget(t: Tracker): boolean {
  return (
    t.status === 'active' &&
    t.threshold_price != null &&
    t.last_price != null &&
    t.last_price <= t.threshold_price
  )
}

type DashboardItem =
  | { kind: 'tracker'; tracker: Tracker }
  | { kind: 'category'; hostname: string; trackers: Tracker[] }

export default function Dashboard() {
  const [trackers, setTrackers] = useState<Tracker[]>([])
  const [sparklines, setSparklines] = useState<Record<string, number[]>>({})
  const [loading, setLoading] = useState(true)
  useTitle('Dashboard')

  const load = async () => {
    try {
      const [data, sparks] = await Promise.all([getTrackers(), getSparklines()])
      setTrackers(data)
      setSparklines(sparks)
    } catch (err) {
      console.error('Failed to load trackers', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  if (trackers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-80 gap-4">
        <Package className="w-16 h-16 text-text-muted/50" />
        <h2 className="text-xl font-semibold text-text">No trackers yet</h2>
        <p className="text-text-muted">Add a product URL to start tracking prices.</p>
        <Link
          to="/add"
          className="flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg font-medium transition-colors no-underline"
        >
          <Plus className="w-4 h-4" />
          Add Tracker
        </Link>
      </div>
    )
  }

  // Group by hostname; any domain with more than CATEGORY_COLLAPSE_THRESHOLD
  // trackers collapses into a single category card. Categories are placed into
  // the sort bucket matching their worst contained state (errored > below-target
  // > active > paused) so problems and deals still surface at the top even when
  // the underlying items are hidden behind a category.
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

  // Bucket individual trackers
  const erroredItems = individuals.filter(isErrored)
  const erroredIds = new Set(erroredItems.map(t => t.id))
  const remaining = individuals.filter(t => !erroredIds.has(t.id))
  const pausedItems = remaining.filter(t => t.status === 'paused')
  const activeItems = remaining.filter(t => t.status === 'active')
  const belowTargetItems = activeItems.filter(isBelowTarget)
  const activeOtherItems = activeItems.filter(t => !belowTargetItems.includes(t))

  // Bucket categories by worst contained state
  const categoryBuckets = { errored: [] as typeof categories, belowTarget: [] as typeof categories, active: [] as typeof categories, paused: [] as typeof categories }
  for (const cat of categories) {
    if (cat.trackers.some(isErrored)) categoryBuckets.errored.push(cat)
    else if (cat.trackers.some(isBelowTarget)) categoryBuckets.belowTarget.push(cat)
    else if (cat.trackers.some(t => t.status === 'active')) categoryBuckets.active.push(cat)
    else categoryBuckets.paused.push(cat)
  }

  const toTrackerItem = (tracker: Tracker): DashboardItem => ({ kind: 'tracker', tracker })
  const toCategoryItem = (c: { hostname: string; trackers: Tracker[] }): DashboardItem => ({ kind: 'category', hostname: c.hostname, trackers: c.trackers })

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

  // Used only for the header summary counts
  const totalErrored = erroredItems.length + categories.reduce((n, c) => n + c.trackers.filter(isErrored).length, 0)
  const totalActive = trackers.filter(t => t.status === 'active').length

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-text-muted text-sm mt-1">
            {trackers.length} tracker{trackers.length !== 1 ? 's' : ''} &middot;{' '}
            {totalActive} active
            {totalErrored > 0 && <span className="text-danger"> &middot; {totalErrored} error{totalErrored !== 1 ? 's' : ''}</span>}
          </p>
        </div>
        <Link
          to="/add"
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors no-underline"
        >
          <Plus className="w-4 h-4" />
          Add Tracker
        </Link>
      </div>

      <StatCards trackers={trackers} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map(item =>
          item.kind === 'tracker' ? (
            <TrackerCard
              key={`t-${item.tracker.id}`}
              tracker={item.tracker}
              sparklineData={sparklines[item.tracker.id] || []}
              onUpdate={load}
            />
          ) : (
            <CategoryCard
              key={`c-${item.hostname}`}
              hostname={item.hostname}
              trackers={item.trackers}
            />
          ),
        )}
      </div>
    </div>
  )
}
