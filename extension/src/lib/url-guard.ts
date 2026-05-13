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
