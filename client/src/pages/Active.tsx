import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Activity } from 'lucide-react'
import { getTrackers, getTrackerStats, getSettings, getOverlapCounts } from '../api'
import type { TrackerStat } from '../api'
import type { Tracker } from '../types'
import TrackerCard from '../components/TrackerCard'
import { sortByLastCheckedDesc } from '../lib/dashboard-sort'
import useTitle from '../useTitle'

/**
 * Flat view of every active tracker, most-recently-checked first. Entered
 * from the "Active" stat card on the dashboard. Unlike the main dashboard
 * (which groups trackers into retailer categories once a domain has more
 * than CATEGORY_COLLAPSE_THRESHOLD items), this page intentionally shows
 * every individual tracker — it's the "I want to eyeball the whole
 * portfolio at once" view.
 *
 * Filter matches the Active stat card on purpose: `status === 'active'`.
 * Errored trackers appear on /errors, paused trackers are hidden (there's
 * no virtual page for them yet). Keeping this definition identical to the
 * card count means "X active" on the card and the item count on this
 * page never drift.
 */
export default function Active() {
  const [trackers, setTrackers] = useState<Tracker[]>([])
  const [stats, setStats] = useState<Record<string, TrackerStat>>({})
  const [notificationsConfigured, setNotificationsConfigured] = useState(true)
  const [overlapCounts, setOverlapCounts] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)
  useTitle('Active Trackers')

  const load = async () => {
    try {
      const [data, trackerStats, settings, counts] = await Promise.all([
        getTrackers(),
        getTrackerStats(),
        getSettings(),
        getOverlapCounts(),
      ])
      setTrackers(data.filter(t => t.status === 'active'))
      setStats(trackerStats)
      setNotificationsConfigured(
        !!(settings.discord_webhook_url || settings.ntfy_url || settings.generic_webhook_url),
      )
      setOverlapCounts(counts)
    } catch (err) {
      console.error('Failed to load active trackers', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  const sorted = sortByLastCheckedDesc(trackers)

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1.5 text-text-muted hover:text-text text-sm mb-4 no-underline">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <Activity className="w-6 h-6 text-primary flex-shrink-0" />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Active Trackers</h1>
          <p className="text-text-muted text-sm mt-0.5">
            {sorted.length === 0
              ? 'No active trackers.'
              : `${sorted.length} tracker${sorted.length !== 1 ? 's' : ''} · most recently checked first`}
          </p>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
          <Activity className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p>Active trackers will appear here.</p>
          <p>Add one from the dashboard to get started.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sorted.map(tracker => (
            <TrackerCard
              key={tracker.id}
              tracker={tracker}
              sparklineData={stats[tracker.id]?.sparkline || []}
              minPrice={stats[tracker.id]?.min_price ?? null}
              onUpdate={load}
              notificationsConfigured={notificationsConfigured}
              overlapCount={overlapCounts[tracker.id] ?? 0}
            />
          ))}
        </div>
      )}
    </div>
  )
}
