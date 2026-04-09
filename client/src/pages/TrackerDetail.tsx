import { lazy, Suspense, useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, RefreshCw, Trash2, Play, Pause, Pencil, Download, Plus, X, Store } from 'lucide-react'
import {
  getTracker, getPriceHistory, checkTracker, updateTracker, deleteTracker,
  getTrackerStats, getNotificationHistory,
  getTrackerUrls, addTrackerUrl, deleteTrackerUrl,
} from '../api'
import type { NotificationHistoryRow } from '../api'
import type { Tracker, TrackerUrl, PriceRecord } from '../types'
import StatusBadge from '../components/StatusBadge'
import useTitle from '../useTitle'

// PriceChart pulls in recharts (~180 KB). Lazy load it so the initial
// TrackerDetail render can paint everything else while recharts streams
// in. The chart area shows a brief loading state during that window.
const PriceChart = lazy(() => import('../components/PriceChart'))

export default function TrackerDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tracker, setTracker] = useState<Tracker | null>(null)
  const [sellers, setSellers] = useState<TrackerUrl[]>([])
  const [newSellerUrl, setNewSellerUrl] = useState('')
  const [addingSellerBusy, setAddingSellerBusy] = useState(false)
  const [sellerError, setSellerError] = useState<string | null>(null)
  const [prices, setPrices] = useState<PriceRecord[]>([])
  const [allTimeLow, setAllTimeLow] = useState<{ price: number; at: string } | null>(null)
  const [alerts, setAlerts] = useState<NotificationHistoryRow[]>([])
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
      const [t, p, stats, notifs, sellerRows] = await Promise.all([
        getTracker(trackerId),
        getPriceHistory(trackerId, range),
        getTrackerStats(),
        getNotificationHistory(trackerId, 10),
        getTrackerUrls(trackerId),
      ])
      setTracker(t)
      setPrices(p)
      setAlerts(notifs)
      setSellers(sellerRows)
      const stat = stats[trackerId]
      if (stat?.min_price != null && stat?.min_price_at != null) {
        setAllTimeLow({ price: stat.min_price, at: stat.min_price_at })
      } else {
        setAllTimeLow(null)
      }
    } catch {
      navigate('/')
    } finally {
      setLoading(false)
    }
  }

  const handleAddSeller = async () => {
    setSellerError(null)
    const trimmed = newSellerUrl.trim()
    if (!trimmed) return
    setAddingSellerBusy(true)
    try {
      const updated = await addTrackerUrl(trackerId, trimmed)
      setSellers(updated)
      setNewSellerUrl('')
      // Reload to pick up the freshly-scraped price on the tracker card
      await load()
    } catch (err) {
      setSellerError(err instanceof Error ? err.message : String(err))
    } finally {
      setAddingSellerBusy(false)
    }
  }

  const handleDeleteSeller = async (sellerId: number) => {
    if (!confirm('Delete this seller URL? Its price history will be disassociated but not deleted.')) return
    setSellerError(null)
    try {
      const updated = await deleteTrackerUrl(trackerId, sellerId)
      setSellers(updated)
      await load()
    } catch (err) {
      setSellerError(err instanceof Error ? err.message : String(err))
    }
  }

  function getHostname(url: string): string {
    try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
  }

  function timeAgo(dateStr: string | null): string {
    if (!dateStr) return 'Never'
    const date = new Date(dateStr.includes('Z') ? dateStr : dateStr + 'Z')
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
    if (seconds < 60) return 'Just now'
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
    return `${Math.floor(seconds / 86400)}d ago`
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

        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 mb-4">
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
            <div className="text-xs text-text-muted mb-1">All-Time Low</div>
            <div className="text-xl font-bold text-success">
              {allTimeLow ? `$${allTimeLow.price.toFixed(2)}` : '--'}
            </div>
            {allTimeLow && (
              <div className="text-[10px] text-text-muted mt-0.5">
                {new Date(allTimeLow.at.includes('Z') ? allTimeLow.at : allTimeLow.at + 'Z').toLocaleDateString()}
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

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex items-center gap-2 mb-4">
          <Store className="w-5 h-5 text-primary flex-shrink-0" />
          <h2 className="text-lg font-semibold">Sellers</h2>
          <span className="text-xs text-text-muted">
            {sellers.length} {sellers.length === 1 ? 'URL' : 'URLs'} tracked
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-muted text-xs border-b border-border">
                <th className="text-left py-2 font-medium">Seller</th>
                <th className="text-right py-2 font-medium">Price</th>
                <th className="text-left py-2 font-medium pl-4">Last checked</th>
                <th className="text-left py-2 font-medium pl-4">Status</th>
                <th className="py-2 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {sellers.map(s => {
                const host = getHostname(s.url)
                const isLowest =
                  tracker.last_price != null && s.last_price != null &&
                  Math.abs(s.last_price - tracker.last_price) < 0.01
                return (
                  <tr key={s.id} className="border-b border-border/50">
                    <td className="py-2 pr-2 min-w-0">
                      <a
                        href={s.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-text hover:text-primary flex items-center gap-1.5 no-underline"
                      >
                        <span className="truncate">{host}</span>
                        {s.position === 0 && (
                          <span className="text-[10px] text-text-muted bg-surface-hover rounded px-1.5 py-0.5 flex-shrink-0">primary</span>
                        )}
                        {isLowest && sellers.length > 1 && (
                          <span className="text-[10px] text-success bg-success/10 rounded px-1.5 py-0.5 flex-shrink-0">lowest</span>
                        )}
                        <ExternalLink className="w-3 h-3 text-text-muted flex-shrink-0" />
                      </a>
                    </td>
                    <td className="py-2 text-right font-medium whitespace-nowrap">
                      {s.last_price != null ? `$${s.last_price.toFixed(2)}` : '--'}
                    </td>
                    <td className="py-2 pl-4 text-text-muted whitespace-nowrap">
                      {timeAgo(s.last_checked_at)}
                    </td>
                    <td className="py-2 pl-4">
                      {s.last_error ? (
                        <span className="text-danger text-xs" title={s.last_error}>error</span>
                      ) : (
                        <span className="text-text-muted text-xs capitalize">{s.status}</span>
                      )}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => handleDeleteSeller(s.id)}
                        disabled={sellers.length <= 1}
                        title={sellers.length <= 1 ? 'Cannot delete the last seller' : 'Remove seller'}
                        className="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-col sm:flex-row gap-2">
          <input
            type="url"
            value={newSellerUrl}
            onChange={e => setNewSellerUrl(e.target.value)}
            placeholder="https://www.retailer.com/product/..."
            className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text placeholder-text-muted/50 focus:outline-none focus:border-primary"
            onKeyDown={e => { if (e.key === 'Enter') handleAddSeller() }}
          />
          <button
            onClick={handleAddSeller}
            disabled={!newSellerUrl.trim() || addingSellerBusy}
            className="flex items-center justify-center gap-2 px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Plus className="w-4 h-4" />
            {addingSellerBusy ? 'Adding & scraping...' : 'Add Seller'}
          </button>
        </div>
        {sellerError && (
          <div className="mt-2 text-xs text-danger bg-danger/10 rounded-lg px-3 py-2">
            {sellerError}
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <h2 className="text-lg font-semibold">Price History</h2>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`/api/trackers/${trackerId}/export?format=csv`}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-surface-hover text-text-muted hover:text-text transition-colors no-underline"
              title="Download full price history as CSV"
            >
              <Download className="w-3.5 h-3.5" />
              CSV
            </a>
            <a
              href={`/api/trackers/${trackerId}/export?format=json`}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium bg-surface-hover text-text-muted hover:text-text transition-colors no-underline"
              title="Download full price history as JSON"
            >
              <Download className="w-3.5 h-3.5" />
              JSON
            </a>
            <div className="w-px h-5 bg-border mx-1" />
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
        <Suspense fallback={<div className="flex items-center justify-center h-64 text-text-muted text-sm">Loading chart...</div>}>
          <PriceChart data={prices} threshold={tracker.threshold_price} />
        </Suspense>

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

      {alerts.length > 0 && (
        <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mt-6">
          <h2 className="text-lg font-semibold mb-4">Recent Alerts</h2>
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-text-muted text-xs border-b border-border">
                  <th className="text-left py-2 font-medium">Sent</th>
                  <th className="text-left py-2 font-medium pl-4">Seller</th>
                  <th className="text-left py-2 font-medium pl-4">Channel</th>
                  <th className="text-right py-2 font-medium">Price</th>
                  <th className="text-right py-2 font-medium">Savings</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map(a => {
                  let sellerHost = '—'
                  if (a.seller_url) {
                    try { sellerHost = new URL(a.seller_url).hostname.replace(/^www\./, '') } catch { /* keep dash */ }
                  }
                  return (
                    <tr key={a.id} className="border-b border-border/50">
                      <td className="py-2 text-text-muted whitespace-nowrap">
                        {new Date(a.sent_at.includes('Z') ? a.sent_at : a.sent_at + 'Z').toLocaleString()}
                      </td>
                      <td className="py-2 pl-4 text-text-muted">{sellerHost}</td>
                      <td className="py-2 pl-4 text-text-muted capitalize">{a.channel || 'unknown'}</td>
                      <td className="py-2 text-right font-medium">${a.price.toFixed(2)}</td>
                      <td className="py-2 text-right text-success">${(a.threshold_price - a.price).toFixed(2)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
