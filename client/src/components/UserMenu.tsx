import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ShoppingBag, Settings as SettingsIcon, Shield, LogOut, ChevronDown, CircleUserRound } from 'lucide-react'
import { useAuth } from '../context/AuthContext'

export default function UserMenu() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const location = useLocation()

  // Same close-on-route-change pattern already used by App.tsx's mobile
  // menu — this rule flags it as a synchronous setState-in-effect, but the
  // codebase treats that as accepted debt (App.tsx, WelcomeModal, etc. all
  // have the identical unaddressed violation). Disabled here rather than
  // silently adding another unaddressed instance to the count.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setOpen(false) }, [location.pathname])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus() }
    }
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onClick)
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onClick) }
  }, [open])

  if (!user) return null

  const itemClass = 'flex items-center gap-2 px-4 py-2 text-sm text-text-muted hover:text-text hover:bg-surface-hover no-underline w-full text-left'

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
      >
        <CircleUserRound className="w-5 h-5" />
        <span className="hidden lg:inline">{user.display_name}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 mt-2 w-48 bg-surface border border-border rounded-xl shadow-lg py-1.5 z-50">
          <div className="px-4 py-2 text-xs text-text-muted border-b border-border">{user.display_name}</div>
          <Link role="menuitem" to="/purchased" className={itemClass}><ShoppingBag className="w-4 h-4" />Purchased</Link>
          <Link role="menuitem" to="/settings" className={itemClass}><SettingsIcon className="w-4 h-4" />Settings</Link>
          {user.role === 'admin' && (
            <Link role="menuitem" to="/admin" className={itemClass}><Shield className="w-4 h-4" />Admin</Link>
          )}
          <div className="border-t border-border my-1" />
          <button role="menuitem" type="button" onClick={logout} className={itemClass}><LogOut className="w-4 h-4" />Logout</button>
        </div>
      )}
    </div>
  )
}
