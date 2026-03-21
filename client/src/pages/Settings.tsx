import { useEffect, useState } from 'react'
import { Save, Send, CheckCircle, XCircle } from 'lucide-react'
import { getSettings, updateSettings, testWebhook } from '../api'
import useTitle from '../useTitle'

export default function SettingsPage() {
  useTitle('Settings')
  const [webhookUrl, setWebhookUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testOk, setTestOk] = useState<boolean | null>(null)

  useEffect(() => {
    getSettings().then(s => {
      setWebhookUrl(s.discord_webhook_url || '')
    })
  }, [])

  const handleSave = async () => {
    setSaving(true)
    setSaved(false)
    try {
      await updateSettings({ discord_webhook_url: webhookUrl })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } finally {
      setSaving(false)
    }
  }

  const handleTest = async () => {
    if (!webhookUrl) return
    setTesting(true)
    setTestOk(null)
    try {
      const result = await testWebhook(webhookUrl)
      setTestOk(result.success)
    } catch {
      setTestOk(false)
    } finally {
      setTesting(false)
      setTimeout(() => setTestOk(null), 5000)
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Discord Notifications</h2>
        <p className="text-text-muted text-sm mb-4">
          Enter your Discord webhook URL to receive price drop notifications.
        </p>

        <label className="block text-sm font-medium text-text-muted mb-1.5">Webhook URL</label>
        <input
          type="url"
          value={webhookUrl}
          onChange={e => setWebhookUrl(e.target.value)}
          placeholder="https://discord.com/api/webhooks/..."
          className="w-full bg-bg border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary mb-4"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
            {saved ? 'Saved!' : saving ? 'Saving...' : 'Save'}
          </button>
          <button
            onClick={handleTest}
            disabled={!webhookUrl || testing}
            className="flex items-center gap-2 px-4 py-2.5 bg-surface-hover text-text-muted hover:text-text rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            <Send className="w-4 h-4" />
            {testing ? 'Sending...' : 'Test Webhook'}
          </button>
          {testOk === true && (
            <span className="flex items-center gap-1 text-sm text-success">
              <CheckCircle className="w-4 h-4" /> Sent!
            </span>
          )}
          {testOk === false && (
            <span className="flex items-center gap-1 text-sm text-danger">
              <XCircle className="w-4 h-4" /> Failed
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
