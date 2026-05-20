import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Trash2 } from 'lucide-react';
import { listPurchases, deletePurchase as apiDeletePurchase } from '../api';
import type { PurchaseWithTracker } from '../types';
import { savedAmount } from '../types';
import useTitle from '../useTitle';

/**
 * Derive a human label from the raw URL the server returns in
 * `seller_label`. The server aliases `tracker_urls.url AS seller_label`,
 * so callers always get the raw URL; we shorten it to the hostname for
 * display, falling back to "—" when the value is missing or unparseable.
 */
function sellerDisplay(raw: string | null): string {
  if (!raw) return '—';
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return raw;
  }
}

export default function Purchased() {
  const [rows, setRows] = useState<PurchaseWithTracker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useTitle('Purchased');

  useEffect(() => {
    listPurchases({ limit: 200 })
      .then(r => setRows(r.purchases))
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>;
  }

  if (error) {
    return <div className="bg-danger/10 text-danger rounded-lg px-3 py-2 text-sm">{error}</div>;
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-80 gap-3 text-text-muted">
        <h1 className="text-2xl font-bold text-text">Purchased</h1>
        <p>No purchases yet — log one from any tracker detail page.</p>
      </div>
    );
  }

  const totalSaved = rows.reduce((acc, r) => acc + savedAmount(r), 0);
  const avg = rows.length === 0 ? 0 : totalSaved / rows.length;

  async function onDelete(id: number) {
    if (!confirm('Delete this purchase? If it was the only one for its tracker, the tracker will be re-activated.')) return;
    try {
      await apiDeletePurchase(id);
      setRows(prev => prev.filter(r => r.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Purchased</h1>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <Stat label="TOTAL SAVED" value={`$${totalSaved.toFixed(2)}`} valueClass="text-success" />
        <Stat label="PURCHASES" value={String(rows.length)} />
        <Stat label="AVG PER PURCHASE" value={`$${avg.toFixed(2)}`} />
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-text-muted text-xs border-b border-border bg-bg/50">
                <th className="text-left py-2 px-3 font-medium">Product</th>
                <th className="text-left py-2 px-3 font-medium">Seller</th>
                <th className="text-right py-2 px-3 font-medium">Paid</th>
                <th className="text-right py-2 px-3 font-medium">First seen</th>
                <th className="text-right py-2 px-3 font-medium">Saved</th>
                <th className="text-right py-2 px-3 font-medium">Qty</th>
                <th className="text-left py-2 px-3 font-medium">Date</th>
                <th className="py-2 px-3 w-10"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-b border-border/50 last:border-b-0 hover:bg-surface-hover/40">
                  <td className="py-2 px-3">
                    <Link to={`/tracker/${r.tracker_id}`} className="text-text hover:text-primary no-underline">
                      {r.tracker_name}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-text-muted">{sellerDisplay(r.seller_label)}</td>
                  <td className="py-2 px-3 text-right font-medium">${r.purchase_price.toFixed(2)}</td>
                  <td className="py-2 px-3 text-right text-text-muted">${r.first_price.toFixed(2)}</td>
                  <td className="py-2 px-3 text-right text-success font-medium">${savedAmount(r).toFixed(2)}</td>
                  <td className="py-2 px-3 text-right">{r.quantity}</td>
                  <td className="py-2 px-3 text-text-muted whitespace-nowrap">
                    {new Date(r.purchased_at).toLocaleDateString()}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <button
                      onClick={() => onDelete(r.id)}
                      className="p-1 rounded text-text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                      title="Delete this purchase"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <div className="text-xs text-text-muted uppercase tracking-wide">{label}</div>
      <div className={`text-2xl font-bold mt-1 ${valueClass ?? ''}`}>{value}</div>
    </div>
  );
}
