import { Activity, TrendingDown, AlertCircle, DollarSign } from 'lucide-react'
import type { Tracker } from '../types'

interface Props {
  trackers: Tracker[]
}

export default function StatCards({ trackers }: Props) {
  const active = trackers.filter(t => t.status === 'active').length
  const errors = trackers.filter(t => t.status === 'error').length
  const belowThreshold = trackers.filter(
    t => t.threshold_price && t.last_price && t.last_price <= t.threshold_price
  ).length
  const trackersWithSavings = trackers.filter(
    t => t.threshold_price && t.last_price && t.last_price < t.threshold_price
  )
  const totalSavings = trackersWithSavings.reduce(
    (sum, t) => sum + (t.threshold_price! - t.last_price!), 0
  )

  const stats = [
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
    },
    {
      label: 'Errors',
      value: errors,
      icon: AlertCircle,
      color: errors > 0 ? 'text-danger' : 'text-text-muted',
      bg: errors > 0 ? 'bg-danger/10' : 'bg-surface-hover',
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
      {stats.map(s => (
        <div key={s.label} className="bg-surface border border-border rounded-xl p-4 flex items-center gap-3">
          <div className={`${s.bg} ${s.color} rounded-lg p-2.5`}>
            <s.icon className="w-5 h-5" />
          </div>
          <div>
            <div className="text-xl font-bold">{s.value}</div>
            <div className="text-xs text-text-muted">{s.label}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
