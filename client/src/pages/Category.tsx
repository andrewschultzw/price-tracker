import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Folder } from 'lucide-react'
import { getTrackers, getSparklines, getSettings } from '../api'
import type { Tracker } from '../types'
import TrackerCard from '../components/TrackerCard'
import useTitle from '../useTitle'
import { canonicalDomain } from '../lib/domains'

export default function Category() {
  const { domain: rawDomain } = useParams<{ domain: string }>()
  const domain = rawDomain ? decodeURIComponent(rawDomain) : ''
  const [trackers, setTrackers] = useState<Tracker[]>([])
  const [sparklines, setSparklines] = useState<Record<string, number[]>>({})
  const [notificationsConfigured, setNotificationsConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  useTitle(domain || 'Category')

  const load = async () => {
    try {
      const [data, sparks, settings] = await Promise.all([getTrackers(), getSparklines(), getSettings()])
      setTrackers(data.filter(t => canonicalDomain(t.url) === domain))
      setSparklines(sparks)
      setNotificationsConfigured(!!settings.discord_webhook_url)
    } catch (err) {
      console.error('Failed to load trackers', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [domain])

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  // Same grouping/sort as Dashboard so users see familiar order
  const errored = trackers.filter(
    t => t.status === 'error' || (t.last_error != null && t.consecutive_failures > 0),
  )
  const erroredIds = new Set(errored.map(t => t.id))
  const remaining = trackers.filter(t => !erroredIds.has(t.id))
  const paused = remaining.filter(t => t.status === 'paused')
  const active = remaining.filter(t => t.status === 'active')
  const belowTarget = active.filter(
    t => t.threshold_price != null && t.last_price != null && t.last_price <= t.threshold_price,
  )
  const activeOther = active.filter(t => !belowTarget.includes(t))
  const sorted = [...errored, ...belowTarget, ...activeOther, ...paused]

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1.5 text-text-muted hover:text-text text-sm mb-4 no-underline">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      <div className="flex items-center gap-3 mb-6">
        <Folder className="w-6 h-6 text-primary flex-shrink-0" />
        <div className="min-w-0">
          <h1 className="text-2xl font-bold truncate">{domain}</h1>
          <p className="text-text-muted text-sm mt-0.5">
            {trackers.length} tracker{trackers.length !== 1 ? 's' : ''}
            {errored.length > 0 && <span className="text-danger"> &middot; {errored.length} error{errored.length !== 1 ? 's' : ''}</span>}
          </p>
        </div>
      </div>

      {sorted.length === 0 ? (
        <div className="text-text-muted text-center py-12">No trackers for this domain.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sorted.map(tracker => (
            <TrackerCard
              key={tracker.id}
              tracker={tracker}
              sparklineData={sparklines[tracker.id] || []}
              onUpdate={load}
              notificationsConfigured={notificationsConfigured}
            />
          ))}
        </div>
      )}
    </div>
  )
}
