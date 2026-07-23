import { useEffect, useState } from 'react'
import { CheckCircle, Newspaper, Save } from 'lucide-react'
import { getSettings, updateSettings } from '../api'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const CHANNELS = [
  { value: '', label: 'First configured (ntfy → Discord → email → webhook)' },
  { value: 'ntfy', label: 'ntfy' },
  { value: 'discord', label: 'Discord' },
  { value: 'email', label: 'Email' },
  { value: 'webhook', label: 'Generic webhook' },
]

/**
 * Weekly digest settings (deal-intelligence phase 3): one summary per week —
 * biggest drops, record lows, failing trackers, stale targets, unbought wins.
 */
export function DigestCard() {
  const [enabled, setEnabled] = useState(true)
  const [channel, setChannel] = useState('')
  const [day, setDay] = useState('0')
  const [hour, setHour] = useState('8')
  const [always, setAlways] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    getSettings()
      .then(s => {
        setEnabled((s.digest_enabled ?? 'true') !== 'false')
        setChannel(s.digest_channel ?? '')
        setDay(s.digest_day || '0')
        setHour(s.digest_hour || '8')
        setAlways(s.digest_always === 'true')
      })
      .finally(() => setLoaded(true))
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await updateSettings({
        digest_enabled: enabled ? 'true' : 'false',
        digest_channel: channel,
        digest_day: day,
        digest_hour: hour,
        digest_always: always ? 'true' : 'false',
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null

  return (
    <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mt-4">
      <div className="flex items-center gap-2 mb-2">
        <Newspaper className="w-5 h-5 text-primary" />
        <h2 className="text-lg font-semibold">Weekly Digest</h2>
      </div>
      <p className="text-text-muted text-sm mb-4">
        One summary per week: biggest drops, record lows, trackers that need attention,
        targets worth revisiting, and deals you hit but never bought. Quiet weeks send
        nothing.
      </p>

      <label className="flex items-center gap-2 cursor-pointer mb-4">
        <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="rounded" />
        <span className="text-sm">Send me a weekly digest</span>
      </label>

      {enabled && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">Channel</label>
            <select
              value={channel}
              onChange={e => setChannel(e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm"
            >
              {CHANNELS.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Day</label>
            <select
              value={day}
              onChange={e => setDay(e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm"
            >
              {DAYS.map((d, i) => (
                <option key={d} value={String(i)}>{d}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">Hour (Central)</label>
            <select
              value={hour}
              onChange={e => setHour(e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={String(h)}>
                  {h === 0 ? '12 am' : h < 12 ? `${h} am` : h === 12 ? '12 pm' : `${h - 12} pm`}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      {enabled && (
        <label className="flex items-center gap-2 cursor-pointer mb-4">
          <input type="checkbox" checked={always} onChange={e => setAlways(e.target.checked)} className="rounded" />
          <span className="text-sm text-text-muted">Send even when there&apos;s nothing to report</span>
        </label>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
      >
        {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
        {saved ? 'Saved!' : saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  )
}
