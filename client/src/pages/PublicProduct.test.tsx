import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PublicProduct from './PublicProduct';
import * as api from '../api';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/p/:slug" element={<PublicProduct />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Clean meta tags between tests so document.head doesn't bleed state.
  document.querySelectorAll('meta[name="description"], meta[property="og:title"], meta[property="og:type"], meta[property="og:description"]')
    .forEach(el => el.remove());
  document.title = '';
});

describe('PublicProduct', () => {
  it('renders display_name and lowest current price on success', async () => {
    vi.spyOn(api, 'getPublicProduct').mockResolvedValue({
      slug: 'samsung-990-pro-4tb-a3b9c2',
      display_name: 'Samsung 990 Pro 4TB',
      normalized_url: 'amazon.com/dp/B0CKGVDJL2',
      lowest_current_price: 279,
      lowest_ever_price: 259,
      sample_count: 612,
      first_observed: '2026-01-15',
      price_history: [
        { date: '2026-04-01', price: 309.99 },
        { date: '2026-04-02', price: 305.5 },
      ],
    });
    renderAt('/p/samsung-990-pro-4tb-a3b9c2');
    expect(await screen.findByRole('heading', { name: 'Samsung 990 Pro 4TB' })).toBeInTheDocument();
    expect(screen.getByText('$279.00')).toBeInTheDocument();
    expect(screen.getByText('$259.00')).toBeInTheDocument();
    expect(screen.getByText('612')).toBeInTheDocument();
  });

  it('renders the "Product not found" state on 404', async () => {
    vi.spyOn(api, 'getPublicProduct').mockRejectedValue(new Error('NOT_FOUND'));
    renderAt('/p/missing-slug-xxxxxx');
    expect(await screen.findByText(/Product not found/i)).toBeInTheDocument();
  });

  it('sets document.title to "<name> Price History — Price Tracker"', async () => {
    vi.spyOn(api, 'getPublicProduct').mockResolvedValue({
      slug: 'gadget-aaaaaa',
      display_name: 'Gadget',
      normalized_url: 'amazon.com/dp/G',
      lowest_current_price: 10,
      lowest_ever_price: 5,
      sample_count: 1,
      first_observed: '2026-01-01',
      price_history: [],
    });
    renderAt('/p/gadget-aaaaaa');
    // Wait until the content has rendered so the title-setting effect has run.
    expect(await screen.findByRole('heading', { name: 'Gadget' })).toBeInTheDocument();
    await waitFor(() => {
      expect(document.title).toBe('Gadget Price History — Price Tracker');
    });
    const ogTitle = document.querySelector('meta[property="og:title"]');
    expect(ogTitle?.getAttribute('content')).toBe('Gadget Price History — Price Tracker');
    const desc = document.querySelector('meta[name="description"]');
    expect(desc?.getAttribute('content')).toMatch(/Gadget/);
  });
});
