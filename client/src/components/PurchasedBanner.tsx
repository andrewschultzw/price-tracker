import { CheckCircle } from 'lucide-react';
import type { Purchase } from '../types';
import { savedAmount } from '../types';

interface Props {
  purchase: Purchase;
  totalPurchases: number;
  onViewAll?: () => void;
}

/**
 * Renders above the price chart on TrackerDetail when the tracker's
 * status is 'purchased'. Surfaces the most recent purchase's savings
 * and (when more than one exists) a link to /purchased filtered to
 * this tracker.
 */
export default function PurchasedBanner({ purchase, totalPurchases, onViewAll }: Props) {
  const saved = savedAmount(purchase);
  const date = new Date(purchase.purchased_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return (
    <div className="bg-success/10 border border-success/40 text-text rounded-xl px-4 py-3 mb-6 flex items-center justify-between gap-3">
      <div className="text-sm flex items-center gap-2">
        <CheckCircle className="w-4 h-4 text-success flex-shrink-0" />
        <span>
          Purchased on {date} — saved{' '}
          <span className="font-semibold text-success">${saved.toFixed(2)}</span>{' '}
          <span className="text-text-muted">({purchase.quantity} × ${purchase.purchase_price.toFixed(2)})</span>
        </span>
      </div>
      {totalPurchases > 1 && onViewAll && (
        <button
          onClick={onViewAll}
          className="text-xs text-success hover:underline flex-shrink-0"
        >
          View all {totalPurchases} purchases →
        </button>
      )}
    </div>
  );
}
