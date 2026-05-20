import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

function mockHappyPath(trackers: any[]) {
  vi.mocked(api.getTrackers).mockResolvedValue(trackers as any);
  vi.mocked(api.getTrackerStats).mockResolvedValue({});
  vi.mocked(api.getSettings).mockResolvedValue({} as any);
  vi.mocked(api.getOverlapCounts).mockResolvedValue({});
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

  it('shows "Show purchased" toggle only when at least one purchased tracker exists', async () => {
    mockHappyPath([
      baseTracker,
      { ...baseTracker, id: 2, name: 'Bought thing', status: 'purchased' },
    ]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));
    expect(screen.getByText(/show purchased \(1\)/i)).toBeInTheDocument();
    expect(screen.queryByText('Bought thing')).not.toBeInTheDocument();
  });

  it('hides the toggle when no purchased trackers exist', async () => {
    mockHappyPath([baseTracker]);
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await waitFor(() => screen.getByRole('heading', { name: /dashboard/i }));
    expect(screen.queryByText(/show purchased/i)).not.toBeInTheDocument();
  });
});
