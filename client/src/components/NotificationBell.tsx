import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Bell } from 'lucide-react'
// The real notifications data comes from getNotificationHistory (client/src/api.ts),
// the same fetcher the /notifications page uses. Its rows (NotificationHistoryRow)
// have no read/unread flag, so per the brief's fallback rule the badge is the total
// row count capped at "9+". We only need to know whether the count is >9, so we
// fetch with limit=10 — enough to hit the cap without pulling the full history.
import { getNotificationHistory } from '../api'

export default function NotificationBell() {
  const [count, setCount] = useState(0)
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    getNotificationHistory(undefined, 10)
      .then(items => { if (!cancelled) setCount(Array.isArray(items) ? items.length : 0) })
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
