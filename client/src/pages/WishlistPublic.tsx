import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BarChart3, Gift, ExternalLink, Check, X } from 'lucide-react';
import {
  getPublicWishlist,
  claimWishlistItem,
  unclaimWishlistItem,
  type PublicWishlist,
} from '../api';

/**
 * Imperatively set <title> + <meta> tags. Mirrors PublicProduct's setMeta —
 * keeps the public surface consistent without pulling in react-helmet.
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

function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return `$${value.toFixed(2)}`;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: PublicWishlist };

/**
 * Anonymous public view of a user's wishlist. Reachable only via the share
 * token in the URL. Gift-givers can:
 *   - see name/price/AI-pill/retailer link for each item
 *   - click "Claim this gift" — server returns a claim_token saved in
 *     localStorage so this visitor can later un-claim ("changed my mind")
 *   - see "Already claimed by someone" on items claimed by other visitors
 *   - see "You claimed this — undo" on items where this browser holds the
 *     claim_token in localStorage
 *
 * The wishlist owner deliberately CANNOT see claim status anywhere in the
 * app — that's the whole surprise-preservation invariant.
 */
export default function WishlistPublic() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  // Map of tracker_id → claim_token from localStorage (i.e. items THIS
  // visitor has claimed and can un-claim).
  const [myClaims, setMyClaims] = useState<Record<number, string>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState({ kind: 'not-found' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    getPublicWishlist(token)
      .then(data => {
        if (!cancelled) setState({ kind: 'ready', data });
      })
      .catch(err => {
        if (cancelled) return;
        if (err instanceof Error && err.message === 'NOT_FOUND') {
          setState({ kind: 'not-found' });
        } else {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        }
      });
    // Hydrate per-token claim tokens from localStorage so the "you claimed
    // this" affordance survives reloads.
    const claims: Record<number, string> = {};
    for (const key of Object.keys(localStorage)) {
      const prefix = `wishlist_claim_${token}_`;
      if (key.startsWith(prefix)) {
        const trackerId = Number(key.slice(prefix.length));
        const claimToken = localStorage.getItem(key);
        if (Number.isFinite(trackerId) && claimToken) {
          claims[trackerId] = claimToken;
        }
      }
    }
    setMyClaims(claims);
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (state.kind !== 'ready') return;
    const { data } = state;
    const title = data.display_name
      ? `${data.display_name}'s Wishlist — Price Tracker`
      : 'Wishlist — Price Tracker';
    document.title = title;
    setMeta(
      'description',
      'A shared wishlist on Price Tracker. Claim items to coordinate gifts.',
    );
    setMeta('og:title', title);
    setMeta('og:type', 'website');
  }, [state]);

  async function handleClaim(trackerId: number) {
    if (!token) return;
    setActionError(null);
    try {
      const { claim_token } = await claimWishlistItem(token, trackerId);
      localStorage.setItem(`wishlist_claim_${token}_${trackerId}`, claim_token);
      setMyClaims(prev => ({ ...prev, [trackerId]: claim_token }));
      const fresh = await getPublicWishlist(token);
      setState({ kind: 'ready', data: fresh });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'ALREADY_CLAIMED') {
        setActionError('Someone else just claimed this. Refreshing…');
        const fresh = await getPublicWishlist(token).catch(() => null);
        if (fresh) setState({ kind: 'ready', data: fresh });
      } else {
        setActionError(msg);
      }
    }
  }

  async function handleUnclaim(trackerId: number) {
    if (!token) return;
    const claimToken = myClaims[trackerId];
    if (!claimToken) return;
    setActionError(null);
    try {
      await unclaimWishlistItem(token, trackerId, claimToken);
      localStorage.removeItem(`wishlist_claim_${token}_${trackerId}`);
      setMyClaims(prev => {
        const next = { ...prev };
        delete next[trackerId];
        return next;
      });
      const fresh = await getPublicWishlist(token);
      setState({ kind: 'ready', data: fresh });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="min-h-screen bg-bg">
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
        {state.kind === 'loading' && (
          <div className="flex items-center justify-center h-64 text-text-muted">
            Loading…
          </div>
        )}
        {state.kind === 'not-found' && (
          <div className="bg-surface border border-border rounded-xl p-8 text-center">
            <h1 className="text-xl font-semibold text-text mb-2">
              This wishlist link isn't valid
            </h1>
            <p className="text-text-muted text-sm">
              It may have been rotated. Ask the owner for a fresh link.
            </p>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="bg-danger/10 border border-danger/30 text-danger rounded-xl p-4 text-sm">
            Something went wrong loading this wishlist. ({state.message})
          </div>
        )}
        {state.kind === 'ready' && (
          <WishlistView
            data={state.data}
            myClaims={myClaims}
            actionError={actionError}
            onClaim={handleClaim}
            onUnclaim={handleUnclaim}
          />
        )}
      </main>
    </div>
  );
}

function WishlistView({
  data,
  myClaims,
  actionError,
  onClaim,
  onUnclaim,
}: {
  data: PublicWishlist;
  myClaims: Record<number, string>;
  actionError: string | null;
  onClaim: (trackerId: number) => void;
  onUnclaim: (trackerId: number) => void;
}) {
  const title = data.display_name ? `${data.display_name}'s Wishlist` : 'A Wishlist';
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-text mb-1">
          <Gift className="w-6 h-6 text-primary" /> {title}
        </h1>
        <p className="text-sm text-text-muted">
          Pick something to gift. Items already claimed by others are marked.
        </p>
      </div>

      {actionError && (
        <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg px-3 py-2 text-sm">
          {actionError}
        </div>
      )}

      {data.items.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-8 text-center">
          <p className="text-text-muted text-sm">
            No items yet — the owner hasn't added anything.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {data.items.map(item => {
            const minePending = myClaims[item.tracker_id];
            return (
              <div
                key={item.tracker_id}
                className="bg-surface border border-border rounded-xl p-4 flex flex-col gap-2"
              >
                <h2 className="text-base font-semibold text-text break-words">
                  {item.name}
                </h2>
                <div className="flex items-baseline gap-3">
                  <span className="text-xl font-bold text-text">
                    {formatPrice(item.last_price)}
                  </span>
                  {item.ai_verdict_tier && (
                    <span className="text-xs px-2 py-0.5 rounded bg-primary/15 text-primary">
                      {item.ai_verdict_tier}
                    </span>
                  )}
                </div>
                {item.ai_verdict_reason && (
                  <p className="text-xs text-text-muted">{item.ai_verdict_reason}</p>
                )}
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-text-muted hover:text-primary flex items-center gap-1 truncate"
                >
                  <span className="truncate">{item.url}</span>
                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                </a>

                <div className="mt-2">
                  {minePending ? (
                    <button
                      onClick={() => onUnclaim(item.tracker_id)}
                      className="w-full flex items-center justify-center gap-1 px-3 py-2 bg-success/15 hover:bg-success/25 text-success rounded-lg text-sm font-medium transition-colors"
                    >
                      <Check className="w-4 h-4" />
                      You claimed this — undo
                    </button>
                  ) : item.is_claimed ? (
                    <button
                      disabled
                      className="w-full flex items-center justify-center gap-1 px-3 py-2 bg-surface-hover text-text-muted rounded-lg text-sm font-medium cursor-not-allowed"
                    >
                      <X className="w-4 h-4" />
                      Already claimed by someone
                    </button>
                  ) : (
                    <button
                      onClick={() => onClaim(item.tracker_id)}
                      className="w-full flex items-center justify-center gap-1 px-3 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      <Gift className="w-4 h-4" />
                      Claim this gift
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-text-muted text-center pt-4 border-t border-border">
        Powered by Price Tracker —{' '}
        <Link to="/login" className="text-primary hover:underline">
          track your own prices
        </Link>
      </p>
    </div>
  );
}
