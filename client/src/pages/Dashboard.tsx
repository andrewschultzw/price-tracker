import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Package } from 'lucide-react'
import { getTrackers, getTrackerStats, getSettings } from '../api'
import type { TrackerStat } from '../api'
import type { Tracker } from '../types'
import TrackerCard from '../components/TrackerCard'
import CategoryCard from '../components/CategoryCard'
import StatCards from '../components/StatCards'
import useTitle from '../useTitle'
import { buildDashboardLayout } from '../lib/dashboard-sort'

export default function Dashboard() {
  const [trackers, setTrackers] = useState<Tracker[]>([])
  const [stats, setStats] = useState<Record<string, TrackerStat>>({})
  const [notificationsConfigured, setNotificationsConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  useTitle('Dashboard')

  const load = async () => {
    try {
      const [data, trackerStats, settings] = await Promise.all([getTrackers(), getTrackerStats(), getSettings()])
      setTrackers(data)
      setStats(trackerStats)
      setNotificationsConfigured(
        !!(settings.discord_webhook_url || settings.ntfy_url || settings.generic_webhook_url),
      )
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

  const { items, totalErrored, totalActive } = buildDashboardLayout(trackers)

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
              sparklineData={stats[item.tracker.id]?.sparkline || []}
              minPrice={stats[item.tracker.id]?.min_price ?? null}
              onUpdate={load}
              notificationsConfigured={notificationsConfigured}
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
