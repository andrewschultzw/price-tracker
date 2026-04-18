import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, TrendingDown } from 'lucide-react'
import { getTrackers, getTrackerStats, getSettings, getOverlapCounts } from '../api'
import type { TrackerStat } from '../api'
import type { Tracker } from '../types'
import TrackerCard from '../components/TrackerCard'
import useTitle from '../useTitle'

/**
 * Dynamic "virtual category" showing every tracker currently at or below
 * its target price, regardless of retailer. Entered from the "Below Target"
 * stat card on the dashboard. Filter is live — when a tracker's price goes
 * back above threshold it stops appearing here without any manual action.
 *
 * The filter uses the same isBelowTarget logic as dashboard-sort so the
 * "Below Target" badge count on the stat card and the items shown here
 * stay in lockstep.
 */
function isBelowTarget(t: Tracker): boolean {
  return (
    t.status === 'active' &&
    t.threshold_price != null &&
    t.last_price != null &&
    t.last_price <= t.threshold_price
  )
}

export default function BelowTarget() {
  const [trackers, setTrackers] = useState<Tracker[]>([])
  const [stats, setStats] = useState<Record<string, TrackerStat>>({})
  const [notificationsConfigured, setNotificationsConfigured] = useState(true)
  const [overlapCounts, setOverlapCounts] = useState<Record<number, number>>({})
  const [loading, setLoading] = useState(true)
  useTitle('Below Target')

  const load = async () => {
    try {
      const [data, trackerStats, settings, counts] = await Promise.all([
        getTrackers(),
        getTrackerStats(),
        getSettings(),
        getOverlapCounts(),
      ])
      setTrackers(data.filter(isBelowTarget))
      setStats(trackerStats)
      setNotificationsConfigured(
        !!(settings.discord_webhook_url || settings.ntfy_url || settings.generic_webhook_url),
      )
      setOverlapCounts(counts)
    } catch (err) {
      console.error('Failed to load below-target trackers', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  // Sort by largest savings first so the best deals surface at the top.
  const sorted = [...trackers].sort((a, b) => {
    const savingsA = (a.threshold_price ?? 0) - (a.last_price ?? 0)
    const savingsB = (b.threshold_price ?? 0) - (b.last_price ?? 0)
    return savingsB - savingsA
  })

  const totalSavings = sorted.reduce(
    (sum, t) => sum + ((t.threshold_price ?? 0) - (t.last_price ?? 0)),
    0,
  )

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1.5 text-text-muted hover:text-text text-sm mb-4 no-underline">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <TrendingDown className="w-6 h-6 text-success flex-shrink-0" />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Below Target</h1>
          <p className="text-text-muted text-sm mt-0.5">
            {sorted.length === 0
              ? 'Nothing currently below your target prices.'
              : (
                <>
                  {sorted.length} deal{sorted.length !== 1 ? 's' : ''}
                  {totalSavings > 0 && (
                    <span className="text-success"> &middot; ${totalSavings.toFixed(2)} in potential savings</span>
                  )}
                </>
              )}
          </p>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
          <TrendingDown className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p>When a tracker's current price drops to or below its target,</p>
          <p>it will show up here until the price goes back up.</p>
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
