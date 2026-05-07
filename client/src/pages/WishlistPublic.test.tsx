import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import WishlistPublic from './WishlistPublic';
import * as api from '../api';

function renderAtToken(token: string) {
  return render(
    <MemoryRouter initialEntries={[`/wishlist/${token}`]}>
      <Routes>
        <Route path="/wishlist/:token" element={<WishlistPublic />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('WishlistPublic', () => {
  it('renders the empty state when the wishlist has no items', async () => {
    vi.spyOn(api, 'getPublicWishlist').mockResolvedValue({
      display_name: 'Alice',
      items: [],
    });
    renderAtToken('wl_x');
    expect(
      await screen.findByText(/No items yet — the owner hasn't added anything/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Alice's Wishlist/)).toBeInTheDocument();
  });

  it('renders items + Claim button on un-claimed items', async () => {
    vi.spyOn(api, 'getPublicWishlist').mockResolvedValue({
      display_name: null,
      items: [
        {
          tracker_id: 1,
          name: 'Cool Thing',
          url: 'https://store.example/cool',
          last_price: 49.99,
          ai_verdict_tier: 'BUY',
          ai_verdict_reason: 'Lowest in 30 days',
          is_claimed: false,
        },
      ],
    });
    renderAtToken('wl_x');
    expect(await screen.findByText('Cool Thing')).toBeInTheDocument();
    expect(screen.getByText('$49.99')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Claim this gift/i })).toBeInTheDocument();
    // No display_name → "A Wishlist"
    expect(screen.getByText(/A Wishlist/)).toBeInTheDocument();
  });

  it('renders "Already claimed" on items the visitor has not claimed', async () => {
    vi.spyOn(api, 'getPublicWishlist').mockResolvedValue({
      display_name: 'Alice',
      items: [
        {
          tracker_id: 1,
          name: 'Already Gone',
          url: 'https://x',
          last_price: 10,
          ai_verdict_tier: null,
          ai_verdict_reason: null,
          is_claimed: true,
        },
      ],
    });
    renderAtToken('wl_x');
    expect(await screen.findByText(/Already claimed by someone/i)).toBeInTheDocument();
  });

  it('renders "You claimed this — undo" when localStorage has a matching claim_token', async () => {
    localStorage.setItem('wishlist_claim_wl_x_1', 'wc_mine');
    vi.spyOn(api, 'getPublicWishlist').mockResolvedValue({
      display_name: 'Alice',
      items: [
        {
          tracker_id: 1,
          name: 'My Pick',
          url: 'https://x',
          last_price: 25,
          ai_verdict_tier: null,
          ai_verdict_reason: null,
          is_claimed: true,
        },
      ],
    });
    renderAtToken('wl_x');
    expect(
      await screen.findByRole('button', { name: /You claimed this — undo/i }),
    ).toBeInTheDocument();
  });

  it('claim flow calls API + persists claim_token in localStorage', async () => {
    vi.spyOn(api, 'getPublicWishlist').mockResolvedValue({
      display_name: 'Alice',
      items: [
        {
          tracker_id: 7,
          name: 'Pick Me',
          url: 'https://x',
          last_price: 30,
          ai_verdict_tier: null,
          ai_verdict_reason: null,
          is_claimed: false,
        },
      ],
    });
    const claimSpy = vi.spyOn(api, 'claimWishlistItem').mockResolvedValue({
      claim_token: 'wc_returned',
    });
    renderAtToken('wl_x');
    const btn = await screen.findByRole('button', { name: /Claim this gift/i });
    fireEvent.click(btn);
    await waitFor(() => expect(claimSpy).toHaveBeenCalledWith('wl_x', 7));
    expect(localStorage.getItem('wishlist_claim_wl_x_7')).toBe('wc_returned');
  });

  it('renders the 404 state when getPublicWishlist throws NOT_FOUND', async () => {
    vi.spyOn(api, 'getPublicWishlist').mockRejectedValue(new Error('NOT_FOUND'));
    renderAtToken('wl_bad');
    expect(
      await screen.findByText(/This wishlist link isn't valid/i),
    ).toBeInTheDocument();
  });
});
