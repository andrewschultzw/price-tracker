import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Package } from 'lucide-react'
import { getTrackers, getSparklines } from '../api'
import type { Tracker } from '../types'
import TrackerCard from '../components/TrackerCard'
import StatCards from '../components/StatCards'
import useTitle from '../useTitle'

export default function Dashboard() {
  const [trackers, setTrackers] = useState<Tracker[]>([])
  const [sparklines, setSparklines] = useState<Record<string, number[]>>({})
  const [loading, setLoading] = useState(true)
  useTitle('Dashboard')

  const load = async () => {
    try {
      const [data, sparks] = await Promise.all([getTrackers(), getSparklines()])
      setTrackers(data)
      setSparklines(sparks)
    } catch (err) {
      console.error('Failed to load trackers', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  if (trackers.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-80 gap-4">
        <Package className="w-16 h-16 text-text-muted/50" />
        <h2 className="text-xl font-semibold text-text">No trackers yet</h2>
        <p className="text-text-muted">Add a product URL to start tracking prices.</p>
        <Link
          to="/add"
          className="flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg font-medium transition-colors no-underline"
        >
          <Plus className="w-4 h-4" />
          Add Tracker
        </Link>
      </div>
    )
  }

  const active = trackers.filter(t => t.status === 'active')
  const paused = trackers.filter(t => t.status === 'paused')
  const errored = trackers.filter(t => t.status === 'error')
  const belowTarget = active.filter(
    t => t.threshold_price != null && t.last_price != null && t.last_price <= t.threshold_price,
  )
  const activeOther = active.filter(t => !belowTarget.includes(t))

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-text-muted text-sm mt-1">
            {trackers.length} tracker{trackers.length !== 1 ? 's' : ''} &middot;{' '}
            {active.length} active
            {errored.length > 0 && <span className="text-danger"> &middot; {errored.length} error</span>}
          </p>
        </div>
        <Link
          to="/add"
          className="flex items-center gap-2 px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors no-underline"
        >
          <Plus className="w-4 h-4" />
          Add Tracker
        </Link>
      </div>

      <StatCards trackers={trackers} />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...errored, ...belowTarget, ...activeOther, ...paused].map(tracker => (
          <TrackerCard
            key={tracker.id}
            tracker={tracker}
            sparklineData={sparklines[tracker.id] || []}
            onUpdate={load}
          />
        ))}
      </div>
    </div>
  )
}
