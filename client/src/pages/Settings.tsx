import { useEffect, useState } from 'react'
import { Save, Send, CheckCircle, XCircle, MessageSquare, Bell, Webhook } from 'lucide-react'
import { getSettings, updateSettings, testWebhook, testNtfy, testGenericWebhook } from '../api'
import useTitle from '../useTitle'

type ChannelKey = 'discord' | 'ntfy' | 'webhook'

interface ChannelConfig {
  key: ChannelKey
  settingKey: 'discord_webhook_url' | 'ntfy_url' | 'generic_webhook_url'
  icon: React.ReactNode
  title: string
  description: React.ReactNode
  placeholder: string
  test: (url: string) => Promise<{ success: boolean; error?: string }>
}

const CHANNELS: ChannelConfig[] = [
  {
    key: 'discord',
    settingKey: 'discord_webhook_url',
    icon: <MessageSquare className="w-5 h-5 text-primary" />,
    title: 'Discord',
    description: (
      <>
        Paste a Discord channel webhook URL. Create one under{' '}
        <span className="text-text">Server Settings → Integrations → Webhooks</span>.
      </>
    ),
    placeholder: 'https://discord.com/api/webhooks/...',
    test: testWebhook,
  },
  {
    key: 'ntfy',
    settingKey: 'ntfy_url',
    icon: <Bell className="w-5 h-5 text-primary" />,
    title: 'ntfy (push notifications)',
    description: (
      <>
        Paste a ntfy topic URL — works with{' '}
        <a href="https://ntfy.sh" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">ntfy.sh</a>{' '}
        or any self-hosted instance. Install the ntfy app on your phone, subscribe to the same topic, and
        you'll get price drops as push notifications. Use a long, unguessable topic name since anyone
        who knows it can publish to it.
      </>
    ),
    placeholder: 'https://ntfy.sh/my-price-alerts-abc123',
    test: testNtfy,
  },
  {
    key: 'webhook',
    settingKey: 'generic_webhook_url',
    icon: <Webhook className="w-5 h-5 text-primary" />,
    title: 'Custom Webhook',
    description: (
      <>
        Any HTTPS endpoint that accepts a POST with JSON. Great for Home Assistant, Slack incoming
        webhooks, n8n, or your own bot. Payload:{' '}
        <code className="text-xs bg-bg px-1.5 py-0.5 rounded">{'{ event, tracker, current_price, savings, error, timestamp }'}</code>
      </>
    ),
    placeholder: 'https://example.com/hooks/price-alerts',
    test: testGenericWebhook,
  },
]

export default function SettingsPage() {
  useTitle('Settings')
  const [values, setValues] = useState<Record<ChannelKey, string>>({ discord: '', ntfy: '', webhook: '' })
  const [savingKey, setSavingKey] = useState<ChannelKey | null>(null)
  const [savedKey, setSavedKey] = useState<ChannelKey | null>(null)
  const [testingKey, setTestingKey] = useState<ChannelKey | null>(null)
  const [testResult, setTestResult] = useState<{ key: ChannelKey; ok: boolean; error?: string } | null>(null)

  useEffect(() => {
    getSettings().then(s => {
      setValues({
        discord: s.discord_webhook_url || '',
        ntfy: s.ntfy_url || '',
        webhook: s.generic_webhook_url || '',
      })
    })
  }, [])

  const handleSave = async (ch: ChannelConfig) => {
    setSavingKey(ch.key)
    setSavedKey(null)
    try {
      await updateSettings({ [ch.settingKey]: values[ch.key] })
      setSavedKey(ch.key)
      setTimeout(() => setSavedKey(k => (k === ch.key ? null : k)), 3000)
    } finally {
      setSavingKey(null)
    }
  }

  const handleTest = async (ch: ChannelConfig) => {
    if (!values[ch.key]) return
    setTestingKey(ch.key)
    setTestResult(null)
    try {
      const result = await ch.test(values[ch.key])
      setTestResult({ key: ch.key, ok: result.success, error: result.error })
    } catch (err) {
      setTestResult({ key: ch.key, ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTestingKey(null)
      // Success auto-dismisses after 5s; failure sticks until next interaction
      setTimeout(() => setTestResult(r => (r?.key === ch.key && r.ok ? null : r)), 5000)
    }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">Settings</h1>
      <p className="text-text-muted text-sm mb-6">
        Configure one or more notification channels. You'll receive alerts on every channel you set up.
      </p>

      <div className="flex flex-col gap-4">
        {CHANNELS.map(ch => {
          const val = values[ch.key]
          const saving = savingKey === ch.key
          const saved = savedKey === ch.key
          const testing = testingKey === ch.key
          const testForThis = testResult?.key === ch.key ? testResult : null

          return (
            <div key={ch.key} className="bg-surface border border-border rounded-xl p-4 sm:p-6">
              <div className="flex items-center gap-2 mb-2">
                {ch.icon}
                <h2 className="text-lg font-semibold">{ch.title}</h2>
              </div>
              <p className="text-text-muted text-sm mb-4">{ch.description}</p>

              <label className="block text-sm font-medium text-text-muted mb-1.5">URL</label>
              <input
                type="url"
                value={val}
                onChange={e => setValues(v => ({ ...v, [ch.key]: e.target.value }))}
                placeholder={ch.placeholder}
                className="w-full bg-bg border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary mb-4"
              />

              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => handleSave(ch)}
                  disabled={saving}
                  className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  {saved ? <CheckCircle className="w-4 h-4" /> : <Save className="w-4 h-4" />}
                  {saved ? 'Saved!' : saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => handleTest(ch)}
                  disabled={!val || testing}
                  className="flex items-center gap-2 px-4 py-2.5 bg-surface-hover text-text-muted hover:text-text rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
                >
                  <Send className="w-4 h-4" />
                  {testing ? 'Sending...' : 'Test'}
                </button>
                {testForThis?.ok && (
                  <span className="flex items-center gap-1 text-sm text-success">
                    <CheckCircle className="w-4 h-4" /> Sent!
                  </span>
                )}
              </div>
              {testForThis && !testForThis.ok && (
                <div className="mt-3 flex items-start gap-2 text-sm text-danger bg-danger/10 rounded-lg px-3 py-2">
                  <XCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div className="min-w-0 break-words">
                    <div className="font-medium">Test failed</div>
                    {testForThis.error && (
                      <div className="text-xs text-danger/80 mt-0.5 font-mono break-all">{testForThis.error}</div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
