import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { BarChart3, Plus, Settings as SettingsIcon, Shield, LogOut } from 'lucide-react'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import AdminRoute from './components/AdminRoute'
import Dashboard from './pages/Dashboard'
import AddTracker from './pages/AddTracker'
import TrackerDetail from './pages/TrackerDetail'
import SettingsPage from './pages/Settings'
import Login from './pages/Login'
import Register from './pages/Register'
import Setup from './pages/Setup'
import Admin from './pages/Admin'

function App() {
  const location = useLocation()
  const { user, logout } = useAuth()

  if (['/login', '/register', '/setup'].some(p => location.pathname.startsWith(p))) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/setup" element={<Setup />} />
      </Routes>
    )
  }

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
            {user?.role === 'admin' && navLink('/admin', 'Admin', <Shield className="w-4 h-4" />)}
            {user && (
              <div className="flex items-center gap-2 ml-2 pl-2 border-l border-border">
                <span className="text-sm text-text-muted">{user.display_name}</span>
                <button
                  onClick={logout}
                  className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
                  title="Logout"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>
      <main className="max-w-6xl mx-auto px-4 py-6">
        <Routes>
          <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
          <Route path="/add" element={<ProtectedRoute><AddTracker /></ProtectedRoute>} />
          <Route path="/tracker/:id" element={<ProtectedRoute><TrackerDetail /></ProtectedRoute>} />
          <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
          <Route path="/admin" element={<ProtectedRoute><AdminRoute><Admin /></AdminRoute></ProtectedRoute>} />
        </Routes>
      </main>
    </div>
  )
}

export default App
