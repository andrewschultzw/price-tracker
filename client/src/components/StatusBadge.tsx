import { CheckCircle, PauseCircle, AlertCircle, ShieldOff, ShoppingBag } from 'lucide-react'
import type { TrackerStatus } from '../types'

const statusConfig = {
  active: { icon: CheckCircle, label: 'Active', className: 'text-success bg-success/10' },
  paused: { icon: PauseCircle, label: 'Paused', className: 'text-warning bg-warning/10' },
  error: { icon: AlertCircle, label: 'Error', className: 'text-danger bg-danger/10' },
  // 'blocked' = retailer WAF (Akamai / Cloudflare bot mitigation) is
  // blanket-rejecting our egress IP. Distinct from 'error': not flaky
  // and not user-actionable — the scheduler skips these. Styled in
  // amber (indigo would clash with the active green-ish palette) to
  // read as "attention needed, but not failing".
  blocked: { icon: ShieldOff, label: 'Retailer blocked', className: 'text-amber-700 bg-amber-100 dark:text-amber-200 dark:bg-amber-900/40' },
  // 'purchased' = user logged a purchase. Tracker is removed from the
  // scrape queue (see queries.ts:getDueTrackerUrls) and rendered with
  // a muted green badge so the dashboard signals "done" without looking
  // like an alert state.
  purchased: { icon: ShoppingBag, label: 'Purchased', className: 'text-success bg-success/10' },
}

export default function StatusBadge({ status }: { status: TrackerStatus }) {
  const config = statusConfig[status]
  const Icon = config.icon
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.className}`}>
      <Icon className="w-3.5 h-3.5" />
      {config.label}
    </span>
  )
}
