import { useEffect, useState } from 'react';
import { Gift, Copy, RefreshCw } from 'lucide-react';
import {
  getMyWishlist,
  getWishlistShareToken,
  rotateWishlistShareTokenApi,
} from '../api';

/**
 * Settings card for the Wishlist / gift mode feature. Shows:
 *   - subtitle explaining the surprise-blind invariant
 *   - the share URL with a Copy button (auto-generates one on first mount)
 *   - a Rotate button (with confirm) to invalidate the existing link
 *   - a counter of items currently on the user's wishlist
 *
 * The user adds/removes items via the toggle on TrackerDetail; this card is
 * the share-link control center.
 */
export function WishlistCard() {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [count, setCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function refresh() {
    try {
      const [share, mine] = await Promise.all([
        getWishlistShareToken(),
        getMyWishlist(),
      ]);
      setShareUrl(share.share_url);
      setCount(mine.count);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleRotate() {
    if (!confirm('Generate a new share link? The current link will stop working.')) return;
    setBusy(true);
    setError(null);
    try {
      const r = await rotateWishlistShareTokenApi();
      setShareUrl(r.share_url);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function handleCopy() {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="bg-surface border border-border rounded-xl p-4 sm:p-6">
      <header className="flex items-center justify-between mb-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Gift className="w-5 h-5 text-primary" /> Wishlist
        </h2>
      </header>
      <p className="text-text-muted text-sm mb-4">
        Share with gift-givers. They can see prices and claim items, but you'll
        never know which.
      </p>

      {error && <div className="text-danger text-sm mb-2">{error}</div>}

      {shareUrl && (
        <>
          <label className="block text-sm font-medium text-text-muted mb-1.5">
            Share link
          </label>
          <div className="flex gap-2 mb-3">
            <input
              readOnly
              value={shareUrl}
              className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 text-sm text-text font-mono break-all focus:outline-none focus:border-primary"
              onFocus={e => e.currentTarget.select()}
            />
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-3 py-2 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors"
              title="Copy share link"
            >
              <Copy className="w-4 h-4" />
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-text-muted text-sm">
              {count} {count === 1 ? 'item' : 'items'} on your wishlist
            </p>
            <button
              onClick={handleRotate}
              disabled={busy}
              className="flex items-center gap-1 text-sm text-text-muted hover:text-danger disabled:opacity-50"
              title="Generate a new link and invalidate the current one"
            >
              <RefreshCw className={`w-4 h-4 ${busy ? 'animate-spin' : ''}`} />
              Rotate link
            </button>
          </div>
        </>
      )}
    </section>
  );
}
