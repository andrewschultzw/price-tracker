import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Buy from './Buy';
import * as api from '../api';

vi.mock('../api');

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Render the Buy page with a given token in the URL */
function renderBuy(token = 'tok') {
  return render(
    <MemoryRouter initialEntries={[`/buy/${token}`]}>
      <Routes>
        <Route path="/buy/:token" element={<Buy />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('Buy confirmation page', () => {
  it('renders price and Approve button for an armed intent', async () => {
    vi.mocked(api.getBuyIntent).mockResolvedValue({
      intent: {
        status: 'armed',
        asin: 'B001234',
        price_at_arm: 49.99,
        threshold_at_arm: 55.00,
        quantity: 1,
        expires_at: '2026-06-01T00:00:00Z',
      },
      tracker: { id: 7, name: 'Widget Pro' },
      buyUrl: null,
    });

    renderBuy();

    // Wait for the async load
    const approveBtn = await screen.findByRole('button', { name: /approve/i });
    expect(approveBtn).toBeInTheDocument();
    expect(await screen.findByText(/\$49\.99/)).toBeInTheDocument();
    // Closed-state message must NOT be present
    expect(screen.queryByText(/this purchase is closed/i)).toBeNull();
  });

  it('renders "closed" message for a terminal (purchased) intent', async () => {
    vi.mocked(api.getBuyIntent).mockResolvedValue({
      intent: {
        status: 'purchased',
        asin: 'B001234',
        price_at_arm: 49.99,
        threshold_at_arm: 55.00,
        quantity: 1,
        expires_at: '2026-06-01T00:00:00Z',
      },
      tracker: { id: 7, name: 'Widget Pro' },
      buyUrl: null,
    });

    renderBuy();

    expect(await screen.findByText(/this purchase is closed/i)).toBeInTheDocument();
    // No approve/resolve buttons for a terminal state
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /yes, bought it/i })).toBeNull();
  });

  it('renders not-found message when getBuyIntent throws NOT_FOUND', async () => {
    vi.mocked(api.getBuyIntent).mockRejectedValue(new Error('NOT_FOUND'));

    renderBuy();

    expect(await screen.findByText(/this purchase link isn't valid anymore/i)).toBeInTheDocument();
  });
});
