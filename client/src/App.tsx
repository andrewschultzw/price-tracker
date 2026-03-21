import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { BarChart3, Plus, Settings as SettingsIcon } from 'lucide-react'
import Dashboard from './pages/Dashboard'
import AddTracker from './pages/AddTracker'
import TrackerDetail from './pages/TrackerDetail'
import SettingsPage from './pages/Settings'

function App() {
  const location = useLocation()

  const navLink = (to: string, label: string, icon: React.ReactNode) => {
    const active = location.pathname === to
    return (
      <Link
        to={to}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors
          ${active ? 'bg-primary text-white' : 'text-text-muted hover:text-text hover:bg-surface-hover'}`}
      >
        {icon}
        {label}
      </Link>
    )
  }

  return (
    <div className="min-h-screen bg-bg">
      <nav className="border-b border-border bg-surface">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="text-lg font-bold text-text no-underline flex items-center gap-2">
            <BarChart3 className="w-6 h-6 text-primary" />
            Price Tracker
          </Link>
          <div className="flex items-center gap-2">
            {navLink('/', 'Dashboard', <BarChart3 className="w-4 h-4" />)}
            {navLink('/add', 'Add Tracker', <Plus className="w-4 h-4" />)}
            {navLink('/settings', 'Settings', <SettingsIcon className="w-4 h-4" />)}
          </div>
        </div>
      </nav>
      <main className="max-w-6xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/add" element={<AddTracker />} />
          <Route path="/tracker/:id" element={<TrackerDetail />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  )
}

export default App
