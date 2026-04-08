import { Link } from 'react-router-dom'
import { Activity, TrendingDown, AlertCircle, DollarSign } from 'lucide-react'
import type { Tracker } from '../types'
import { isErrored } from '../lib/dashboard-sort'

interface Props {
  trackers: Tracker[]
}

export default function StatCards({ trackers }: Props) {
  const active = trackers.filter(t => t.status === 'active').length
  // Use the shared isErrored() helper so the count here stays in lockstep
  // with the /errors page and the dashboard sort's errored bucket.
  const errors = trackers.filter(isErrored).length
  const belowThreshold = trackers.filter(
    t => t.threshold_price && t.last_price && t.last_price <= t.threshold_price
  ).length
  const trackersWithSavings = trackers.filter(
    t => t.threshold_price && t.last_price && t.last_price < t.threshold_price
  )
  const totalSavings = trackersWithSavings.reduce(
    (sum, t) => sum + (t.threshold_price! - t.last_price!), 0
  )

  interface StatCard {
    label: string
    value: string | number
    icon: typeof Activity
    color: string
    bg: string
    href?: string
  }

  const stats: StatCard[] = [
    {
      label: 'Active',
      value: active,
      icon: Activity,
      color: 'text-primary',
      bg: 'bg-primary/10',
    },
    {
      label: 'Below Target',
      value: belowThreshold,
      icon: TrendingDown,
      color: 'text-success',
      bg: 'bg-success/10',
      // Clickable only when there's something to show. Opens a virtual
      // category of every tracker currently at/below its target price.
      href: belowThreshold > 0 ? '/below-target' : undefined,
    },
    {
      label: 'Errors',
      value: errors,
      icon: AlertCircle,
      color: errors > 0 ? 'text-danger' : 'text-text-muted',
      bg: errors > 0 ? 'bg-danger/10' : 'bg-surface-hover',
      // Clickable only when there's something to show. Opens the errors
      // view with a Check All Now button.
      href: errors > 0 ? '/errors' : undefined,
    },
    {
      label: 'Potential Savings',
      value: totalSavings > 0 ? `$${totalSavings.toFixed(2)}` : '--',
      icon: DollarSign,
      color: 'text-warning',
      bg: 'bg-warning/10',
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
      {stats.map(s => {
        const clickable = !!s.href
        const cardClass = `bg-surface border border-border rounded-xl p-4 flex items-center gap-3 h-full transition-colors ${
          clickable ? 'hover:border-primary/50 hover:bg-surface-hover cursor-pointer' : ''
        }`
        const body = (
          <div className={cardClass}>
            <div className={`${s.bg} ${s.color} rounded-lg p-2.5`}>
              <s.icon className="w-5 h-5" />
            </div>
            <div>
              <div className="text-xl font-bold">{s.value}</div>
              <div className="text-xs text-text-muted">{s.label}</div>
            </div>
          </div>
        )
        if (s.href) {
          return (
            <Link
              key={s.label}
              to={s.href}
              className="no-underline block"
              title={`View all ${s.label.toLowerCase()} items`}
            >
              {body}
            </Link>
          )
        }
        return <div key={s.label}>{body}</div>
      })}
    </div>
  )
}
