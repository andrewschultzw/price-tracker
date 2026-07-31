import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import * as api from './api';

vi.mock('./api');

// The legacy filter pages (Active/BelowTarget/Errors) folded into the
// dashboard's URL-synced filter chips (Task 3). Visiting one of the old
// routes should now redirect straight to the dashboard with the equivalent
// `?filter=` param set — no separate page, no separate chunk.

const authedUser = {
  id: 1,
  email: 'andrew@example.com',
  display_name: 'Andrew',
  role: 'user' as const,
  is_active: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

// Exposes the router's current location as text so redirect assertions can
// read it without touching window.location (MemoryRouter keeps its own
// in-memory history, it never sets window.location) — same probe pattern
// Dashboard.test.tsx uses for its URL-sync tests.
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

// Dashboard renders its "no trackers yet" empty state (h2, no h1) when the
// tracker list is empty, so the redirect assertions need at least one
// tracker to reach the real "Dashboard" h1 heading.
const baseTracker = {
  id: 1,
  user_id: 1,
  name: 'Widget',
  url: 'https://example.com/widget',
  last_price: 50,
  last_checked_at: '2026-05-20T00:00:00Z',
  last_error: null,
  consecutive_failures: 0,
  status: 'active',
  threshold_price: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  errored_seller_count: 0,
};

function mockAuthedHappyPath() {
  vi.mocked(api.getSetupStatus).mockResolvedValue({ needsSetup: false, hasSetupToken: false });
  vi.mocked(api.getMe).mockResolvedValue(authedUser as any);
  vi.mocked(api.getTrackers).mockResolvedValue([baseTracker] as any);
  vi.mocked(api.getTrackerStats).mockResolvedValue({});
  vi.mocked(api.getSettings).mockResolvedValue({} as any);
  vi.mocked(api.getOverlapCounts).mockResolvedValue({});
  // AffiliateDisclosure renders unconditionally at the bottom of the
  // authenticated shell and fires this on mount.
  vi.mocked(api.getPublicSavings).mockResolvedValue({} as any);
  // NotificationBell (Task 6) fetches notification history on mount to
  // compute its unread badge.
  vi.mocked(api.getNotificationHistory).mockResolvedValue([]);
}

function renderAt(initialEntry: string) {
  mockAuthedHappyPath();
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider>
        <App />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('legacy filter route redirects', () => {
  it('/errors redirects to /?filter=errors', async () => {
    renderAt('/errors');
    await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

    expect(screen.getByTestId('location-probe')).toHaveTextContent('/?filter=errors');
  });

  it('/below-target redirects to /?filter=below-target', async () => {
    renderAt('/below-target');
    await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

    expect(screen.getByTestId('location-probe')).toHaveTextContent('/?filter=below-target');
  });

  it('/active redirects to /?filter=active', async () => {
    renderAt('/active');
    await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

    expect(screen.getByTestId('location-probe')).toHaveTextContent('/?filter=active');
  });
});
