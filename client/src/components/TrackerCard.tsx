import { Link } from 'react-router-dom'
import { ExternalLink, Clock, RefreshCw } from 'lucide-react'
import type { Tracker } from '../types'
import StatusBadge from './StatusBadge'
import Sparkline from './Sparkline'
import { checkTracker } from '../api'
import { useState } from 'react'

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const date = new Date(dateStr.includes('Z') ? dateStr : dateStr + 'Z')
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'Just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function getHostname(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

function getFaviconUrl(url: string): string {
  const hostname = getHostname(url)
  return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`
}

interface Props {
  tracker: Tracker
  sparklineData: number[]
  onUpdate: () => void
}

export default function TrackerCard({ tracker, sparklineData, onUpdate }: Props) {
  const [checking, setChecking] = useState(false)

  const handleCheck = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setChecking(true)
    try {
      await checkTracker(tracker.id)
      onUpdate()
    } catch {
      // Error will be reflected in tracker state
    } finally {
      setChecking(false)
    }
  }

  const belowThreshold = tracker.threshold_price && tracker.last_price && tracker.last_price <= tracker.threshold_price

  return (
    <Link
      to={`/tracker/${tracker.id}`}
      className="group block bg-surface border border-border rounded-xl p-5 hover:border-primary/50 hover:shadow-[0_0_20px_rgba(99,102,241,0.08)] transition-all no-underline"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-text font-semibold text-base truncate">{tracker.name}</h3>
          <a
            href={tracker.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-text-muted text-xs hover:text-primary flex items-center gap-1.5 mt-0.5 truncate"
          >
            <img
              src={getFaviconUrl(tracker.url)}
              alt=""
              className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            {getHostname(tracker.url)}
            <ExternalLink className="w-3 h-3 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
          </a>
        </div>
        <StatusBadge status={tracker.status} />
      </div>

      <div className="flex items-end justify-between">
        <div>
          <div className={`text-3xl font-bold tracking-tight ${belowThreshold ? 'text-success' : 'text-text'}`}>
            {tracker.last_price != null ? `$${tracker.last_price.toFixed(2)}` : '--'}
          </div>
          {tracker.threshold_price && (
            <div className="text-xs text-text-muted mt-0.5">
              Target: <span className="text-warning">${tracker.threshold_price.toFixed(2)}</span>
            </div>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <Sparkline data={sparklineData} className="opacity-60 group-hover:opacity-100 transition-opacity" />
          <div className="flex items-center gap-3">
            <div className="text-xs text-text-muted flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {timeAgo(tracker.last_checked_at)}
            </div>
            <button
              onClick={handleCheck}
              disabled={checking}
              className="p-1.5 rounded-lg hover:bg-surface-hover text-text-muted hover:text-primary transition-colors disabled:opacity-50"
              title="Check now"
            >
              <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {tracker.last_error && (
        <div className="mt-3 text-xs text-danger bg-danger/10 rounded-lg px-3 py-2 truncate">
          {tracker.last_error}
        </div>
      )}
    </Link>
  )
}
