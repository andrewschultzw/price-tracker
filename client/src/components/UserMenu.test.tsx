import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Link } from 'react-router-dom'
import UserMenu from './UserMenu'
import { useAuth } from '../context/AuthContext'
import type { User } from '../types'

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}))

const mockedUseAuth = vi.mocked(useAuth)

const baseUser: User = {
  id: 1,
  email: 'andrew@example.com',
  display_name: 'Andrew',
  role: 'user',
  is_active: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

// Builds a full useAuth() return value (matching its real shape) so the
// mock stays type-safe without resorting to `any` — only `user`/`logout`
// matter to UserMenu, but the other fields still need to be present.
function mockAuth(overrides: { user: User; logout: () => Promise<void> }): ReturnType<typeof useAuth> {
  return {
    user: overrides.user,
    logout: overrides.logout,
    loading: false,
    needsSetup: false,
    login: vi.fn(),
    setUser: vi.fn(),
  }
}

function renderMenu() {
  return render(
    <MemoryRouter>
      <UserMenu />
    </MemoryRouter>,
  )
}

// UserMenu's close-on-route-change effect only fires when the *pathname*
// itself changes (it keys off `location.pathname`), so the harness needs a
// real navigation inside the same router — a sibling <Link> lets the test
// trigger one without mocking react-router internals.
function renderMenuWithNavLink() {
  return render(
    <MemoryRouter>
      <UserMenu />
      <Link to="/settings">Go elsewhere</Link>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('UserMenu', () => {
  it('opens on click and shows menu items', async () => {
    mockedUseAuth.mockReturnValue(mockAuth({ user: { ...baseUser, role: 'admin' }, logout: vi.fn(async () => {}) }))
    renderMenu()

    fireEvent.click(screen.getByRole('button', { name: /andrew/i }))

    expect(await screen.findByText('Purchased')).toBeInTheDocument()
    expect(screen.getByText('Settings')).toBeInTheDocument()
    expect(screen.getByText('Admin')).toBeInTheDocument()
    expect(screen.getByText('Logout')).toBeInTheDocument()
  })

  it('hides Admin for non-admin users', async () => {
    mockedUseAuth.mockReturnValue(mockAuth({ user: { ...baseUser, role: 'user' }, logout: vi.fn(async () => {}) }))
    renderMenu()

    fireEvent.click(screen.getByRole('button', { name: /andrew/i }))

    expect(await screen.findByText('Purchased')).toBeInTheDocument()
    expect(screen.queryByText('Admin')).not.toBeInTheDocument()
  })

  it('closes on Escape and returns focus to trigger', async () => {
    mockedUseAuth.mockReturnValue(mockAuth({ user: { ...baseUser, role: 'admin' }, logout: vi.fn(async () => {}) }))
    renderMenu()

    const trigger = screen.getByRole('button', { name: /andrew/i })
    fireEvent.click(trigger)
    expect(await screen.findByText('Purchased')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByText('Purchased')).not.toBeInTheDocument())
    expect(document.activeElement).toBe(trigger)
  })

  it('closes on outside click', async () => {
    mockedUseAuth.mockReturnValue(mockAuth({ user: { ...baseUser, role: 'admin' }, logout: vi.fn(async () => {}) }))
    renderMenu()

    fireEvent.click(screen.getByRole('button', { name: /andrew/i }))
    expect(await screen.findByText('Purchased')).toBeInTheDocument()

    fireEvent.mouseDown(document.body)

    await waitFor(() => expect(screen.queryByText('Purchased')).not.toBeInTheDocument())
  })

  it('closes on route change', async () => {
    mockedUseAuth.mockReturnValue(mockAuth({ user: { ...baseUser, role: 'admin' }, logout: vi.fn(async () => {}) }))
    renderMenuWithNavLink()

    fireEvent.click(screen.getByRole('button', { name: /andrew/i }))
    expect(await screen.findByText('Purchased')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Go elsewhere'))

    await waitFor(() => expect(screen.queryByText('Purchased')).not.toBeInTheDocument())
  })

  it('logout item calls logout', async () => {
    const logout = vi.fn(async () => {})
    mockedUseAuth.mockReturnValue(mockAuth({ user: { ...baseUser, role: 'admin' }, logout }))
    renderMenu()

    fireEvent.click(screen.getByRole('button', { name: /andrew/i }))
    fireEvent.click(await screen.findByText('Logout'))

    expect(logout).toHaveBeenCalled()
  })
})
