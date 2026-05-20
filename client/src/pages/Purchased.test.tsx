import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Purchased from './Purchased';
import * as api from '../api';

vi.mock('../api');

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('Purchased admin page', () => {
  it('renders header stats and purchase rows', async () => {
    vi.mocked(api.listPurchases).mockResolvedValue({
      purchases: [{
        id: 1, tracker_id: 1, tracker_name: 'Widget', tracker_url: 'https://e.com',
        // Server aliases tracker_urls.url AS seller_label — so this is a URL.
        seller_label: 'https://www.amazon.com/dp/abc',
        purchase_price: 40, first_price: 100, quantity: 2,
        purchased_at: '2026-05-12T00:00:00Z', created_at: '2026-05-12T00:00:00Z', tracker_url_id: null,
      }],
      total: 1,
    });
    render(<MemoryRouter><Purchased /></MemoryRouter>);
    await waitFor(() => screen.getByText('Widget'));
    // (100 - 40) * 2 = 120 savings; appears under TOTAL SAVED stat, avg
    // stat, and the row's Saved column for a single-purchase list.
    expect(screen.getAllByText(/\$120\.00/).length).toBeGreaterThan(0);
    expect(screen.getByText(/TOTAL SAVED/i)).toBeInTheDocument();
    // Seller label is derived from the URL hostname.
    expect(screen.getByText('amazon.com')).toBeInTheDocument();
  });

  it('renders an empty state when there are no purchases', async () => {
    vi.mocked(api.listPurchases).mockResolvedValue({ purchases: [], total: 0 });
    render(<MemoryRouter><Purchased /></MemoryRouter>);
    await waitFor(() => screen.getByText(/no purchases yet/i));
  });
});
