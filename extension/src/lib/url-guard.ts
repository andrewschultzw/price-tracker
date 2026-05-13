/**
 * Hand-mirror of `server/src/scraper/blocked-retailers.ts`'s
 * BLOCKED_HOSTS. Adding a tracker for a host on this list lands the
 * seller in `status='blocked'` on the server side; surfacing it
 * here lets the popup say "can't track this retailer" up-front
 * instead of letting the user submit and silently land in blocked
 * state.
 *
 * Drift between extension and server is guarded by
 * `extension/src/lib/url-guard.parity.test.ts`, which reads both
 * source files at test time and fails when the lists diverge.
 */
const BLOCKED_RETAILER_HOSTS: ReadonlySet<string> = new Set([
  'homedepot.com',
  'bestbuy.com',
]);

/**
 * Friendly display name per host. Used in the popup's "can't track"
 * copy so users see "Home Depot blocks automated scrapers" instead
 * of "homedepot.com blocks automated scrapers".
 */
const BLOCKED_RETAILER_DISPLAY_NAMES: Record<string, string> = {
  'homedepot.com': 'Home Depot',
  'bestbuy.com': 'Best Buy',
};

/**
 * True when `url`'s hostname is known to blanket-block the price
 * tracker's egress IP. `www.` is stripped before matching so
 * `www.homedepot.com` and `homedepot.com` resolve to the same entry.
 */
export function isBlockedRetailerHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return BLOCKED_RETAILER_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * User-facing reason string when `url`'s host is a known blocked
 * retailer; null otherwise. Surfaced through the existing
 * `tpl-unsupported` template in popup.html.
 */
export function blockedRetailerReason(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!BLOCKED_RETAILER_HOSTS.has(host)) return null;
  const display = BLOCKED_RETAILER_DISPLAY_NAMES[host] ?? host;
  return `${display} blocks our scraper at the network level. Try the same item on Amazon, Newegg, or another retailer.`;
}

/**
 * Exported for the parity test. Read-only.
 */
export function getBlockedRetailerHosts(): readonly string[] {
  return [...BLOCKED_RETAILER_HOSTS];
}

/**
 * Decide whether the active-tab URL is something the extension can
 * sensibly track. Used by the popup to show a "Can't track this page"
 * state for chrome://, about:, file://, javascript:, and lookalike
 * URLs whose `hostname` parses to something non-DNS-shaped (e.g.,
 * `chrome://settings`.hostname === 'settings').
 *
 * Without this guard the form happily pre-fills with the garbage URL,
 * the user submits, and the server rejects with a generic 400 — rough
 * UX. With it we surface the problem immediately and tell the user
 * what to do instead.
 *
 * Returns:
 *   - null when the URL is OK to track
 *   - a short human-readable reason string otherwise
 */
export function unsupportedReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'This page doesn\'t have a usable URL.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    // Drop the trailing ':' for friendlier display (chrome:, about:, etc.)
    const proto = parsed.protocol.replace(/:$/, '');
    return `${proto}:// pages can't be tracked.`;
  }
  // chrome://settings parses with protocol='chrome:' (caught above),
  // but http://localhost has hostname='localhost' (no dot) — we want
  // to allow real product pages, not localhost noise. Conservative
  // DNS shape: at least one dot, alphanumerics + hyphens + dots only,
  // ending in a TLD of at least 2 characters.
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(parsed.hostname)) {
    return 'This page doesn\'t look like a retailer product page.';
  }
  return null;
}
