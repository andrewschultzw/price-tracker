import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Dashboard from './Dashboard';
import * as api from '../api';
import type { Tracker } from '../types';

vi.mock('../api');

const baseTracker: Tracker = {
  id: 1,
  name: 'Widget',
  url: 'https://example.com/widget',
  normalized_url: null,
  check_interval_minutes: 60,
  css_selector: null,
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
const belowTargetTracker: Tracker = {
  ...baseTracker,
  id: 2,
  name: 'SSD 1TB',
  url: 'https://newegg.com/ssd',
  threshold_price: 80,
  last_price: 70,
};
const erroredTracker: Tracker = {
  ...baseTracker,
  id: 3,
  name: 'Broken Router',
  url: 'https://acme.com/router',
  status: 'error',
  last_error: 'boom',
  consecutive_failures: 3,
};
const pausedTracker: Tracker = {
  ...baseTracker,
  id: 4,
  name: 'Paused Desk',
  url: 'https://acme.com/desk',
  status: 'paused',
};
const purchasedTracker: Tracker = {
  ...baseTracker,
  id: 5,
  name: 'Bought Chair',
  url: 'https://wayfair.com/chair',
  status: 'purchased',
};
// status stays 'active' but one seller is currently erroring — isErrored()
// is true (errored_seller_count > 0) even though status !== 'error'. This
// is exactly the case where the old StatCards computation (status ===
// 'active') and the chip computation (status === 'active' && !isErrored)
// diverged: the card would count this tracker as Active, the chip would not.
const activeButErroredTracker: Tracker = {
  ...baseTracker,
  id: 6,
  name: 'Flaky Monitor',
  url: 'https://acme.com/monitor',
  status: 'active',
  errored_seller_count: 1,
};

function mockHappyPath(trackers: Tracker[]) {
  vi.mocked(api.getTrackers).mockResolvedValue(trackers);
  vi.mocked(api.getTrackerStats).mockResolvedValue({});
  vi.mocked(api.getSettings).mockResolvedValue({} as Awaited<ReturnType<typeof api.getSettings>>);
  vi.mocked(api.getOverlapCounts).mockResolvedValue({});
  // checkTracker's response body isn't asserted on by any test — only that
  // it was called and that the promise resolves.
  vi.mocked(api.checkTracker).mockResolvedValue(baseTracker);
}

// Exposes the router's current location as text so URL-sync assertions can
// read it without touching window.location (MemoryRouter keeps its own
// in-memory history, it never sets window.location).
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{location.pathname}{location.search}</div>;
}

function renderAt(initialEntry: string, trackers: Tracker[]) {
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

    // Scopes chip queries to the toolbar's filter-chip group. Since
    // StatCards' Active/Below Target/Errors cards are now clickable
    // buttons too, an unscoped getByRole('button', { name: /errors/i })
    // matches both the toolbar chip and the stat card — ambiguous.
    const toolbarGroup = () => screen.getByRole('group', { name: /filter by status/i });

    it('filter chips show live counts and filter the grid', async () => {
      renderAt('/', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const errorsChip = within(toolbarGroup()).getByRole('button', { name: /errors/i });
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

      const errorsChip = within(toolbarGroup()).getByRole('button', { name: /errors/i });
      expect(errorsChip).toHaveAttribute('aria-pressed', 'true');

      const pausedChip = within(toolbarGroup()).getByRole('button', { name: /paused/i });
      fireEvent.click(pausedChip);

      expect(pausedChip).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('location-probe')).toHaveTextContent('filter=paused');
    });

    it('defaults delete their URL param instead of writing it', async () => {
      renderAt('/', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      // Non-default filter → param written.
      fireEvent.click(within(toolbarGroup()).getByRole('button', { name: /errors/i }));
      expect(screen.getByTestId('location-probe')).toHaveTextContent('filter=errors');

      // Back to the default filter ('all') → param removed, not set to 'all'.
      fireEvent.click(within(toolbarGroup()).getByRole('button', { name: /^all/i }));
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

      expect(within(toolbarGroup()).queryByRole('button', { name: /errors/i })).not.toBeInTheDocument();
      expect(within(toolbarGroup()).queryByRole('button', { name: /blocked/i })).not.toBeInTheDocument();
      expect(within(toolbarGroup()).queryByRole('button', { name: /paused/i })).not.toBeInTheDocument();
      expect(within(toolbarGroup()).queryByRole('button', { name: /purchased/i })).not.toBeInTheDocument();
      expect(within(toolbarGroup()).getByRole('button', { name: /^all/i })).toBeInTheDocument();
      expect(within(toolbarGroup()).getByRole('button', { name: /active/i })).toBeInTheDocument();
      expect(within(toolbarGroup()).getByRole('button', { name: /below target/i })).toBeInTheDocument();
    });

    it('clicking the Errors stat card selects the Errors chip in place (no navigation)', async () => {
      renderAt('/', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      // Scope to the stat-cards-grid so this doesn't collide with the
      // toolbar's own "Errors" chip, which also matches /errors/i.
      const statCardsGrid = document.querySelector('.stat-cards-grid') as HTMLElement;
      const errorsStatCard = within(statCardsGrid).getByRole('button', { name: /errors/i });
      fireEvent.click(errorsStatCard);

      const errorsChip = screen.getByRole('button', { name: /^errors/i });
      expect(errorsChip).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('location-probe')).toHaveTextContent('/?filter=errors');
    });

    it('below-target cards carry the glow class', async () => {
      renderAt('/', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const ssdCard = screen.getByText('SSD 1TB').closest('a');
      expect(ssdCard).toHaveClass('bit-border-glow');
    });

    // Issue #68: the glow rule used the raw threshold check with no status
    // guard, so a purchased tracker whose buy price beat its threshold kept
    // glowing under the Purchased chip — reading as a live deal on an item
    // already bought. isBelowTarget() requires status === 'active'.
    it('purchased-below-threshold cards do NOT glow', async () => {
      const boughtBelowThreshold: Tracker = {
        ...purchasedTracker, threshold_price: 100, last_price: 70,
      };
      renderAt('/?filter=purchased', [baseTracker, boughtBelowThreshold]);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const card = screen.getByText('Bought Chair').closest('a');
      expect(card).not.toHaveClass('bit-border-glow');
    });

    it('Blocked chip appears only when a tracker is WAF-blocked, and filters the grid', async () => {
      const blockedTracker: Tracker = {
        ...baseTracker, id: 7, name: 'Blocked TV', url: 'https://bestbuy.com/tv', status: 'blocked',
      };
      renderAt('/', [...allFixtures, blockedTracker]);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const blockedChip = within(toolbarGroup()).getByRole('button', { name: /blocked/i });
      expect(blockedChip).toHaveTextContent('1');

      fireEvent.click(blockedChip);

      expect(screen.getByText('Blocked TV')).toBeInTheDocument();
      expect(screen.queryByText('Widget')).not.toBeInTheDocument();
      // Blocked is not an error state: the Errors bulk re-check button must
      // not offer to re-scrape trackers a re-check cannot fix.
      expect(screen.queryByRole('button', { name: /check all now/i })).not.toBeInTheDocument();
    });

    it('per-filter page title reflects the active chip', async () => {
      renderAt('/?filter=errors', allFixtures);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));
      expect(document.title).toBe('Dashboard — Errors | Price Tracker');

      fireEvent.click(within(toolbarGroup()).getByRole('button', { name: /^all/i }));
      await waitFor(() => expect(document.title).toBe('Dashboard | Price Tracker'));
    });

    // Finding 1: a URL like ?filter=errors with zero errored trackers used
    // to hide the Errors chip entirely (it's a "niche, hide at 0" chip) and
    // leave the grid empty with no explanation — the selected filter
    // effectively vanished with no trace of why the page looked broken.
    it('keeps the selected chip visible at count 0 and shows an empty state instead of a blank grid', async () => {
      renderAt('/?filter=errors', [baseTracker]);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const errorsChip = within(toolbarGroup()).getByRole('button', { name: /errors/i });
      expect(errorsChip).toBeInTheDocument();
      expect(errorsChip).toHaveTextContent('0');
      expect(errorsChip).toHaveAttribute('aria-pressed', 'true');

      expect(screen.getByText(/no trackers match this filter/i)).toBeInTheDocument();
      expect(screen.queryByText('Widget')).not.toBeInTheDocument();
    });
  });

  describe('stat card / chip count lockstep', () => {
    const toolbarGroup = () => screen.getByRole('group', { name: /filter by status/i });

    // Finding 2: StatCards used to compute its own active/errors counts
    // (e.g. Active = status === 'active', full stop) that diverged from the
    // chip counts (Active excludes errored). A tracker that's status
    // 'active' but has an errored seller exposed exactly that split.
    it('Active card count matches the Active chip badge for a status-active-but-errored tracker', async () => {
      renderAt('/', [activeButErroredTracker]);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      const activeChip = within(toolbarGroup()).getByRole('button', { name: /^active/i });
      // The chip excludes the errored tracker, so its badge count is 0.
      expect(activeChip).toHaveTextContent('0');

      const statCardsGrid = document.querySelector('.stat-cards-grid') as HTMLElement;
      const activeCard = within(statCardsGrid).getByText('Active').parentElement!.parentElement!;
      expect(activeCard).toHaveTextContent('0');
    });
  });

  describe('Check All Now (errors filter)', () => {
    const toolbarGroup = () => screen.getByRole('group', { name: /filter by status/i });

    it('is not rendered outside the errors filter', async () => {
      renderAt('/', [erroredTracker]);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      expect(screen.queryByRole('button', { name: /check all now/i })).not.toBeInTheDocument();
    });

    it('is not rendered under the errors filter when there are no errored trackers', async () => {
      renderAt('/?filter=errors', [baseTracker]);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      expect(screen.queryByRole('button', { name: /check all now/i })).not.toBeInTheDocument();
    });

    it('fans out checkTracker over every errored tracker and reloads data on click', async () => {
      const secondErrored = { ...erroredTracker, id: 7, name: 'Second Broken Thing' };
      renderAt('/?filter=errors', [erroredTracker, secondErrored]);
      await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));

      within(toolbarGroup()).getByRole('button', { name: /errors/i }); // sanity: chip present

      // vi.mock's call history isn't reset between tests in this file (only
      // implementations are restored), so assert the reload as an increment
      // off a captured baseline rather than an absolute count.
      const getTrackersCallsBefore = vi.mocked(api.getTrackers).mock.calls.length

      const button = screen.getByRole('button', { name: /check all now/i });
      fireEvent.click(button);

      await waitFor(() => expect(api.checkTracker).toHaveBeenCalledTimes(2));
      expect(api.checkTracker).toHaveBeenCalledWith(erroredTracker.id);
      expect(api.checkTracker).toHaveBeenCalledWith(secondErrored.id);

      // Data reload fires once at the end of the check-all fan-out.
      await waitFor(() =>
        expect(vi.mocked(api.getTrackers).mock.calls.length).toBe(getTrackersCallsBefore + 1));
    });
  });
});
