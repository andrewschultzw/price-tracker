import { useMemo, useState } from 'react';
import type { Tracker } from '../types';

/**
 * Convert a raw URL string (the server aliases `tracker_urls.url AS
 * seller_label`, so callers pass the raw URL through) to a human label.
 * Falls back to the raw value if the input isn't parseable.
 */
function toSellerDisplay(raw: string | null | undefined): string {
  if (!raw) return 'Default';
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

type SellerOption = { id: number; label: string };

interface Props {
  tracker: Tracker;
  /**
   * The "first observed" price for this tracker — used to compute the
   * live estimated savings preview. Caller derives from price_history's
   * earliest row, falling back to tracker.last_price when no history
   * exists. The server applies the same fallback logic when stamping
   * `first_price` on the persisted purchase row, so the preview and the
   * server-side computation stay aligned.
   */
  firstPrice: number;
  sellers?: SellerOption[];
  onClose: () => void;
  onSubmit: (values: {
    purchase_price: number;
    quantity: number;
    purchased_at: string;
    tracker_url_id: number | null;
    keep_watching: boolean;
  }) => Promise<void>;
}

export default function PurchaseModal({ tracker, firstPrice, sellers, onClose, onSubmit }: Props) {
  const [price, setPrice] = useState<number>(tracker.last_price ?? 0);
  const [qty, setQty] = useState<number>(1);
  // YYYY-MM-DD local-date string for the <input type="date">. We convert
  // this to a full ISO-8601 UTC string at submit time so the server's
  // strict `z.string().datetime()` validator accepts the payload.
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [sellerId, setSellerId] = useState<number | null>(sellers?.[0]?.id ?? null);
  const [keepWatching, setKeepWatching] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const estimated = useMemo(
    () => Math.max(0, (firstPrice - price) * qty),
    [firstPrice, price, qty],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({
        purchase_price: price,
        quantity: qty,
        // <input type="date"> returns YYYY-MM-DD; new Date() parses it as
        // local midnight, and .toISOString() yields UTC with the Z suffix
        // that the server-side zod.datetime() requires.
        purchased_at: new Date(date).toISOString(),
        tracker_url_id: sellerId,
        keep_watching: keepWatching,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={e => e.stopPropagation()}
        className="bg-surface border border-border rounded-xl p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold text-text mb-1">Log Purchase</h2>
        <p className="text-xs text-text-muted mb-4">{tracker.name}</p>

        <label className="block text-xs text-text-muted mb-3">
          Price paid
          <input
            type="number"
            step="0.01"
            min="0"
            required
            value={price}
            onChange={e => setPrice(Number(e.target.value))}
            aria-label="price paid"
            className="block w-full mt-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary"
          />
        </label>

        <label className="block text-xs text-text-muted mb-3">
          Quantity
          <input
            type="number"
            min="1"
            step="1"
            value={qty}
            onChange={e => setQty(Math.max(1, Number(e.target.value)))}
            aria-label="quantity"
            className="block w-full mt-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary"
          />
        </label>

        <label className="block text-xs text-text-muted mb-3">
          Date
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            aria-label="date"
            className="block w-full mt-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary"
          />
        </label>

        {sellers && sellers.length > 1 && (
          <label className="block text-xs text-text-muted mb-3">
            Seller
            <select
              value={sellerId ?? ''}
              onChange={e => setSellerId(Number(e.target.value))}
              aria-label="seller"
              className="block w-full mt-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text focus:outline-none focus:border-primary"
            >
              {sellers.map(s => (
                <option key={s.id} value={s.id}>{toSellerDisplay(s.label)}</option>
              ))}
            </select>
          </label>
        )}

        <div className="bg-bg rounded-lg px-3 py-2 my-4 text-sm text-text-muted">
          Estimated savings: <span className="font-semibold text-success">${estimated.toFixed(2)}</span>
        </div>

        <label className="flex items-center gap-2 text-sm text-text mb-4">
          <input
            type="checkbox"
            checked={keepWatching}
            onChange={e => setKeepWatching(e.target.checked)}
            aria-label="keep watching"
          />
          Keep watching after purchase
        </label>

        {error && (
          <div className="text-xs text-danger bg-danger/10 rounded-lg px-3 py-2 mb-3">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-surface-hover text-text-muted hover:text-text rounded-lg text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="px-4 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
          >
            {submitting ? 'Saving…' : 'Confirm Purchase'}
          </button>
        </div>
      </form>
    </div>
  );
}
