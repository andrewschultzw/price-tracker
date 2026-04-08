import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, RefreshCw, Trash2, Play, Pause, Pencil } from 'lucide-react'
import { getTracker, getPriceHistory, checkTracker, updateTracker, deleteTracker } from '../api'
import type { Tracker, PriceRecord } from '../types'
import StatusBadge from '../components/StatusBadge'
import PriceChart from '../components/PriceChart'
import useTitle from '../useTitle'

export default function TrackerDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tracker, setTracker] = useState<Tracker | null>(null)
  const [prices, setPrices] = useState<PriceRecord[]>([])
  const [range, setRange] = useState('30d')
  const [loading, setLoading] = useState(true)
  const [checking, setChecking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editThreshold, setEditThreshold] = useState('')
  const [editInterval, setEditInterval] = useState('')

  const trackerId = Number(id)
  useTitle(tracker?.name || 'Tracker')

  const load = async () => {
    try {
      const [t, p] = await Promise.all([
        getTracker(trackerId),
        getPriceHistory(trackerId, range),
      ])
      setTracker(t)
      setPrices(p)
    } catch {
      navigate('/')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [trackerId, range])

  const handleCheck = async () => {
    setChecking(true)
    try {
      await checkTracker(trackerId)
      await load()
    } finally {
      setChecking(false)
    }
  }

  const handleToggleStatus = async () => {
    if (!tracker) return
    const newStatus = tracker.status === 'active' ? 'paused' : 'active'
    await updateTracker(trackerId, { status: newStatus } as Partial<Tracker>)
    await load()
  }

  const handleDelete = async () => {
    if (!confirm('Delete this tracker and all price history?')) return
    await deleteTracker(trackerId)
    navigate('/')
  }

  const handleSaveEdit = async () => {
    await updateTracker(trackerId, {
      name: editName,
      threshold_price: editThreshold ? parseFloat(editThreshold) : null,
      check_interval_minutes: parseInt(editInterval),
    } as Partial<Tracker>)
    setEditing(false)
    await load()
  }

  const startEdit = () => {
    if (!tracker) return
    setEditName(tracker.name)
    setEditThreshold(tracker.threshold_price?.toString() ?? '')
    setEditInterval(tracker.check_interval_minutes.toString())
    setEditing(true)
  }

  if (loading || !tracker) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1.5 text-text-muted hover:text-text text-sm mb-4 no-underline">
        <ArrowLeft className="w-4 h-4" />
        Back to Dashboard
      </Link>

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-4">
          <div className="min-w-0 flex-1">
            {editing ? (
              <input
                value={editName}
                onChange={e => setEditName(e.target.value)}
                className="bg-bg border border-border rounded-lg px-3 py-1.5 text-text text-xl font-bold w-full focus:outline-none focus:border-primary"
              />
            ) : (
              <h1 className="text-xl sm:text-2xl font-bold break-words">{tracker.name}</h1>
            )}
            <a
              href={tracker.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-text-muted text-sm hover:text-primary flex items-center gap-1 mt-1 min-w-0"
            >
              <span className="truncate">{tracker.url}</span>
              <ExternalLink className="w-3.5 h-3.5 flex-shrink-0" />
            </a>
          </div>
          <div className="flex-shrink-0">
            <StatusBadge status={tracker.status} />
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
          <div className="bg-bg rounded-lg p-3">
            <div className="text-xs text-text-muted mb-1">Current Price</div>
            <div className="text-xl font-bold">
              {tracker.last_price != null ? `$${tracker.last_price.toFixed(2)}` : '--'}
            </div>
          </div>
          <div className="bg-bg rounded-lg p-3">
            <div className="text-xs text-text-muted mb-1">Target Price</div>
            {editing ? (
              <input
                type="number"
                value={editThreshold}
                onChange={e => setEditThreshold(e.target.value)}
                step="0.01"
                className="bg-surface border border-border rounded px-2 py-1 text-text text-lg font-bold w-full focus:outline-none focus:border-primary"
              />
            ) : (
              <div className="text-xl font-bold text-warning">
                {tracker.threshold_price ? `$${tracker.threshold_price.toFixed(2)}` : '--'}
              </div>
            )}
          </div>
          <div className="bg-bg rounded-lg p-3">
            <div className="text-xs text-text-muted mb-1">Check Interval</div>
            {editing ? (
              <select
                value={editInterval}
                onChange={e => setEditInterval(e.target.value)}
                className="bg-surface border border-border rounded px-2 py-1 text-text text-sm w-full focus:outline-none focus:border-primary"
              >
                <option value="30">30 min</option>
                <option value="60">1 hour</option>
                <option value="180">3 hours</option>
                <option value="360">6 hours</option>
                <option value="720">12 hours</option>
                <option value="1440">Daily</option>
              </select>
            ) : (
              <div className="text-xl font-bold">
                {tracker.check_interval_minutes >= 60
                  ? `${tracker.check_interval_minutes / 60}h`
                  : `${tracker.check_interval_minutes}m`}
              </div>
            )}
          </div>
          <div className="bg-bg rounded-lg p-3">
            <div className="text-xs text-text-muted mb-1">Data Points</div>
            <div className="text-xl font-bold">{prices.length}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {editing ? (
            <>
              <button onClick={handleSaveEdit} className="px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors">
                Save
              </button>
              <button onClick={() => setEditing(false)} className="px-4 py-2 bg-surface-hover text-text-muted rounded-lg text-sm font-medium transition-colors">
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={handleCheck} disabled={checking} className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
                <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
                Check Now
              </button>
              <button onClick={handleToggleStatus} className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-surface-hover text-text-muted hover:text-text rounded-lg text-sm font-medium transition-colors">
                {tracker.status === 'active' ? <><Pause className="w-4 h-4" /> Pause</> : <><Play className="w-4 h-4" /> Resume</>}
              </button>
              <button onClick={startEdit} className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-surface-hover text-text-muted hover:text-text rounded-lg text-sm font-medium transition-colors">
                <Pencil className="w-4 h-4" /> Edit
              </button>
              <button onClick={handleDelete} className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-danger/10 text-danger hover:bg-danger/20 rounded-lg text-sm font-medium transition-colors sm:ml-auto">
                <Trash2 className="w-4 h-4" /> Delete
              </button>
            </>
          )}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Price History</h2>
          <div className="flex gap-1">
            {['24h', '7d', '30d', '90d'].map(r => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors
                  ${range === r ? 'bg-primary text-white' : 'bg-surface-hover text-text-muted hover:text-text'}`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        <PriceChart data={prices} threshold={tracker.threshold_price} />

        {prices.length > 0 && (
          <div className="mt-4 overflow-auto max-h-64">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-muted text-xs border-b border-border">
                  <th className="text-left py-2 font-medium">Date</th>
                  <th className="text-right py-2 font-medium">Price</th>
                </tr>
              </thead>
              <tbody>
                {[...prices].reverse().slice(0, 50).map(p => (
                  <tr key={p.id} className="border-b border-border/50">
                    <td className="py-2 text-text-muted">
                      {new Date(p.scraped_at.includes('Z') ? p.scraped_at : p.scraped_at + 'Z').toLocaleString()}
                    </td>
                    <td className="py-2 text-right font-medium">${p.price.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
