import { useEffect, useState } from 'react'
import { TrendingDown } from 'lucide-react'
import { getTrackerPriceStats, updateTracker } from '../api'
import type { Tracker, TrackerPriceStats } from '../types'

interface Props {
  tracker: Tracker
  /** Called with the server's updated tracker after Apply / mode changes. */
  onTrackerUpdated: (t: Tracker) => void
}

const MODE_LABELS: Record<'all' | 'record_only' | 'off', string> = {
  all: 'All record lows (30d / 90d / all-time)',
  record_only: 'All-time lows only',
  off: 'Off',
}

function money(v: number | null): string {
  return v === null ? '—' : `$${v.toFixed(2)}`
}

/**
 * Price Context (deal-intelligence phase 1): windowed min/median from the
 * tracker's own history, where today's price sits, a suggested threshold,
 * and the record-low alert mode. Hidden entirely until the tracker has any
 * history span (brand-new trackers have nothing useful to say).
 */
export function PriceContextCard({ tracker, onTrackerUpdated }: Props) {
  const [stats, setStats] = useState<TrackerPriceStats | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    getTrackerPriceStats(tracker.id)
      .then(s => { if (!cancelled) setStats(s) })
      .catch(() => { /* card is optional context — render nothing on failure */ })
    return () => { cancelled = true }
    // Re-fetch when the visible price or threshold changes (post-check/apply).
  }, [tracker.id, tracker.last_price, tracker.threshold_price])

  if (!stats || stats.span_days === 0) return null

  const { windows } = stats
  const suggestionApplies =
    stats.suggested_threshold !== null &&
    stats.suggested_threshold !== tracker.threshold_price

  async function applySuggestion() {
    if (stats?.suggested_threshold == null) return
    setBusy(true)
    try {
      onTrackerUpdated(await updateTracker(tracker.id, { threshold_price: stats.suggested_threshold }))
    } finally {
      setBusy(false)
    }
  }

  async function changeMode(mode: 'all' | 'record_only' | 'off') {
    setBusy(true)
    try {
      onTrackerUpdated(await updateTracker(tracker.id, { low_alert_mode: mode }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <TrendingDown className="w-4 h-4 text-primary" />
        <h2 className="font-semibold">Price Context</h2>
        <span className="text-xs text-muted ml-auto">{stats.span_days} days tracked</span>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-4 text-sm">
        {([['30 days', windows.w30], ['90 days', windows.w90], ['All-time', windows.all]] as const).map(
          ([label, w]) => (
            <div key={label} className="bg-background rounded-lg p-3">
              <div className="text-xs text-muted mb-1">{label}</div>
              <div className="font-semibold">{money(w.min)}</div>
              <div className="text-xs text-muted">median {money(w.median)}</div>
            </div>
          ),
        )}
      </div>

      {stats.current_percentile_90d !== null && (
        <p className="text-sm text-muted mb-3">
          Today&apos;s price is cheaper than {100 - stats.current_percentile_90d}% of the last 90 days.
        </p>
      )}

      {stats.threshold_staleness === 'stale_low' && (
        <p className="text-sm text-amber-600 dark:text-amber-400 mb-3">
          Your target of {money(tracker.threshold_price)} is below anything seen in{' '}
          {stats.span_days} days of tracking — it may never fire.
        </p>
      )}
      {stats.threshold_staleness === 'stale_high' && (
        <p className="text-sm text-amber-600 dark:text-amber-400 mb-3">
          Your target of {money(tracker.threshold_price)} is at or above the typical price — it
          fires on ordinary days, not deals.
        </p>
      )}

      {suggestionApplies && (
        <div className="flex items-center gap-3 mb-3">
          <span className="text-sm">
            Suggested target: <span className="font-semibold">{money(stats.suggested_threshold)}</span>
            <span className="text-xs text-muted ml-1">(10th percentile of recent daily lows)</span>
          </span>
          <button
            onClick={applySuggestion}
            disabled={busy}
            className="text-sm px-3 py-1 rounded-lg bg-primary text-white disabled:opacity-50"
          >
            Apply
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 text-sm">
        <label htmlFor="low-alert-mode" className="text-muted">
          Record-low alerts
        </label>
        <select
          id="low-alert-mode"
          value={stats.low_alert_mode}
          disabled={busy}
          onChange={e => changeMode(e.target.value as 'all' | 'record_only' | 'off')}
          className="bg-background border border-border rounded-lg px-2 py-1"
        >
          {(Object.keys(MODE_LABELS) as Array<keyof typeof MODE_LABELS>).map(m => (
            <option key={m} value={m}>{MODE_LABELS[m]}</option>
          ))}
        </select>
      </div>
    </div>
  )
}
