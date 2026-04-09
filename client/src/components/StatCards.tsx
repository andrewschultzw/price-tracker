import { lazy, Suspense, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Activity, TrendingDown, AlertCircle, DollarSign } from 'lucide-react'
import type { Tracker } from '../types'
import { isErrored } from '../lib/dashboard-sort'
import { getTier, pickSaying, type SavingsTier } from '../lib/savings-tiers'

// SavingsCelebration pulls in canvas-confetti (~4 KB gzipped but bigger
// raw). Lazy load so the Dashboard's initial render doesn't pay the cost
// — the celebration only fires on an explicit user click anyway.
const SavingsCelebration = lazy(() => import('./SavingsCelebration'))

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

  // Celebration state for the Potential Savings card. Null = no
  // celebration currently playing. Throttled so spam-clicking can't stack
  // multiple overlapping effects.
  const [celebration, setCelebration] = useState<{ tier: SavingsTier; saying: string; amount: number } | null>(null)
  const lastClickRef = useRef(0)

  const handleSavingsClick = useCallback(() => {
    const tier = getTier(totalSavings)
    if (!tier) return
    // Throttle: one celebration every 2 seconds max
    const now = Date.now()
    if (now - lastClickRef.current < 2000) return
    lastClickRef.current = now
    setCelebration({
      tier,
      saying: pickSaying(tier),
      amount: totalSavings,
    })
  }, [totalSavings])

  const savingsClickable = getTier(totalSavings) !== null

  interface StatCard {
    label: string
    value: string | number
    icon: typeof Activity
    color: string
    bg: string
    href?: string
    onClick?: () => void
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
      href: belowThreshold > 0 ? '/below-target' : undefined,
    },
    {
      label: 'Errors',
      value: errors,
      icon: AlertCircle,
      color: errors > 0 ? 'text-danger' : 'text-text-muted',
      bg: errors > 0 ? 'bg-danger/10' : 'bg-surface-hover',
      href: errors > 0 ? '/errors' : undefined,
    },
    {
      label: 'Potential Savings',
      value: totalSavings > 0 ? `$${totalSavings.toFixed(2)}` : '--',
      icon: DollarSign,
      color: 'text-warning',
      bg: 'bg-warning/10',
      onClick: savingsClickable ? handleSavingsClick : undefined,
    },
  ]

  return (
    <>
      {/* stat-cards-grid is a hook for the celebration CSS animations
        * (celebration-shake / celebration-bounce target its children). */}
      <div className="stat-cards-grid grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {stats.map(s => {
          const clickable = !!s.href || !!s.onClick
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
          if (s.onClick) {
            return (
              <button
                key={s.label}
                type="button"
                onClick={s.onClick}
                className="text-left w-full p-0 bg-transparent border-0 block"
                title="Celebrate your savings"
              >
                {body}
              </button>
            )
          }
          return <div key={s.label}>{body}</div>
        })}
      </div>

      {celebration && (
        // No visible fallback — the celebration is conditional and
        // already async from the user's click, so a flash of loading
        // text would be jarring. An empty fragment means the overlay
        // simply appears ~1 frame later if canvas-confetti isn't
        // cached yet.
        <Suspense fallback={null}>
          <SavingsCelebration
            tier={celebration.tier}
            saying={celebration.saying}
            savingsAmount={celebration.amount}
            onDismiss={() => setCelebration(null)}
          />
        </Suspense>
      )}
    </>
  )
}
