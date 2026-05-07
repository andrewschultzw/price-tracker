import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { getPublicProduct, type PublicProduct } from '../api';

// Lazy-load PriceChart so the recharts bundle doesn't pull into the
// public-page initial paint until the data arrives.
const PriceChart = lazy(() => import('../components/PriceChart'));

/**
 * Imperatively set <title> + <meta> tags. Avoids pulling in
 * react-helmet-async just for a couple of head fields. Idempotent — the
 * effect re-runs whenever `product` changes and reuses existing nodes.
 */
function setMeta(name: string, content: string): void {
  // og:* uses the `property` attribute per OG spec; everything else uses `name`.
  const isOg = name.startsWith('og:');
  const selector = isOg ? `meta[property="${name}"]` : `meta[name="${name}"]`;
  let el = document.querySelector(selector) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    if (isOg) el.setAttribute('property', name);
    else el.setAttribute('name', name);
    document.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toFixed(2)}`;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  // value is ISO YYYY-MM-DD or YYYY-MM-DD HH:MM:SS — both parse natively.
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; product: PublicProduct };

export default function PublicProductPage() {
  const { slug } = useParams<{ slug: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    if (!slug) {
      setState({ kind: 'not-found' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    getPublicProduct(slug)
      .then(product => { if (!cancelled) setState({ kind: 'ready', product }); })
      .catch(err => {
        if (cancelled) return;
        if (err instanceof Error && err.message === 'NOT_FOUND') {
          setState({ kind: 'not-found' });
        } else {
          setState({ kind: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
        }
      });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    const { product } = state;
    const title = `${product.display_name} Price History — Price Tracker`;
    document.title = title;
    setMeta('description', `Price history and current low for ${product.display_name}.`);
    setMeta('og:title', title);
    setMeta('og:type', 'website');
    setMeta('og:description', `Price history and current low for ${product.display_name}.`);
  }, [state]);

  return (
    <div className="min-h-screen bg-bg">
      {/* Simplified public header — no nav, just title + Sign-in link. */}
      <header className="border-b border-border bg-surface">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold text-text no-underline">
            <BarChart3 className="w-6 h-6 text-primary" />
            Price Tracker
          </Link>
          <Link
            to="/login"
            className="text-sm text-primary hover:underline"
          >
            Sign in
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        {state.kind === 'loading' && (
          <div className="flex items-center justify-center h-64 text-text-muted">Loading…</div>
        )}
        {state.kind === 'not-found' && (
          <div className="bg-surface border border-border rounded-xl p-8 text-center">
            <h1 className="text-xl font-semibold text-text mb-2">Product not found</h1>
            <p className="text-text-muted text-sm">
              The product you're looking for doesn't exist or hasn't been tracked yet.
            </p>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="bg-danger/10 border border-danger/30 text-danger rounded-xl p-4 text-sm">
            Something went wrong loading this page. ({state.message})
          </div>
        )}
        {state.kind === 'ready' && <ProductView product={state.product} />}
      </main>
    </div>
  );
}

function ProductView({ product }: { product: PublicProduct }) {
  // Adapt server's { date, price } shape to the PriceRecord shape PriceChart
  // expects (it uses `scraped_at` and ignores ids/currency for our needs).
  const chartData = product.price_history.map((row, i) => ({
    id: i,
    tracker_id: 0,
    price: row.price,
    currency: 'USD',
    // Treat the date as start-of-day UTC; PriceChart adds 'Z' if missing.
    scraped_at: `${row.date} 00:00:00`,
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-text mb-1">{product.display_name}</h1>
        <p className="text-xs text-text-muted">{product.normalized_url}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard label="Current low" value={formatPrice(product.lowest_current_price)} />
        <StatCard label="All-time low" value={formatPrice(product.lowest_ever_price)} />
        <StatCard label="Samples" value={String(product.sample_count)} />
        <StatCard label="First seen" value={formatDate(product.first_observed)} />
      </div>

      <div className="bg-surface border border-border rounded-xl p-4">
        <h2 className="text-sm font-semibold text-text-muted mb-3">Price history (daily)</h2>
        <Suspense fallback={<div className="flex items-center justify-center h-64 text-text-muted text-sm">Loading chart…</div>}>
          <PriceChart data={chartData} />
        </Suspense>
      </div>

      <p className="text-xs text-text-muted">
        Aggregated daily-low across all sellers tracked by Price Tracker users. Want
        alerts for this product? <Link to="/login" className="text-primary hover:underline">Sign in</Link>.
      </p>

      <div className="mt-6 pt-4 border-t border-border text-center">
        <Link to="/deals" className="text-text-muted hover:text-primary text-sm">
          See trending deals across the community →
        </Link>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl px-4 py-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="text-lg font-semibold text-text mt-0.5">{value}</p>
    </div>
  );
}
