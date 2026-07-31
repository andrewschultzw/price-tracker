import { Link } from 'react-router-dom'
import { Bell } from 'lucide-react'
import useNotificationCount from '../useNotificationCount'

export default function NotificationBell() {
  const count = useNotificationCount()

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
