import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import CommunityDeals from './CommunityDeals';
import * as api from '../api';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deals" element={<CommunityDeals />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll(
    'meta[name="description"], meta[property="og:title"], meta[property="og:type"], meta[property="og:description"]',
  ).forEach(el => el.remove());
  document.title = '';
});

describe('CommunityDeals', () => {
  it('renders the empty state when the API returns no entries', async () => {
    vi.spyOn(api, 'getCommunityDeals').mockResolvedValue({
      entries: [],
      generated_at: '2026-05-06T12:00:00.000Z',
    });
    renderAt('/deals');
    expect(await screen.findByText(/No deals yet/i)).toBeInTheDocument();
  });

  it('renders deal cards when the API returns entries', async () => {
    vi.spyOn(api, 'getCommunityDeals').mockResolvedValue({
      entries: [
        {
          slug: 'samsung-990-pro-4tb-a3b9c2',
          display_name: 'Samsung 990 Pro 4TB',
          current_price: 279,
          threshold_price: 340,
          drop_pct: 0.18,
          hours_ago: 2,
          normalized_url: 'amazon.com/dp/B0CKGVDJL2',
        },
        {
          slug: 'gadget-xxxxxx',
          display_name: 'Gadget',
          current_price: 10,
          threshold_price: 20,
          drop_pct: 0.5,
          hours_ago: 0,
          normalized_url: 'amazon.com/dp/G',
        },
      ],
      generated_at: '2026-05-06T12:00:00.000Z',
    });
    renderAt('/deals');
    expect(await screen.findByRole('heading', { name: 'Samsung 990 Pro 4TB' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Gadget' })).toBeInTheDocument();
    expect(screen.getByText('$279.00')).toBeInTheDocument();
    expect(screen.getByText('$10.00')).toBeInTheDocument();
  });

  it('renders the drop percentage and hours-ago text on each card', async () => {
    vi.spyOn(api, 'getCommunityDeals').mockResolvedValue({
      entries: [
        {
          slug: 'sample-aaaaaa',
          display_name: 'Sample',
          current_price: 80,
          threshold_price: 100,
          drop_pct: 0.2,
          hours_ago: 3,
          normalized_url: 'amazon.com/dp/S',
        },
      ],
      generated_at: '2026-05-06T12:00:00.000Z',
    });
    renderAt('/deals');
    expect(await screen.findByText(/20% below threshold/)).toBeInTheDocument();
    expect(screen.getByText(/3h ago/)).toBeInTheDocument();
  });

  it('renders cards as links pointing to /p/<slug>', async () => {
    vi.spyOn(api, 'getCommunityDeals').mockResolvedValue({
      entries: [
        {
          slug: 'linked-bbbbbb',
          display_name: 'Linked Product',
          current_price: 50,
          threshold_price: 100,
          drop_pct: 0.5,
          hours_ago: 1,
          normalized_url: 'amazon.com/dp/L',
        },
      ],
      generated_at: '2026-05-06T12:00:00.000Z',
    });
    renderAt('/deals');
    const heading = await screen.findByRole('heading', { name: 'Linked Product' });
    // Walk up to the enclosing <a> — DealCard wraps the whole card in a Link.
    const link = heading.closest('a');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/p/linked-bbbbbb');
  });

  it('sets the document.title and og:* meta', async () => {
    vi.spyOn(api, 'getCommunityDeals').mockResolvedValue({
      entries: [],
      generated_at: '2026-05-06T12:00:00.000Z',
    });
    renderAt('/deals');
    await waitFor(() => {
      expect(document.title).toBe('Community Deals — Price Tracker');
    });
    const ogTitle = document.querySelector('meta[property="og:title"]');
    expect(ogTitle?.getAttribute('content')).toBe('Community Deals — Price Tracker');
    const desc = document.querySelector('meta[name="description"]');
    expect(desc?.getAttribute('content')).toMatch(/community/i);
  });
});
