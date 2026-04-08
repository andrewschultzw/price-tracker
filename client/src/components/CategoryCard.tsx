import { Link } from 'react-router-dom'
import { Folder, AlertCircle, TrendingDown } from 'lucide-react'
import type { Tracker } from '../types'

function getFaviconUrl(hostname: string): string {
  // Local proxy so we don't leak the user's retailer list to a third party
  // (see server/src/routes/favicon.ts).
  return `/api/favicon?domain=${encodeURIComponent(hostname)}`
}

interface Props {
  hostname: string
  trackers: Tracker[]
}

export default function CategoryCard({ hostname, trackers }: Props) {
  const erroredCount = trackers.filter(
    t => t.status === 'error' || (t.last_error != null && t.consecutive_failures > 0),
  ).length
  const belowTargetCount = trackers.filter(
    t => t.status === 'active' && t.threshold_price != null && t.last_price != null && t.last_price <= t.threshold_price,
  ).length
  const pausedCount = trackers.filter(t => t.status === 'paused').length

  return (
    <Link
      to={`/category/${encodeURIComponent(hostname)}`}
      className="group block bg-surface border border-border rounded-xl p-5 hover:border-primary/50 hover:shadow-[0_0_20px_rgba(99,102,241,0.08)] transition-all no-underline"
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Folder className="w-4 h-4 text-primary flex-shrink-0" />
            <h3 className="text-text font-semibold text-base truncate">{hostname}</h3>
          </div>
          <div className="text-text-muted text-xs mt-0.5 flex items-center gap-1.5">
            <img
              src={getFaviconUrl(hostname)}
              alt=""
              className="w-3.5 h-3.5 rounded-sm flex-shrink-0"
              onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            Category
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-3xl font-bold tracking-tight text-text">{trackers.length}</div>
          <div className="text-xs text-text-muted">trackers</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {erroredCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-danger bg-danger/10 rounded-full px-2.5 py-1">
            <AlertCircle className="w-3 h-3" />
            {erroredCount} error{erroredCount !== 1 ? 's' : ''}
          </span>
        )}
        {belowTargetCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success bg-success/10 rounded-full px-2.5 py-1">
            <TrendingDown className="w-3 h-3" />
            {belowTargetCount} below target
          </span>
        )}
        {pausedCount > 0 && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-text-muted bg-surface-hover rounded-full px-2.5 py-1">
            {pausedCount} paused
          </span>
        )}
      </div>
    </Link>
  )
}
