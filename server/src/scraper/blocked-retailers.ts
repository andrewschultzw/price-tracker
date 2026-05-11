/**
 * Retailers whose WAF blanket-blocks our homelab egress IP for every
 * request, regardless of headers / UA / TLS fingerprint. Adding a tracker
 * URL to one of these hosts auto-marks the seller as status='blocked' on
 * creation so the user sees the right state immediately (rather than
 * watching it churn through 3 failed cron ticks first).
 *
 * Confirmed via direct curl probes from CT 302 (same egress IP as the
 * Playwright scraper). The block is observable as `Server: AkamaiGHost`
 * with HTTP 403 on the bare retailer homepage, not just product pages —
 * so this is IP-reputation, not URL-pattern detection.
 *
 * If the block lifts (residential IP rotates, retailer un-blocks the
 * range, etc.) the user can manually "Check Now" on a blocked seller;
 * a successful scrape moves it back to 'active' automatically.
 */

const BLOCKED_HOSTS: ReadonlySet<string> = new Set([
  'homedepot.com',
  'bestbuy.com',
]);

/**
 * User-facing message stored in `tracker_urls.last_error` when a seller
 * is marked blocked. Surfaced in the UI; kept consistent across the
 * scraper detection path and the create-time auto-mark path so the user
 * sees the same wording regardless of how the seller got there.
 */
export const RETAILER_BLOCKED_ERROR_MESSAGE =
  'Retailer blocks automated requests from this network';

/**
 * True when the given URL's hostname is known to blanket-block our IP.
 * Strips the leading `www.` so `www.homedepot.com` matches the same
 * entry as `homedepot.com`. Invalid URLs return false (the URL parser
 * upstream will reject them on its own path).
 */
export function isBlockedRetailerHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return BLOCKED_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Exported for tests / admin tooling. Read-only.
 */
export function getBlockedRetailerHosts(): readonly string[] {
  return [...BLOCKED_HOSTS];
}
