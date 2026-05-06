import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3, ArrowRight } from 'lucide-react';
import { getCommunityDeals, type DealFeedEntry } from '../api';

/**
 * Imperatively set <title> + <meta> tags. Same pattern as PublicProduct —
 * keeps us off the react-helmet-async dependency for one or two head fields.
 */
function setMeta(name: string, content: string): void {
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

function fmtHoursAgo(hours: number): string {
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${Math.round(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function fmtPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; entries: DealFeedEntry[] };

export default function CommunityDealsPage() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    getCommunityDeals()
      .then(res => { if (!cancelled) setState({ kind: 'ready', entries: res.entries }); })
      .catch(err => {
        if (cancelled) return;
        setState({ kind: 'error', message: err instanceof Error ? err.message : 'Unknown error' });
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const title = 'Community Deals — Price Tracker';
    document.title = title;
    setMeta(
      'description',
      'Biggest threshold-beating price drops across the Price Tracker community in the last 7 days.',
    );
    setMeta('og:title', title);
    setMeta('og:type', 'website');
    setMeta(
      'og:description',
      'Biggest threshold-beating price drops across the Price Tracker community in the last 7 days.',
    );
  }, []);

  return (
    <div className="min-h-screen bg-bg">
      {/* Simplified public header — matches PublicProduct's shape so SEO
          crawlers see a consistent header across the public surface. */}
      <header className="border-b border-border bg-surface">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-lg font-bold text-text no-underline">
            <BarChart3 className="w-6 h-6 text-primary" />
            Price Tracker
          </Link>
          <Link to="/login" className="text-sm text-primary hover:underline">
            Sign in
          </Link>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-text mb-1">Community Deals</h1>
          <p className="text-text-muted text-sm">
            Biggest drops across the Price Tracker community in the last 7 days.
          </p>
        </div>

        {state.kind === 'loading' && (
          <div className="flex items-center justify-center h-64 text-text-muted">Loading…</div>
        )}
        {state.kind === 'error' && (
          <div className="bg-danger/10 border border-danger/30 text-danger rounded-xl p-4 text-sm">
            Something went wrong loading the deal feed. ({state.message})
          </div>
        )}
        {state.kind === 'ready' && state.entries.length === 0 && (
          <div className="bg-surface border border-border rounded-xl p-8 text-center">
            <h2 className="text-lg font-semibold text-text mb-2">No deals yet — check back soon</h2>
            <p className="text-text-muted text-sm">
              When tracked products hit their thresholds, they'll show up here.
            </p>
          </div>
        )}
        {state.kind === 'ready' && state.entries.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {state.entries.map(e => (
              <DealCard key={e.slug} entry={e} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function DealCard({ entry }: { entry: DealFeedEntry }) {
  const dropPctLabel = `${(entry.drop_pct * 100).toFixed(0)}% below threshold`;
  return (
    <Link
      to={`/p/${entry.slug}`}
      className="bg-surface border border-border rounded-xl p-4 hover:border-primary/50 transition-colors no-underline block"
    >
      <h3 className="text-sm font-semibold text-text mb-1 line-clamp-2">{entry.display_name}</h3>
      <p className="text-xl font-bold text-text mb-2">{fmtPrice(entry.current_price)}</p>
      <p className="text-xs text-text-muted mb-3">
        <span className="text-success font-medium">{dropPctLabel}</span>
        <span className="mx-1.5">•</span>
        {fmtHoursAgo(entry.hours_ago)}
      </p>
      <p className="text-xs text-primary flex items-center gap-1">
        View price history
        <ArrowRight className="w-3 h-3" />
      </p>
    </Link>
  );
}
