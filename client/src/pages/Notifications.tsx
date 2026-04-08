import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, MessageSquare, Webhook, HelpCircle, Inbox } from 'lucide-react'
import { getNotificationHistory, type NotificationHistoryRow } from '../api'
import useTitle from '../useTitle'

function formatDateTime(s: string): string {
  const d = new Date(s.includes('Z') ? s : s + 'Z')
  return d.toLocaleString()
}

function ChannelBadge({ channel }: { channel: string | null }) {
  if (channel === 'discord') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-primary bg-primary/10 rounded-full px-2.5 py-1">
        <MessageSquare className="w-3 h-3" />
        Discord
      </span>
    )
  }
  if (channel === 'ntfy') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-success bg-success/10 rounded-full px-2.5 py-1">
        <Bell className="w-3 h-3" />
        ntfy
      </span>
    )
  }
  if (channel === 'webhook') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-warning bg-warning/10 rounded-full px-2.5 py-1">
        <Webhook className="w-3 h-3" />
        Webhook
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-text-muted bg-surface-hover rounded-full px-2.5 py-1">
      <HelpCircle className="w-3 h-3" />
      Unknown
    </span>
  )
}

export default function NotificationsPage() {
  useTitle('Notifications')
  const [rows, setRows] = useState<NotificationHistoryRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getNotificationHistory(undefined, 200)
      .then(setRows)
      .catch(err => console.error('Failed to load notifications', err))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-6">
        <Inbox className="w-6 h-6 text-primary flex-shrink-0" />
        <div>
          <h1 className="text-2xl font-bold">Notifications</h1>
          <p className="text-text-muted text-sm mt-0.5">
            {rows.length === 0
              ? 'No notifications sent yet.'
              : `Last ${rows.length} price drop alert${rows.length !== 1 ? 's' : ''} across all trackers.`}
          </p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-8 text-center text-text-muted">
          <Bell className="w-12 h-12 mx-auto mb-3 opacity-40" />
          <p>When a tracker drops below its target price and a notification channel is configured,</p>
          <p>you'll see the history of sent alerts here.</p>
        </div>
      ) : (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg/50 border-b border-border">
                <tr className="text-text-muted text-xs">
                  <th className="text-left px-4 py-3 font-medium">Sent</th>
                  <th className="text-left px-4 py-3 font-medium">Tracker</th>
                  <th className="text-left px-4 py-3 font-medium">Channel</th>
                  <th className="text-right px-4 py-3 font-medium">Price</th>
                  <th className="text-right px-4 py-3 font-medium">Target</th>
                  <th className="text-right px-4 py-3 font-medium">Savings</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const savings = r.threshold_price - r.price
                  return (
                    <tr key={r.id} className="border-b border-border/50 hover:bg-surface-hover transition-colors">
                      <td className="px-4 py-3 text-text-muted whitespace-nowrap">{formatDateTime(r.sent_at)}</td>
                      <td className="px-4 py-3">
                        <Link to={`/tracker/${r.tracker_id}`} className="text-text hover:text-primary no-underline font-medium">
                          {r.tracker_name}
                        </Link>
                      </td>
                      <td className="px-4 py-3"><ChannelBadge channel={r.channel} /></td>
                      <td className="px-4 py-3 text-right font-semibold">${r.price.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-text-muted">${r.threshold_price.toFixed(2)}</td>
                      <td className="px-4 py-3 text-right text-success">${savings.toFixed(2)}</td>
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
