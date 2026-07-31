import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import * as api from './api';
import type { Tracker, User, SavingsSummary } from './types';

vi.mock('./api');

// Task 6 slims the top bar down to three primary links (Dashboard, Deals,
// Projects) plus an Add Tracker button, a NotificationBell, and a UserMenu.
// Settings/Purchased/Notifications/Admin move inside the UserMenu/bell —
// they should no longer be top-level nav links.

const authedUser: User = {
  id: 1,
  email: 'andrew@example.com',
  display_name: 'Andrew',
  role: 'user',
  is_active: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const baseTracker: Tracker = {
  id: 1,
  name: 'Widget',
  url: 'https://example.com/widget',
  normalized_url: null,
  threshold_price: null,
  check_interval_minutes: 60,
  css_selector: null,
  last_price: 50,
  last_checked_at: '2026-05-20T00:00:00Z',
  last_error: null,
  consecutive_failures: 0,
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  errored_seller_count: 0,
};

const emptySavings: SavingsSummary = {
  total_saved: 0,
  purchase_count: 0,
  since: null,
  monthly: [],
};

function mockAuthedHappyPath() {
  vi.mocked(api.getSetupStatus).mockResolvedValue({ needsSetup: false, hasSetupToken: false });
  vi.mocked(api.getMe).mockResolvedValue(authedUser);
  vi.mocked(api.getTrackers).mockResolvedValue([baseTracker]);
  vi.mocked(api.getTrackerStats).mockResolvedValue({});
  vi.mocked(api.getSettings).mockResolvedValue({});
  vi.mocked(api.getOverlapCounts).mockResolvedValue({});
  vi.mocked(api.getPublicSavings).mockResolvedValue(emptySavings);
  vi.mocked(api.getNotificationHistory).mockResolvedValue([]);
  vi.mocked(api.getUnreadNotificationCount).mockResolvedValue({ count: 0 });
}

function renderApp() {
  mockAuthedHappyPath();
  return render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('slim top nav', () => {
  it('desktop nav shows exactly Dashboard, Deals, Projects as links', async () => {
    renderApp();
    await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

    const nav = document.querySelector('nav') as HTMLElement;
    const desktopNav = within(nav).getByText('Dashboard').closest('.hidden.md\\:flex') as HTMLElement;
    const links = within(desktopNav).getAllByRole('link');
    const labels = links.map(l => l.textContent?.trim());

    expect(labels).toContain('Dashboard');
    expect(labels).toContain('Deals');
    expect(labels).toContain('Projects');
    expect(labels).not.toContain('Settings');
    expect(labels).not.toContain('Purchased');
    expect(labels).not.toContain('Notifications');
    expect(labels).not.toContain('Admin');
  });

  it('bell links to /notifications', async () => {
    renderApp();
    await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

    const bell = await screen.findByTitle('Notifications');
    expect(bell.tagName).toBe('A');
    expect(bell).toHaveAttribute('href', '/notifications');
  });
});
