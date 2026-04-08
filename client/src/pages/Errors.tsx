import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, AlertCircle, RefreshCw } from 'lucide-react'
import { getTrackers, getTrackerStats, getSettings, checkTracker } from '../api'
import type { TrackerStat } from '../api'
import type { Tracker } from '../types'
import TrackerCard from '../components/TrackerCard'
import useTitle from '../useTitle'
import { isErrored } from '../lib/dashboard-sort'

/**
 * Dynamic "virtual category" showing every tracker that currently has an
 * error — either the aggregate status flipped to 'error' (all sellers
 * errored) or any individual seller has a transient scrape failure
 * recorded. Mirrors the Below Target page pattern.
 *
 * Has a "Check All Now" button that fans out POST /trackers/:id/check
 * (which already handles multi-seller fanout per tracker) in parallel.
 * Requests hit the server scheduler's PQueue which caps concurrent
 * scrapes, so even a large batch can't overwhelm Playwright.
 */
export default function Errors() {
  const [trackers, setTrackers] = useState<Tracker[]>([])
  const [stats, setStats] = useState<Record<string, TrackerStat>>({})
  const [notificationsConfigured, setNotificationsConfigured] = useState(true)
  const [loading, setLoading] = useState(true)
  const [checkingAll, setCheckingAll] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  useTitle('Errors')

  const load = async () => {
    try {
      const [data, trackerStats, settings] = await Promise.all([
        getTrackers(),
        getTrackerStats(),
        getSettings(),
      ])
      setTrackers(data.filter(isErrored))
      setStats(trackerStats)
      setNotificationsConfigured(
        !!(settings.discord_webhook_url || settings.ntfy_url || settings.generic_webhook_url),
      )
    } catch (err) {
      console.error('Failed to load errored trackers', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleCheckAll = async () => {
    if (trackers.length === 0 || checkingAll) return
    setCheckingAll(true)
    setCheckError(null)
    try {
      // Fire every tracker check in parallel. The server-side PQueue caps
      // real concurrency so this is safe regardless of how many we start.
      // A single failed check shouldn't abort the rest — we want to give
      // every tracker a fresh attempt — so we use allSettled.
      const results = await Promise.allSettled(trackers.map(t => checkTracker(t.id)))
      const failed = results.filter(r => r.status === 'rejected').length
      if (failed > 0) {
        setCheckError(`${failed} tracker${failed !== 1 ? 's' : ''} failed to refresh. Reloading anyway.`)
      }
      await load()
    } finally {
      setCheckingAll(false)
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1.5 text-text-muted hover:text-text text-sm mb-4 no-underline">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <AlertCircle className="w-6 h-6 text-danger flex-shrink-0" />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold">Errors</h1>
            <p className="text-text-muted text-sm mt-0.5">
              {trackers.length === 0
                ? 'Nothing currently errored. Nice.'
                : `${trackers.length} tracker${trackers.length !== 1 ? 's' : ''} need${trackers.length === 1 ? 's' : ''} attention`}
            </p>
          </div>
        </div>
        {trackers.length > 0 && (
          <button
            onClick={handleCheckAll}
            disabled={checkingAll}
            className="flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${checkingAll ? 'animate-spin' : ''}`} />
            {checkingAll ? `Checking ${trackers.length}...` : 'Check All Now'}
          </button>
        )}
      </div>

      {checkError && (
        <div className="mb-4 text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">
          {checkError}
        </div>
      )}

      {trackers.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
          <AlertCircle className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p>No trackers currently have errors.</p>
          <p>Trackers with failed scrapes or stale links will appear here.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {trackers.map(tracker => (
            <TrackerCard
              key={tracker.id}
              tracker={tracker}
              sparklineData={stats[tracker.id]?.sparkline || []}
              minPrice={stats[tracker.id]?.min_price ?? null}
              onUpdate={load}
              notificationsConfigured={notificationsConfigured}
            />
          ))}
        </div>
      )}
    </div>
  )
}
