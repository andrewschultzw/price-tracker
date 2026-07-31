import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';
import * as api from '../api';

vi.mock('../api');

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

// Extended fixtures covering the other filter buckets — below-target,
// errored, paused, purchased — reused across the toolbar tests below.
const belowTargetTracker = {
  ...baseTracker,
  id: 2,
  name: 'SSD 1TB',
  url: 'https://newegg.com/ssd',
  threshold_price: 80,
  last_price: 70,
};
const erroredTracker = {
  ...baseTracker,
  id: 3,
  name: 'Broken Router',
  url: 'https://acme.com/router',
  status: 'error',
  last_error: 'boom',
  consecutive_failures: 3,
};
const pausedTracker = {
  ...baseTracker,
  id: 4,
  name: 'Paused Desk',
  url: 'https://acme.com/desk',
  status: 'paused',
};
const purchasedTracker = {
  ...baseTracker,
  id: 5,
  name: 'Bought Chair',
  url: 'https://wayfair.com/chair',
  status: 'purchased',
};

function mockHappyPath(trackers: any[]) {
  vi.mocked(api.getTrackers).mockResolvedValue(trackers as any);
  vi.mocked(api.getTrackerStats).mockResolvedValue({});
  vi.mocked(api.getSettings).mockResolvedValue({} as any);
  vi.mocked(api.getOverlapCounts).mockResolvedValue({});
}

// Exposes the router's current location as text so URL-sync assertions can
// read it without touching window.location (MemoryRouter keeps its own
// in-memory history, it never sets window.location).
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

function renderAt(initialEntry: string, trackers: any[]) {
  mockHappyPath(trackers);
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Dashboard />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Dashboard', () => {
  // Regression test for the React-hooks-order bug that shipped in PR #41:
  // useMemo calls were placed AFTER the loading/empty-state early returns,
  // so the first render (loading=true) called fewer hooks than the second
  // render (trackers loaded). React responded by unmounting the entire tree
  // → blank page. This test forces the loading→loaded transition and would
  // throw if the bug came back.
  it('renders after data loads without hooks-order errors', async () => {
    mockHappyPath([baseTracker]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));
    expect(screen.getByText('Widget')).toBeInTheDocument();
  });

  describe('toolbar', () => {
    const allFixtures = [baseTracker, belowTargetTracker, erroredTracker, pausedTracker, purchasedTracker];

    it('filter chips show live counts and filter the grid', async () => {
      renderAt('/', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const errorsChip = screen.getByRole('button', { name: /errors/i });
      expect(errorsChip).toHaveTextContent('1');
      expect(errorsChip).toHaveAttribute('aria-pressed', 'false');

      fireEvent.click(errorsChip);

      expect(errorsChip).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('Broken Router')).toBeInTheDocument();
      expect(screen.queryByText('Widget')).not.toBeInTheDocument();
      expect(screen.queryByText('SSD 1TB')).not.toBeInTheDocument();
      expect(screen.queryByText('Paused Desk')).not.toBeInTheDocument();
      expect(screen.queryByText('Bought Chair')).not.toBeInTheDocument();
    });

    it('search input filters by title', async () => {
      renderAt('/', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const search = screen.getByPlaceholderText(/filter trackers/i);
      fireEvent.change(search, { target: { value: 'ssd' } });

      expect(screen.getByText('SSD 1TB')).toBeInTheDocument();
      expect(screen.queryByText('Widget')).not.toBeInTheDocument();
      expect(screen.queryByText('Broken Router')).not.toBeInTheDocument();
    });

    it('filter state syncs to URL and back', async () => {
      renderAt('/?filter=errors', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const errorsChip = screen.getByRole('button', { name: /errors/i });
      expect(errorsChip).toHaveAttribute('aria-pressed', 'true');

      const pausedChip = screen.getByRole('button', { name: /paused/i });
      fireEvent.click(pausedChip);

      expect(pausedChip).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('location-probe')).toHaveTextContent('filter=paused');
    });

    it('defaults delete their URL param instead of writing it', async () => {
      renderAt('/', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      // Non-default filter → param written.
      fireEvent.click(screen.getByRole('button', { name: /errors/i }));
      expect(screen.getByTestId('location-probe')).toHaveTextContent('filter=errors');

      // Back to the default filter ('all') → param removed, not set to 'all'.
      fireEvent.click(screen.getByRole('button', { name: /^all/i }));
      expect(screen.getByTestId('location-probe')).not.toHaveTextContent('filter=');

      // Same contract for sort: non-default writes, default ('smart') deletes.
      const sortSelect = screen.getByLabelText(/sort/i);
      fireEvent.change(sortSelect, { target: { value: 'price' } });
      expect(screen.getByTestId('location-probe')).toHaveTextContent('sort=price');

      fireEvent.change(sortSelect, { target: { value: 'smart' } });
      expect(screen.getByTestId('location-probe')).not.toHaveTextContent('sort=');
    });

    it('unknown filter param falls back to All', async () => {
      renderAt('/?filter=bogus', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const allChip = screen.getByRole('button', { name: /^all/i });
      expect(allChip).toHaveAttribute('aria-pressed', 'true');
      // All non-purchased trackers should be visible — no crash, no filtering applied.
      expect(screen.getByText('Widget')).toBeInTheDocument();
      expect(screen.getByText('Broken Router')).toBeInTheDocument();
    });

    it('purchased chip replaces the old checkbox', async () => {
      renderAt('/', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      expect(screen.queryByLabelText(/show purchased/i)).not.toBeInTheDocument();
      expect(screen.queryByText('Bought Chair')).not.toBeInTheDocument();

      const purchasedChip = screen.getByRole('button', { name: /purchased/i });
      expect(purchasedChip).toHaveTextContent('1');

      fireEvent.click(purchasedChip);

      expect(screen.getByText('Bought Chair')).toBeInTheDocument();
    });

    it('hides niche chips (paused/purchased/errors) when their count is zero', async () => {
      renderAt('/', [baseTracker]);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      expect(screen.queryByRole('button', { name: /errors/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /paused/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /purchased/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^all/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /active/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /below target/i })).toBeInTheDocument();
    });
  });
});
