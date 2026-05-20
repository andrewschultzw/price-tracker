import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PurchaseModal from './PurchaseModal';
import type { Tracker } from '../types';

const tracker = {
  id: 1, name: 'Widget', url: 'https://e.com', last_price: 47.99,
  status: 'active', check_interval_minutes: 60, consecutive_failures: 0,
  threshold_price: null, css_selector: null, normalized_url: null,
  last_checked_at: null, last_error: null,
  created_at: '2026-01-01', updated_at: '2026-01-01',
} as unknown as Tracker;

describe('PurchaseModal', () => {
  it('prefills price with tracker.last_price', () => {
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={() => Promise.resolve()} />);
    const priceInput = screen.getByLabelText(/price paid/i) as HTMLInputElement;
    expect(priceInput.value).toBe('47.99');
  });

  it('shows live estimated savings based on price × quantity', () => {
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={() => Promise.resolve()} />);
    expect(screen.getByText(/estimated savings/i).textContent).toMatch(/\$32\.00/);
    fireEvent.change(screen.getByLabelText(/quantity/i), { target: { value: '2' } });
    expect(screen.getByText(/estimated savings/i).textContent).toMatch(/\$64\.00/);
  });

  it('clamps savings at $0 when price exceeds first_price', () => {
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={() => Promise.resolve()} />);
    fireEvent.change(screen.getByLabelText(/price paid/i), { target: { value: '100' } });
    expect(screen.getByText(/estimated savings/i).textContent).toMatch(/\$0\.00/);
  });

  it('calls onSubmit with form values including keep_watching', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByLabelText(/keep watching/i));
    fireEvent.click(screen.getByText(/confirm purchase/i));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      purchase_price: 47.99, quantity: 1, keep_watching: true,
    }));
  });

  it('sends purchased_at as a full ISO-8601 string with Z', async () => {
    const onSubmit = vi.fn(() => Promise.resolve());
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByText(/confirm purchase/i));
    expect(onSubmit).toHaveBeenCalled();
    const arg = (onSubmit.mock.calls[0] as unknown[])[0] as { purchased_at: string };
    // Must be a strict ISO-8601 datetime (the server uses z.string().datetime()
    // which requires the trailing Z).
    expect(arg.purchased_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  it('renders seller dropdown with hostname-derived labels when multiple sellers exist', () => {
    const sellers = [
      { id: 11, label: 'https://www.amazon.com/dp/123' },
      { id: 12, label: 'https://www.bestbuy.com/site/abc' },
    ];
    render(<PurchaseModal tracker={tracker} firstPrice={79.99} sellers={sellers} onClose={() => {}} onSubmit={() => Promise.resolve()} />);
    // Hostname-derived options should be visible. Don't depend on a specific
    // raw URL appearing — we strip www. and friendly-format it.
    expect(screen.getByLabelText(/seller/i)).toBeInTheDocument();
    expect(screen.getByText('amazon.com')).toBeInTheDocument();
    expect(screen.getByText('bestbuy.com')).toBeInTheDocument();
  });
});
