import { canonicalDomain } from './domains.js';

/**
 * Tracking / affiliate query parameters to strip during normalization.
 * Extend this list if new retailer tracking noise is observed — never
 * remove an entry without verifying it doesn't disambiguate a product.
 */
const TRACKING_PARAMS = new Set([
  'tag', 'ref', 'ref_', '_encoding', 'psc', 'srsltid',
  'cm_sp', 'cm_cat', 'cm_ite', 'cm_lm', 'cm_pla', 'cm_re',
  '_gl',
]);

function isTrackingParam(key: string): boolean {
  if (TRACKING_PARAMS.has(key)) return true;
  if (key.startsWith('utm_')) return true;
  // Known Google Analytics cookie names only. A broader `_ga*` prefix
  // would match benign product params like `_gaffe`.
  if (key === '_ga' || key === '_gat' || key === '_gid') return true;
  return false;
}

/**
 * Produce a canonical key for a tracker URL so two users adding the
 * "same product" via different URL variants land on the same string.
 * Pure; deterministic; returns null on malformed input so callers can
 * store null and skip overlap matching safely.
 *
 * Pipeline: parse → canonical domain → lowercase path → drop tracking
 * params → sort remaining params → strip trailing slash and fragment.
 *
 * Short-link resolution (a.co → amazon.com/dp/...) happens at scrape
 * time in the scheduler, not here. This helper operates on whatever
 * URL it's given.
 */
export function normalizeTrackerUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.hostname) return null;

  const domain = canonicalDomain(url);
  if (!domain) return null;

  let path = parsed.pathname.toLowerCase();
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const kept: [string, string][] = [];
  parsed.searchParams.forEach((value, key) => {
    if (!isTrackingParam(key)) kept.push([key, value]);
  });
  kept.sort(([a], [b]) => a.localeCompare(b));

  const query = kept.length > 0
    ? '?' + kept.map(([k, v]) => `${k}=${v}`).join('&')
    : '';

  return `${domain}${path}${query}`;
}
