import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Search, Loader2, CheckCircle } from 'lucide-react'
import { createTracker, testScrape, getTrackerUrls, updateTrackerUrlCondition } from '../api'
import type { ScrapeResult, TrackerUrlCondition } from '../types'
import useTitle from '../useTitle'

export default function AddTracker() {
  useTitle('Add Tracker')
  const navigate = useNavigate()
  // Prefill from the share-target flow (phase 2): /add?url=...&name=...
  // Lazy initializers only — the params seed the form, they don't own it.
  const [searchParams] = useSearchParams()
  const [url, setUrl] = useState(() => searchParams.get('url') ?? '')
  const [name, setName] = useState(() => searchParams.get('name') ?? '')

  // Share-flow arrivals (?url= present, no name yet) get an automatic test
  // scrape so the live price AND the product name appear without a tap.
  // Once per mount; a user-typed name suppresses it (they're mid-edit, not
  // arriving from a share).
  const autoTested = useRef(false)
  useEffect(() => {
    if (!autoTested.current && searchParams.get('url') && !name) {
      autoTested.current = true
      void handleTest()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [thresholdPrice, setThresholdPrice] = useState('')
  const [interval, setInterval] = useState('360')
  const [cssSelector, setCssSelector] = useState('')
  const [condition, setCondition] = useState<TrackerUrlCondition>('new')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ScrapeResult | null>(null)
  const [testError, setTestError] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleTest = async () => {
    if (!url) return
    setTesting(true)
    setTestResult(null)
    setTestError('')
    try {
      const result = await testScrape(url, cssSelector || undefined)
      setTestResult(result)
      // Share-flow autofill: the scrape now returns the product's own name
      // (JSON-LD/og:title). Fill the name field only if the user hasn't
      // typed one — their input always wins over the page's.
      if (result.title) {
        setName(prev => prev || result.title!)
      }
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Scrape failed')
    } finally {
      setTesting(false)
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url || !name) return
    setSaving(true)
    setError('')
    try {
      const tracker = await createTracker({
        name,
        url,
        threshold_price: thresholdPrice ? parseFloat(thresholdPrice) : null,
        check_interval_minutes: parseInt(interval),
        css_selector: cssSelector || null,
      })
      // The server creates the primary tracker_url with condition='new' by
      // default; if the user picked a non-'new' condition, patch it now.
      // Two round-trips is fine here — this page redirects right after.
      if (condition !== 'new') {
        try {
          const urls = await getTrackerUrls(tracker.id)
          const primary = urls.find(u => u.position === 0)
          if (primary) {
            await updateTrackerUrlCondition(tracker.id, primary.id, condition)
          }
        } catch {
          // Non-fatal — tracker exists, condition just stays 'new'. The
          // user can fix it from TrackerDetail's seller list.
        }
      }
      navigate(`/tracker/${tracker.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create tracker')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Add Tracker</h1>
      <form onSubmit={handleSubmit} className="space-y-5">
        <div>
          <label className="block text-sm font-medium text-text-muted mb-1.5">Product URL</label>
          <div className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://www.amazon.com/dp/..."
              required
              className="flex-1 bg-surface border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary"
            />
            <button
              type="button"
              onClick={handleTest}
              disabled={!url || testing}
              className="flex items-center gap-2 px-4 py-2.5 bg-surface border border-border rounded-lg text-sm font-medium text-text-muted hover:text-text hover:border-primary/50 transition-colors disabled:opacity-50"
            >
              {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              Test
            </button>
          </div>
          {testResult && (
            <div className="mt-2 flex items-center gap-2 text-sm text-success bg-success/10 rounded-lg px-3 py-2">
              <CheckCircle className="w-4 h-4" />
              Found: ${testResult.price.toFixed(2)} (via {testResult.strategy})
            </div>
          )}
          {testError && (
            <div className="mt-2 text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{testError}</div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1.5">
            Name
            {testing && !name && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-primary font-normal">
                <Loader2 className="w-3 h-3 animate-spin" />
                detecting product…
              </span>
            )}
          </label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder={testing && !name ? 'Detecting product name…' : 'Sony WH-1000XM5'}
            required
            className="w-full bg-surface border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1.5">
            Condition <span className="text-text-muted/50">(of this listing)</span>
          </label>
          <select
            value={condition}
            onChange={e => setCondition(e.target.value as TrackerUrlCondition)}
            className="w-full bg-surface border border-border rounded-lg px-4 py-2.5 text-text focus:outline-none focus:border-primary"
          >
            <option value="new">New</option>
            <option value="warehouse">Warehouse (Amazon Warehouse / used-like-new)</option>
            <option value="refurb">Refurbished</option>
            <option value="open_box">Open Box</option>
          </select>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1.5">Target Price ($)</label>
            <input
              type="number"
              value={thresholdPrice}
              onChange={e => setThresholdPrice(e.target.value)}
              placeholder="199.99"
              step="0.01"
              min="0"
              className="w-full bg-surface border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-text-muted mb-1.5">Check Interval</label>
            <select
              value={interval}
              onChange={e => setInterval(e.target.value)}
              className="w-full bg-surface border border-border rounded-lg px-4 py-2.5 text-text focus:outline-none focus:border-primary"
            >
              <option value="30">Every 30 min</option>
              <option value="60">Every hour</option>
              <option value="180">Every 3 hours</option>
              <option value="360">Every 6 hours</option>
              <option value="720">Every 12 hours</option>
              <option value="1440">Daily</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-text-muted mb-1.5">
            CSS Selector <span className="text-text-muted/50">(optional override)</span>
          </label>
          <input
            type="text"
            value={cssSelector}
            onChange={e => setCssSelector(e.target.value)}
            placeholder=".price-current, [data-price]"
            className="w-full bg-surface border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary"
          />
        </div>

        {error && (
          <div className="text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">{error}</div>
        )}

        <button
          type="submit"
          disabled={saving || !url || !name}
          className="w-full py-3 bg-primary hover:bg-primary-dark text-white rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          {saving ? 'Creating...' : 'Create Tracker'}
        </button>
      </form>
    </div>
  )
}
