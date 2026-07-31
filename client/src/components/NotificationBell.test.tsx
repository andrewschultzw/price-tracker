import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NotificationBell from './NotificationBell'
import { NOTIFICATIONS_READ_EVENT } from '../useNotificationCount'
import * as api from '../api'

vi.mock('../api')

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('NotificationBell', () => {
  it('badge shows the server-side unread count', async () => {
    vi.mocked(api.getUnreadNotificationCount).mockResolvedValue({ count: 3 })

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)

    expect(await screen.findByText('3')).toBeInTheDocument()
  })

  it('caps the badge at 9+', async () => {
    vi.mocked(api.getUnreadNotificationCount).mockResolvedValue({ count: 42 })

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)

    expect(await screen.findByText('9+')).toBeInTheDocument()
  })

  it('shows no badge at zero unread', async () => {
    vi.mocked(api.getUnreadNotificationCount).mockResolvedValue({ count: 0 })

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)

    await waitFor(() => expect(api.getUnreadNotificationCount).toHaveBeenCalled())
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })

  it('refetches and clears when the notifications page broadcasts mark-read', async () => {
    vi.mocked(api.getUnreadNotificationCount).mockResolvedValueOnce({ count: 5 })

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)
    expect(await screen.findByText('5')).toBeInTheDocument()

    vi.mocked(api.getUnreadNotificationCount).mockResolvedValueOnce({ count: 0 })
    act(() => { window.dispatchEvent(new Event(NOTIFICATIONS_READ_EVENT)) })

    await waitFor(() => expect(screen.queryByText('5')).not.toBeInTheDocument())
  })

  it('bell still links to /notifications when the fetch fails', async () => {
    vi.mocked(api.getUnreadNotificationCount).mockRejectedValue(new Error('network down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)

    const bell = await screen.findByTitle('Notifications')
    expect(bell).toHaveAttribute('href', '/notifications')
    expect(screen.queryByText('9+')).not.toBeInTheDocument()
  })
})
