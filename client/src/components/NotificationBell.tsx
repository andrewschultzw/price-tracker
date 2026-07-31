import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Bell } from 'lucide-react'
// The real notifications data comes from getNotificationHistory (client/src/api.ts),
// the same fetcher the /notifications page uses. Its rows (NotificationHistoryRow)
// have no read/unread flag, so a lifetime total would just pin at "9+" forever for
// any active account (the send log only ever grows). Instead the badge counts rows
// sent in the last 24 hours, capped at "9+" — a proxy for "what's new since
// yesterday" rather than "unread". Uses the same `sent_at` field and the same
// missing-timezone-suffix parsing the /notifications page uses (SQLite datetimes
// come back without a trailing "Z"), and the same limit=200 the page fetches with,
// since we need the actual rows (not just a count) to filter by time.
import { getNotificationHistory, type NotificationHistoryRow } from '../api'

const DAY_MS = 24 * 60 * 60 * 1000

function parseSentAt(s: string): Date {
  return new Date(s.includes('Z') ? s : s + 'Z')
}

function countLast24h(items: NotificationHistoryRow[]): number {
  const cutoff = Date.now() - DAY_MS
  return items.filter(n => parseSentAt(n.sent_at).getTime() >= cutoff).length
}

export default function NotificationBell() {
  const [count, setCount] = useState(0)
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    getNotificationHistory(undefined, 200)
      .then(items => { if (!cancelled) setCount(Array.isArray(items) ? countLast24h(items) : 0) })
      .catch(err => { console.error('Notification count failed', err) /* badge hidden, bell still links */ })
    return () => { cancelled = true }
  }, [location.pathname])

  return (
    <Link
      to="/notifications"
      title="Notifications"
      className="relative flex items-center justify-center p-2 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
    >
      <Bell className="w-5 h-5" />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[10px] font-bold flex items-center justify-center">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </Link>
  )
}
