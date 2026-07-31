import { Search } from 'lucide-react'
import { FILTER_LABELS, type DashboardFilter, type DashboardSortMode } from '../lib/dashboard-filter'

const CHIP_LABELS = FILTER_LABELS
const CHIP_ORDER: DashboardFilter[] = ['all', 'active', 'below-target', 'errors', 'blocked', 'paused', 'purchased']
const SORT_LABELS: Record<DashboardSortMode, string> = {
  smart: 'Smart', price: 'Price', recent: 'Recently checked', alpha: 'A–Z',
}

interface DashboardToolbarProps {
  filter: DashboardFilter
  counts: Record<DashboardFilter, number>
  sort: DashboardSortMode
  query: string
  onQueryChange: (q: string) => void
  onFilterChange: (f: DashboardFilter) => void
  onSortChange: (s: DashboardSortMode) => void
}

export default function DashboardToolbar({ filter, counts, sort, query, onQueryChange, onFilterChange, onSortChange }: DashboardToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4">
      <div className="relative">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
        <input
          type="search"
          value={query}
          onChange={e => onQueryChange(e.target.value)}
          placeholder="Filter trackers…"
          aria-label="Filter trackers"
          className="pl-9 pr-3 py-2 w-56 bg-surface border border-border rounded-lg text-sm text-text placeholder:text-text-muted focus:outline-none focus:border-primary/60"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
        {CHIP_ORDER.map(f => {
          const selected = filter === f
          // Hide empty niche chips (paused/purchased/errors with 0) to avoid clutter;
          // All / Active / Below target always show. The *selected* chip is
          // never hidden, even at count 0 — a URL like ?filter=errors with
          // zero errored trackers must still show the selected chip so the
          // (now-empty) grid has a visible, deselectable filter state
          // instead of silently vanishing.
          if (!selected && counts[f] === 0 && (f === 'paused' || f === 'purchased' || f === 'errors' || f === 'blocked')) return null
          return (
            <button
              key={f}
              type="button"
              aria-pressed={selected}
              onClick={() => onFilterChange(f)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                selected
                  ? 'bg-primary text-white border-primary'
                  : 'bg-surface text-text-muted border-border hover:text-text hover:border-primary/50'
              }`}
            >
              {CHIP_LABELS[f]} <span className={selected ? 'opacity-80' : 'opacity-60'}>{counts[f]}</span>
            </button>
          )
        })}
      </div>
      <label className="ml-auto flex items-center gap-2 text-xs text-text-muted">
        Sort
        <select
          value={sort}
          onChange={e => onSortChange(e.target.value as DashboardSortMode)}
          className="bg-surface border border-border rounded-lg px-2 py-1.5 text-sm text-text focus:outline-none focus:border-primary/60"
        >
          {Object.entries(SORT_LABELS).map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
      </label>
    </div>
  )
}
