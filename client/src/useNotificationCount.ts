import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
// Real unread state (server migration v22): the server keeps read_at per
// notification and this hook reads a bare COUNT of the unread ones — no more
// 24h-window proxy over 200 history rows. Shared by the desktop
// NotificationBell and the mobile drawer badge; renderers cap display at 9+.
//
// Refetches on route change, and immediately when the notifications page
// bulk-marks everything read (it dispatches NOTIFICATIONS_READ_EVENT after a
// successful mark-read so visible badges clear without waiting for a nav).
import { getUnreadNotificationCount } from './api'

export const NOTIFICATIONS_READ_EVENT = 'pt:notifications-read'

export default function useNotificationCount(): number {
  const [count, setCount] = useState(0)
  const location = useLocation()

  useEffect(() => {
    let cancelled = false
    const refetch = () => {
      getUnreadNotificationCount()
        .then(r => { if (!cancelled) setCount(r.count) })
        .catch(err => { console.error('Notification count failed', err) /* badge hidden, links still work */ })
    }
    refetch()
    const onRead = () => refetch()
    window.addEventListener(NOTIFICATIONS_READ_EVENT, onRead)
    return () => {
      cancelled = true
      window.removeEventListener(NOTIFICATIONS_READ_EVENT, onRead)
    }
  }, [location.pathname])

  return count
}
