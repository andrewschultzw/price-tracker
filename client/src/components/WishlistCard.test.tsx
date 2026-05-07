import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WishlistCard } from './WishlistCard';
import * as api from '../api';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('WishlistCard', () => {
  it('renders the share link + Copy button after fetch', async () => {
    vi.spyOn(api, 'getWishlistShareToken').mockResolvedValue({
      token: 'wl_abc',
      share_url: 'https://prices.schultzsolutions.tech/wishlist/wl_abc',
    });
    vi.spyOn(api, 'getMyWishlist').mockResolvedValue({ items: [], count: 0 });

    render(<WishlistCard />);
    await waitFor(() =>
      expect(
        screen.getByDisplayValue('https://prices.schultzsolutions.tech/wishlist/wl_abc'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Copy/i })).toBeInTheDocument();
  });

  it('renders the items count', async () => {
    vi.spyOn(api, 'getWishlistShareToken').mockResolvedValue({
      token: 'wl_abc',
      share_url: 'https://x/wishlist/wl_abc',
    });
    vi.spyOn(api, 'getMyWishlist').mockResolvedValue({ items: [], count: 3 });

    render(<WishlistCard />);
    expect(await screen.findByText(/3 items on your wishlist/i)).toBeInTheDocument();
  });

  it('uses singular "item" when count is 1', async () => {
    vi.spyOn(api, 'getWishlistShareToken').mockResolvedValue({
      token: 'wl_abc',
      share_url: 'https://x/wishlist/wl_abc',
    });
    vi.spyOn(api, 'getMyWishlist').mockResolvedValue({ items: [], count: 1 });

    render(<WishlistCard />);
    expect(await screen.findByText(/^1 item on your wishlist$/i)).toBeInTheDocument();
  });

  it('Rotate button asks for confirmation before action', async () => {
    vi.spyOn(api, 'getWishlistShareToken').mockResolvedValue({
      token: 'wl_old',
      share_url: 'https://x/wishlist/wl_old',
    });
    vi.spyOn(api, 'getMyWishlist').mockResolvedValue({ items: [], count: 0 });
    const rotateSpy = vi.spyOn(api, 'rotateWishlistShareTokenApi').mockResolvedValue({
      token: 'wl_new',
      share_url: 'https://x/wishlist/wl_new',
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<WishlistCard />);
    const btn = await screen.findByRole('button', { name: /Rotate link/i });
    fireEvent.click(btn);

    await waitFor(() => expect(rotateSpy).toHaveBeenCalled());
    expect(confirmSpy).toHaveBeenCalled();
    expect(
      await screen.findByDisplayValue('https://x/wishlist/wl_new'),
    ).toBeInTheDocument();
  });

  it('Rotate button does NOT call API when confirmation is declined', async () => {
    vi.spyOn(api, 'getWishlistShareToken').mockResolvedValue({
      token: 'wl_old',
      share_url: 'https://x/wishlist/wl_old',
    });
    vi.spyOn(api, 'getMyWishlist').mockResolvedValue({ items: [], count: 0 });
    const rotateSpy = vi.spyOn(api, 'rotateWishlistShareTokenApi').mockResolvedValue({
      token: 'wl_new',
      share_url: 'https://x/wishlist/wl_new',
    });
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    render(<WishlistCard />);
    const btn = await screen.findByRole('button', { name: /Rotate link/i });
    fireEvent.click(btn);
    // Give the click handler a tick so any awaits would have fired
    await new Promise(r => setTimeout(r, 10));
    expect(rotateSpy).not.toHaveBeenCalled();
  });
});
