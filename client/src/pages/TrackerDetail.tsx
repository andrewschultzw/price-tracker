import { lazy, Suspense, useEffect, useState } from 'react'
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, RefreshCw, Trash2, Play, Pause, Pencil, Download, Plus, X, Store, Users, TrendingDown, Zap, ShoppingBag } from 'lucide-react'
import {
  getTracker, getPriceHistory, checkTracker, updateTracker, deleteTracker,
  getTrackerStats, getNotificationHistory,
  getTrackerUrls, addTrackerUrl, deleteTrackerUrl, updateTrackerUrlCondition, getOverlap,
  setTrackerWishlist,
  listPurchases, createPurchase,
  setTrackerArm,
} from '../api'
import type { NotificationHistoryRow } from '../api'
import type { Tracker, TrackerUrl, TrackerUrlCondition, PriceRecord, Overlap, Purchase } from '../types'
import { PriceContextCard } from '../components/PriceContextCard'
import PurchaseModal from '../components/PurchaseModal'
import PurchasedBanner from '../components/PurchasedBanner'

const CONDITION_OPTIONS: Array<{ value: TrackerUrlCondition; label: string }> = [
  { value: 'new', label: 'New' },
  { value: 'warehouse', label: 'Warehouse' },
  { value: 'refurb', label: 'Refurbished' },
  { value: 'open_box', label: 'Open Box' },
]

function conditionBadgeClass(c: TrackerUrlCondition): string {
  if (c === 'warehouse') return 'bg-warning/15 text-warning'
  if (c === 'refurb') return 'bg-primary/15 text-primary'
  if (c === 'open_box') return 'bg-success/15 text-success'
  return ''
}

function conditionLabel(c: TrackerUrlCondition): string {
  if (c === 'warehouse') return 'Warehouse'
  if (c === 'refurb') return 'Refurbished'
  if (c === 'open_box') return 'Open Box'
  return 'New'
}
import StatusBadge from '../components/StatusBadge'
import { AIInsightsCard } from '../components/AIInsightsCard'
import useTitle from '../useTitle'

// PriceChart pulls in recharts (~180 KB). Lazy load it so the initial
// TrackerDetail render can paint everything else while recharts streams
// in. The chart area shows a brief loading state during that window.
const PriceChart = lazy(() => import('../components/PriceChart'))

/**
 * Convert an ISO timestamp (UTC) to the value format an
 * <input type="datetime-local"> expects (YYYY-MM-DDTHH:mm in LOCAL time).
 * Returns '' for null/undefined/invalid.
 */
function isoToDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Convert a datetime-local input value (LOCAL time, no timezone) to an
 * ISO 8601 string (UTC). Returns null for empty input.
 */
function dateTimeLocalToIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export default function TrackerDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  // Set by the share-target flow when a shared link matched this tracker.
  const sharedDuplicate = !!(useLocation().state as { sharedDuplicate?: boolean } | null)?.sharedDuplicate
  const [tracker, setTracker] = useState<Tracker | null>(null)
  const [sellers, setSellers] = useState<TrackerUrl[]>([])
  const [newSellerUrl, setNewSellerUrl] = useState('')
  const [newSellerCondition, setNewSellerCondition] = useState<TrackerUrlCondition>('new')
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
  const [overlap, setOverlap] = useState<Overlap | null>(null)
  const [publicSlug, setPublicSlug] = useState<string | null>(null)
  // Doorbuster mode editor state. Local strings (datetime-local format);
  // converted to ISO at save. Empty string = unset.
  const [doorbusterStart, setDoorbusterStart] = useState('')
  const [doorbusterEnd, setDoorbusterEnd] = useState('')
  const [doorbusterInterval, setDoorbusterInterval] = useState('')
  const [doorbusterError, setDoorbusterError] = useState<string | null>(null)
  const [doorbusterSaving, setDoorbusterSaving] = useState(false)
  // Arm-for-purchase state. Seeded from tracker.buy_quantity once the
  // tracker loads (see useEffect below); defaults to '1' until then.
  const [armQuantity, setArmQuantity] = useState('1')
  // Purchase tracking state. `purchases` is filtered client-side from the
  // user's full purchase list — keeps things simple while volume is low.
  const [showPurchaseModal, setShowPurchaseModal] = useState(false)
  const [purchases, setPurchases] = useState<Purchase[]>([])

  const trackerId = Number(id)
  useTitle(tracker?.name || 'Tracker')

  const load = async () => {
    try {
      const [t, p, stats, notifs, sellerRows, overlapData, purchaseList] = await Promise.all([
        getTracker(trackerId),
        getPriceHistory(trackerId, range),
        getTrackerStats(),
        getNotificationHistory(trackerId, 10),
        getTrackerUrls(trackerId),
        getOverlap(trackerId),
        // Filter to this tracker's purchases client-side. The server returns
        // the authed user's whole purchase list, newest first; volume is
        // expected to stay low enough that a 200-row fetch is acceptable.
        listPurchases({ limit: 200 }).catch(() => ({ purchases: [], total: 0 })),
      ])
      setTracker(t)
      // Seed arm quantity from the latest tracker state (default 1 if unset).
      setArmQuantity(t.buy_quantity != null ? String(t.buy_quantity) : '1')
      setPrices(p)
      setAlerts(notifs)
      setSellers(sellerRows)
      setOverlap(overlapData)
      setPurchases(purchaseList.purchases.filter(pp => pp.tracker_id === trackerId))
      // Seed doorbuster editor inputs from the latest tracker state.
      setDoorbusterStart(isoToDateTimeLocal(t.doorbuster_start_at))
      setDoorbusterEnd(isoToDateTimeLocal(t.doorbuster_end_at))
      setDoorbusterInterval(
        t.doorbuster_interval_minutes != null ? String(t.doorbuster_interval_minutes) : ''
      )
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
      const updated = await addTrackerUrl(trackerId, trimmed, newSellerCondition)
      setSellers(updated)
      setNewSellerUrl('')
      setNewSellerCondition('new')
      // Reload to pick up the freshly-scraped price on the tracker card
      await load()
    } catch (err) {
      setSellerError(err instanceof Error ? err.message : String(err))
    } finally {
      setAddingSellerBusy(false)
    }
  }

  const handleChangeSellerCondition = async (sellerId: number, c: TrackerUrlCondition) => {
    setSellerError(null)
    // Optimistic — update local state immediately so the dropdown shows the
    // new value while the PATCH is in flight; revert on failure.
    const before = sellers
    setSellers(sellers.map(s => s.id === sellerId ? { ...s, condition: c } : s))
    try {
      await updateTrackerUrlCondition(trackerId, sellerId, c)
    } catch (err) {
      setSellers(before)
      setSellerError(err instanceof Error ? err.message : String(err))
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

  // Resolve the public-page slug for this tracker (if it has one).
  // Auto-created at tracker creation when normalized_url is present;
  // missing (404) for trackers with un-normalizable URLs.
  useEffect(() => {
    if (!Number.isFinite(trackerId)) return
    fetch(`/api/trackers/${trackerId}/public-slug`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => setPublicSlug(data?.slug ?? null))
      .catch(() => setPublicSlug(null))
  }, [trackerId])

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

  const handleSaveDoorbuster = async () => {
    setDoorbusterError(null)
    const startIso = dateTimeLocalToIso(doorbusterStart)
    const endIso = dateTimeLocalToIso(doorbusterEnd)
    const intervalNum = doorbusterInterval ? parseInt(doorbusterInterval) : NaN
    if (!startIso || !endIso || !Number.isFinite(intervalNum) || intervalNum < 1) {
      setDoorbusterError('All three fields are required; interval must be at least 1 minute.')
      return
    }
    if (new Date(startIso) >= new Date(endIso)) {
      setDoorbusterError('Start must be before end.')
      return
    }
    setDoorbusterSaving(true)
    try {
      await updateTracker(trackerId, {
        doorbuster_start_at: startIso,
        doorbuster_end_at: endIso,
        doorbuster_interval_minutes: intervalNum,
      } as Partial<Tracker>)
      await load()
    } catch (err) {
      setDoorbusterError(err instanceof Error ? err.message : String(err))
    } finally {
      setDoorbusterSaving(false)
    }
  }

  const handleClearDoorbuster = async () => {
    setDoorbusterError(null)
    setDoorbusterSaving(true)
    try {
      await updateTracker(trackerId, {
        doorbuster_start_at: null,
        doorbuster_end_at: null,
        doorbuster_interval_minutes: null,
      } as Partial<Tracker>)
      await load()
    } catch (err) {
      setDoorbusterError(err instanceof Error ? err.message : String(err))
    } finally {
      setDoorbusterSaving(false)
    }
  }

  const handleToggleArm = async () => {
    if (!tracker) return
    const next = !tracker.buy_armed
    await setTrackerArm(trackerId, next, Math.max(1, parseInt(armQuantity) || 1))
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

      {sharedDuplicate && (
        <div className="bg-primary/10 border border-primary/30 text-primary rounded-lg px-4 py-2 mb-4 text-sm">
          You&apos;re already tracking this product — the shared link matched this tracker.
        </div>
      )}

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
            {publicSlug && (
              <a
                href={`/p/${publicSlug}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-text-muted text-xs hover:text-primary flex items-center gap-1 mt-1"
              >
                <span>View public page →</span>
              </a>
            )}
            {/* Wishlist toggle. The PATCH at /api/wishlist/items/:id is the
                primary mutation path; we reload the tracker after to pick up
                the new flag value. is_wishlisted comes back from the server
                as 0/1 — coerce to boolean for the UI state read. */}
            <button
              onClick={async () => {
                const next = !tracker.is_wishlisted
                await setTrackerWishlist(trackerId, next)
                await load()
              }}
              className={`mt-2 text-xs px-2 py-1 rounded inline-flex items-center gap-1 ${
                tracker.is_wishlisted
                  ? 'bg-primary text-white'
                  : 'bg-surface border border-border text-text-muted hover:border-primary'
              }`}
              title={tracker.is_wishlisted ? 'Remove from wishlist' : 'Add to wishlist'}
            >
              {tracker.is_wishlisted ? '🎁 On wishlist' : '+ Add to wishlist'}
            </button>
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
              <button
                onClick={() => setShowPurchaseModal(true)}
                className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-success/15 text-success hover:bg-success/25 rounded-lg text-sm font-medium transition-colors"
                title={purchases.length > 0 ? 'Log another purchase for this tracker' : 'Mark this tracker as purchased'}
              >
                <ShoppingBag className="w-4 h-4" />
                {purchases.length > 0 ? 'Log Another Purchase' : 'Purchased'}
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
                <th className="text-left py-2 font-medium pl-4">Condition</th>
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
                        {s.availability === 'out_of_stock' && (
                          <span
                            className="text-[10px] text-warning bg-warning/10 rounded px-1.5 py-0.5 flex-shrink-0"
                            title="This seller reports the product out of stock — you'll get an alert when it returns"
                          >
                            out of stock
                          </span>
                        )}
                        {s.condition !== 'new' && (
                          <span
                            className={`text-[10px] rounded px-1.5 py-0.5 flex-shrink-0 ${conditionBadgeClass(s.condition)}`}
                            title={`Listing condition: ${conditionLabel(s.condition)}`}
                          >
                            {conditionLabel(s.condition)}
                          </span>
                        )}
                        <ExternalLink className="w-3 h-3 text-text-muted flex-shrink-0" />
                      </a>
                    </td>
                    <td className="py-2 pl-4">
                      <select
                        value={s.condition}
                        onChange={e => handleChangeSellerCondition(s.id, e.target.value as TrackerUrlCondition)}
                        className="bg-bg border border-border rounded px-2 py-0.5 text-xs text-text focus:outline-none focus:border-primary"
                        title="Change listing condition"
                      >
                        {CONDITION_OPTIONS.map(opt => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
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
          <select
            value={newSellerCondition}
            onChange={e => setNewSellerCondition(e.target.value as TrackerUrlCondition)}
            className="bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary"
            title="Listing condition for the new seller URL"
          >
            {CONDITION_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
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

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="w-5 h-5 text-warning" />
          <h2 className="text-lg font-semibold">Doorbuster mode</h2>
          {(() => {
            // Inline status banner (matches the card-badge logic on TrackerCard).
            const start = tracker.doorbuster_start_at ? new Date(tracker.doorbuster_start_at) : null
            const end = tracker.doorbuster_end_at ? new Date(tracker.doorbuster_end_at) : null
            const interval = tracker.doorbuster_interval_minutes
            if (start && end && interval) {
              const now = new Date()
              if (now >= start && now <= end) {
                return (
                  <span className="inline-flex items-center gap-1 text-xs font-medium bg-warning/15 text-warning rounded-full px-2 py-0.5 ml-1">
                    <Zap className="w-3 h-3" /> Active until {end.toLocaleString()}
                  </span>
                )
              }
              if (now < start) {
                return (
                  <span className="text-xs text-text-muted ml-1">
                    Scheduled to start {start.toLocaleString()}
                  </span>
                )
              }
              return (
                <span className="text-xs text-text-muted ml-1">
                  Ended {end.toLocaleString()}
                </span>
              )
            }
            return null
          })()}
        </div>
        <p className="text-text-muted text-xs mb-3">
          During the window, this tracker is checked at the accelerated cadence below
          (e.g., every 3 min) instead of its usual {tracker.check_interval_minutes >= 60
            ? `${tracker.check_interval_minutes / 60}h`
            : `${tracker.check_interval_minutes}m`} interval. Outside the window, normal scheduling applies.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
          <label className="text-xs text-text-muted">
            Start
            <input
              type="datetime-local"
              value={doorbusterStart}
              onChange={e => setDoorbusterStart(e.target.value)}
              className="block w-full mt-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary"
            />
          </label>
          <label className="text-xs text-text-muted">
            End
            <input
              type="datetime-local"
              value={doorbusterEnd}
              onChange={e => setDoorbusterEnd(e.target.value)}
              className="block w-full mt-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary"
            />
          </label>
          <label className="text-xs text-text-muted">
            Interval (minutes)
            <input
              type="number"
              min={1}
              step={1}
              placeholder="3"
              value={doorbusterInterval}
              onChange={e => setDoorbusterInterval(e.target.value)}
              className="block w-full mt-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary"
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleSaveDoorbuster}
            disabled={doorbusterSaving}
            className="px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {doorbusterSaving ? 'Saving...' : 'Save doorbuster'}
          </button>
          {(tracker.doorbuster_start_at || tracker.doorbuster_end_at || tracker.doorbuster_interval_minutes) && (
            <button
              onClick={handleClearDoorbuster}
              disabled={doorbusterSaving}
              className="px-4 py-2 bg-surface-hover text-text-muted hover:text-text rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
            >
              Clear doorbuster
            </button>
          )}
        </div>
        {doorbusterError && (
          <div className="mt-2 text-xs text-danger bg-danger/10 rounded-lg px-3 py-2">
            {doorbusterError}
          </div>
        )}
      </div>

      {(() => {
        // Determine whether the primary seller is Amazon. The primary seller
        // is the one with position === 0 in the sellers list (same convention
        // used by the seller table badge). We use the getHostname helper
        // already defined in this file so the stripping of "www." is consistent.
        const primarySeller = sellers.find(s => s.position === 0) ?? sellers[0]
        const primaryHost = primarySeller ? getHostname(primarySeller.url) : getHostname(tracker.url)
        const isAmazonSeller = /(?:^|\.)amazon\./i.test(primaryHost) || primaryHost === 'a.co' || primaryHost === 'amzn.to'
        return (
          <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <ShoppingBag className="w-5 h-5 text-amber-500" />
              <h2 className="text-lg font-semibold">Arm for purchase</h2>
              {!!tracker.buy_armed && (
                <span className="inline-flex items-center gap-1 text-xs font-medium bg-amber-500/15 text-amber-600 rounded-full px-2 py-0.5 ml-1">
                  Armed
                </span>
              )}
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <p className="text-text-muted text-xs max-w-prose">
                When this tracker hits your target price, you'll receive a one-tap approval
                link to buy on Amazon. Nothing is purchased without your tap.
              </p>
              <button
                onClick={handleToggleArm}
                disabled={!isAmazonSeller}
                title={isAmazonSeller ? undefined : 'Amazon only in v1'}
                className={`flex-shrink-0 rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                  tracker.buy_armed
                    ? 'bg-amber-500 text-white hover:bg-amber-600'
                    : 'bg-surface-hover text-text-muted hover:text-text border border-border'
                }`}
              >
                {tracker.buy_armed ? '🛒 Armed — tap to disarm' : 'Arm'}
              </button>
            </div>
            {!tracker.buy_armed && (
              <label className="mt-3 text-sm flex items-center gap-2 text-text-muted">
                Quantity
                <input
                  type="number"
                  min={1}
                  value={armQuantity}
                  onChange={e => setArmQuantity(e.target.value)}
                  className="w-20 bg-bg border border-border rounded-lg px-2 py-1 text-sm text-text focus:outline-none focus:border-primary"
                />
              </label>
            )}
            {!isAmazonSeller && (
              <div className="mt-2 text-xs text-text-muted bg-bg rounded-lg px-3 py-2">
                Arming is Amazon-only in v1. Add an Amazon seller URL above to enable this feature.
              </div>
            )}
          </div>
        )
      })()}

      {overlap && overlap.count > 0 && (
        <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-5 h-5 text-primary" />
            <h2 className="text-lg font-semibold">Community</h2>
          </div>
          <p className="text-text-muted text-sm">
            Also tracked by {overlap.count} {overlap.count === 1 ? 'other user' : 'others'}
            {overlap.names.length > 0 && (
              <> — shared by <span className="text-text font-medium">{overlap.names.join(', ')}</span></>
            )}
            .
          </p>
          {overlap.communityLow !== null
            && tracker?.last_price !== null
            && tracker?.last_price !== undefined
            && overlap.communityLow < tracker.last_price && (
              <div className="inline-flex items-center gap-1 text-sm text-success bg-success/10 rounded-full px-2.5 py-1 mt-3">
                <TrendingDown className="w-4 h-4" />
                Community low: ${overlap.communityLow.toFixed(2)}
              </div>
            )}
        </div>
      )}

      <AIInsightsCard tracker={tracker} />

      <PriceContextCard tracker={tracker} onTrackerUpdated={setTracker} />

      {tracker.status === 'purchased' && purchases[0] && (
        <PurchasedBanner
          purchase={purchases[0]}
          totalPurchases={purchases.length}
          onViewAll={() => navigate(`/purchased?tracker=${tracker.id}`)}
        />
      )}

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

      {showPurchaseModal && (
        <PurchaseModal
          tracker={tracker}
          firstPrice={prices.length > 0 ? prices[0].price : (tracker.last_price ?? 0)}
          sellers={sellers.map(s => ({ id: s.id, label: s.url }))}
          onClose={() => setShowPurchaseModal(false)}
          onSubmit={async (values) => {
            const { purchase, tracker: updated } = await createPurchase(trackerId, values)
            setPurchases([purchase, ...purchases])
            setTracker(updated)
            // No toast lib in this app — the banner + updated status badge
            // serve as the confirmation. Reload to refresh stats / sparkline.
            await load()
          }}
        />
      )}

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
