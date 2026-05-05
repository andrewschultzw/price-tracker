import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import './index.css'
import App from './App.tsx'
import { registerSW } from './lib/web-push'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)

// Register the service worker on app boot. Idempotent — safe to call on
// every load. Bails silently when the browser doesn't support SW.
registerSW()

// Listen for navigation messages from the SW (when an open tab receives a
// notification click, the SW's notificationclick handler postMessages the
// target URL to the focused window).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type === 'navigate' && typeof e.data.url === 'string') {
      window.location.href = e.data.url
    }
  })
}
