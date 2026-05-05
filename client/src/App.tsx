import { lazy, Suspense, useEffect, useState } from 'react'
import { Routes, Route, Link, useLocation } from 'react-router-dom'
import { BarChart3, Plus, Settings as SettingsIcon, Shield, LogOut, Menu, X, Inbox, Package } from 'lucide-react'
import { useAuth } from './context/AuthContext'
import ProtectedRoute from './components/ProtectedRoute'
import AdminRoute from './components/AdminRoute'

// Dashboard is the landing page — loaded eagerly so first paint is
// as fast as possible and the hero content doesn't briefly flash a
// loading state. Everything else is lazy-loaded so its dependencies
// (recharts for TrackerDetail, canvas-confetti for the celebration
// inside Dashboard's StatCards, etc.) don't inflate the initial bundle.
import Dashboard from './pages/Dashboard'

// Login/Register/Setup are the pre-auth pages. They're small and
// users hit them before anything else, so eager loading avoids a
// flash during the initial login flow.
import Login from './pages/Login'
import Register from './pages/Register'
import Setup from './pages/Setup'

// Everything else is lazy. Each of these becomes its own chunk that
// the browser only fetches when the user actually navigates there.
const AddTracker = lazy(() => import('./pages/AddTracker'))
const TrackerDetail = lazy(() => import('./pages/TrackerDetail'))
const Category = lazy(() => import('./pages/Category'))
const BelowTarget = lazy(() => import('./pages/BelowTarget'))
const Errors = lazy(() => import('./pages/Errors'))
const Active = lazy(() => import('./pages/Active'))
const Notifications = lazy(() => import('./pages/Notifications'))
const SettingsPage = lazy(() => import('./pages/Settings'))
const Admin = lazy(() => import('./pages/Admin'))
const Projects = lazy(() => import('./pages/Projects'))
const ProjectDetail = lazy(() => import('./pages/ProjectDetail'))

// Shared loading fallback for lazy routes. Matches the inline "Loading..."
// style the pages themselves use so the transition is visually smooth.
function RouteFallback() {
  return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>
}

function App() {
  const location = useLocation()
  const { user, logout } = useAuth()
  const [menuOpen, setMenuOpen] = useState(false)

  // Auto-close the mobile menu whenever the route changes
  useEffect(() => { setMenuOpen(false) }, [location.pathname])

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

          {/* Desktop nav */}
          <div className="hidden md:flex items-center gap-2">
            {navLink('/', 'Dashboard', <BarChart3 className="w-4 h-4" />)}
            {navLink('/add', 'Add Tracker', <Plus className="w-4 h-4" />)}
            {navLink('/notifications', 'Notifications', <Inbox className="w-4 h-4" />)}
            {navLink('/projects', 'Projects', <Package className="w-4 h-4" />)}
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

          {/* Mobile hamburger toggle */}
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="md:hidden flex items-center justify-center p-2 rounded-lg text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
          >
            {menuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
        </div>

        {/* Mobile dropdown panel */}
        {menuOpen && (
          <div className="md:hidden border-t border-border bg-surface">
            <div className="max-w-6xl mx-auto px-4 py-3 flex flex-col gap-1">
              {navLink('/', 'Dashboard', <BarChart3 className="w-4 h-4" />)}
              {navLink('/add', 'Add Tracker', <Plus className="w-4 h-4" />)}
              {navLink('/notifications', 'Notifications', <Inbox className="w-4 h-4" />)}
              {navLink('/projects', 'Projects', <Package className="w-4 h-4" />)}
              {navLink('/settings', 'Settings', <SettingsIcon className="w-4 h-4" />)}
              {user?.role === 'admin' && navLink('/admin', 'Admin', <Shield className="w-4 h-4" />)}
              {user && (
                <div className="flex items-center justify-between mt-2 pt-3 border-t border-border">
                  <span className="text-sm text-text-muted px-4">{user.display_name}</span>
                  <button
                    onClick={logout}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-text-muted hover:text-text hover:bg-surface-hover transition-colors"
                  >
                    <LogOut className="w-4 h-4" />
                    Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </nav>
      <main className="max-w-6xl mx-auto px-4 py-6">
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            <Route path="/add" element={<ProtectedRoute><AddTracker /></ProtectedRoute>} />
            <Route path="/tracker/:id" element={<ProtectedRoute><TrackerDetail /></ProtectedRoute>} />
            <Route path="/category/:domain" element={<ProtectedRoute><Category /></ProtectedRoute>} />
            <Route path="/below-target" element={<ProtectedRoute><BelowTarget /></ProtectedRoute>} />
            <Route path="/errors" element={<ProtectedRoute><Errors /></ProtectedRoute>} />
            <Route path="/active" element={<ProtectedRoute><Active /></ProtectedRoute>} />
            <Route path="/notifications" element={<ProtectedRoute><Notifications /></ProtectedRoute>} />
            <Route path="/projects" element={<ProtectedRoute><Projects /></ProtectedRoute>} />
            <Route path="/projects/:id" element={<ProtectedRoute><ProjectDetail /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
            <Route path="/admin" element={<ProtectedRoute><AdminRoute><Admin /></AdminRoute></ProtectedRoute>} />
          </Routes>
        </Suspense>
      </main>
    </div>
  )
}

export default App
