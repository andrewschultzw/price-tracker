import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Plus, Package } from 'lucide-react'
import { getTrackers, getTrackerStats, getSettings, getOverlapCounts } from '../api'
import type { TrackerStat } from '../api'
import type { Tracker } from '../types'
import TrackerCard from '../components/TrackerCard'
import CategoryCard from '../components/CategoryCard'
import StatCards from '../components/StatCards'
import WelcomeModal from '../components/WelcomeModal'
import DashboardToolbar from '../components/DashboardToolbar'
import useTitle from '../useTitle'
import { buildDashboardLayout } from '../lib/dashboard-sort'
import { parseFilter, parseSort, filterTrackers, filterCounts, sortTrackers } from '../lib/dashboard-filter'

export default function Dashboard() {
  const [trackers, setTrackers] = useState<Tracker[]>([])
  const [stats, setStats] = useState<Record<string, TrackerStat>>({})
  const [notificationsConfigured, setNotificationsConfigured] = useState(true)
  const [overlapCounts, setOverlapCounts] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)
  const [searchParams, setSearchParams] = useSearchParams()
  const [query, setQuery] = useState('')
  useTitle('Dashboard')

  // Filter/sort mode are URL-driven so a filtered view is shareable/
  // bookmarkable and survives a page refresh. Search text stays local
  // component state — it's transient, not something you'd want to link to.
  const filter = parseFilter(searchParams.get('filter'))
  const sort = parseSort(searchParams.get('sort'))

  const setParam = (key: 'filter' | 'sort', value: string, defaultValue: string) => {
    const next = new URLSearchParams(searchParams)
    if (value === defaultValue) next.delete(key)
    else next.set(key, value)
    setSearchParams(next, { replace: true })
  }

  const load = async () => {
    try {
      const [data, trackerStats, settings, counts] = await Promise.all([getTrackers(), getTrackerStats(), getSettings(), getOverlapCounts()])
      setTrackers(data)
      setStats(trackerStats)
      setNotificationsConfigured(
        !!(settings.discord_webhook_url || settings.ntfy_url || settings.generic_webhook_url),
      )
      setOverlapCounts(counts)
    } catch (err) {
      console.error('Failed to load trackers', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Hooks must run on every render in the same order — keep these above
  // the loading/empty early returns. Both derivations are cheap (single
  // pass over the trackers array) so the wasted work on the loading
  // render is negligible compared with the bug a hooks-order mismatch
  // causes: React unmounts the whole tree and you get a blank page.
  const counts = useMemo(() => filterCounts(trackers), [trackers])
  const visibleTrackers = useMemo(
    () => sortTrackers(filterTrackers(trackers, filter, query), sort),
    [trackers, filter, query, sort],
  )

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  if (trackers.length === 0) {
    return (
      <>
        <WelcomeModal hasNoTrackers={true} />
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
      </>
    )
  }

  // Header counts describe the whole (non-purchased) collection, not the
  // currently narrowed view — a chip that filters the grid down to "Errors"
  // shouldn't also make the "X active" summary above it read as 0.
  const { totalErrored, totalActive } = buildDashboardLayout(trackers.filter(t => t.status !== 'purchased'))

  // "Smart" sort keeps the categorized/bucketed layout (errors first, then
  // below-target, then active, then paused, with same-domain overflow
  // collapsed into CategoryCards). Any explicit sort (price/recent/alpha)
  // overrides that grouping — the user asked for one specific order, so we
  // render a flat list instead of re-bucketing on top of it.
  const items = sort === 'smart'
    ? buildDashboardLayout(visibleTrackers).items
    : visibleTrackers.map(tracker => ({ kind: 'tracker' as const, tracker }))

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
        <div className="flex items-center gap-3">
          <Link
            to="/add"
            className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors no-underline"
          >
            <Plus className="w-4 h-4" />
            Add Tracker
          </Link>
        </div>
      </div>

      <DashboardToolbar
        filter={filter}
        counts={counts}
        sort={sort}
        query={query}
        onQueryChange={setQuery}
        onFilterChange={f => setParam('filter', f, 'all')}
        onSortChange={s => setParam('sort', s, 'smart')}
      />

      <StatCards trackers={trackers} onSelectFilter={f => setParam('filter', f, 'all')} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map(item =>
          item.kind === 'tracker' ? (
            <TrackerCard
              key={`t-${item.tracker.id}`}
              tracker={item.tracker}
              sparklineData={stats[item.tracker.id]?.sparkline || []}
              minPrice={stats[item.tracker.id]?.min_price ?? null}
              onUpdate={load}
              notificationsConfigured={notificationsConfigured}
              overlapCount={overlapCounts[item.tracker.id] ?? 0}
              isPurchased={item.tracker.status === 'purchased'}
              glow={!!(item.tracker.threshold_price && item.tracker.last_price && item.tracker.last_price <= item.tracker.threshold_price)}
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
