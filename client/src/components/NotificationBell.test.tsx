import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import NotificationBell from './NotificationBell'
import * as api from '../api'
import type { NotificationHistoryRow } from '../api'

vi.mock('../api')

beforeEach(() => {
  vi.restoreAllMocks()
})

function row(overrides: Partial<NotificationHistoryRow>): NotificationHistoryRow {
  return {
    id: 1,
    tracker_id: 1,
    tracker_url_id: null,
    tracker_name: 'Widget',
    tracker_url: 'https://example.com/widget',
    seller_url: null,
    price: 50,
    threshold_price: 60,
    sent_at: new Date().toISOString(),
    channel: 'discord',
    ...overrides,
  }
}

describe('NotificationBell', () => {
  it('badge counts only rows sent in the last 24 hours', async () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    vi.mocked(api.getNotificationHistory).mockResolvedValue([
      row({ id: 1, sent_at: twoHoursAgo }),
      row({ id: 2, sent_at: threeDaysAgo }),
    ])

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)

    expect(await screen.findByText('1')).toBeInTheDocument()
  })

  it('shows 9+ when more than 9 rows fall within the last 24 hours', async () => {
    const recent = Array.from({ length: 12 }, (_, i) => row({ id: i + 1 }))
    vi.mocked(api.getNotificationHistory).mockResolvedValue(recent)

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)

    expect(await screen.findByText('9+')).toBeInTheDocument()
  })

  it('shows no badge when nothing was sent in the last 24 hours', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
    vi.mocked(api.getNotificationHistory).mockResolvedValue([row({ sent_at: threeDaysAgo })])

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)

    await waitFor(() => expect(api.getNotificationHistory).toHaveBeenCalled())
    expect(screen.queryByText('9+')).not.toBeInTheDocument()
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  it('bell still links to /notifications when the fetch fails', async () => {
    vi.mocked(api.getNotificationHistory).mockRejectedValue(new Error('network down'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<MemoryRouter><NotificationBell /></MemoryRouter>)

    const bell = await screen.findByTitle('Notifications')
    expect(bell).toHaveAttribute('href', '/notifications')
    expect(screen.queryByText('9+')).not.toBeInTheDocument()
  })
})
