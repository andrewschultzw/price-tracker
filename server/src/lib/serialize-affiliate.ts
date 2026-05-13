/**
 * Display-time URL rewrite for tracker-shaped API responses. Two
 * concerns combined into one pass so route handlers stay tidy:
 *
 *   1. **Canonicalize Amazon URLs.** Pasted product URLs from search
 *      results carry ~800 chars of `crid`/`dib`/`keywords`/`qid`/
 *      `refinements` noise — useless for the user, ugly in the UI,
 *      and visually obscures the affiliate `tag` param. We collapse
 *      to `/dp/<ASIN>` and drop the rest. Always on (independent of
 *      the affiliate feature).
 *   2. **Apply the affiliate tag.** Append `?tag=<id>` from the env
 *      var when configured; no-op when unset (feature off).
 *
 * Returns shallow copies; original DB-layer values stay clean. Pulls
 * the tag from `config` at call time so tests can mutate it freely.
 *
 * Each helper takes the smallest object shape it needs (i.e.
 * `{ url: string }`-ish) so it composes with both Tracker and
 * route-specific response shapes (deal-feed entries, wishlist items,
 * etc.) without an interface chain.
 */

import { config } from '../config.js';
import { addAmazonTag, canonicalizeAmazonUrl } from './affiliate.js';

/**
 * Single transform: canonicalize Amazon URLs, then tag. Non-Amazon
 * URLs pass through unchanged on both legs.
 */
export function affiliateUrl(url: string): string {
  const clean = canonicalizeAmazonUrl(url);
  return addAmazonTag(clean, config.amazonAffiliateTag);
}

/**
 * Rewrite the `url` field on a single Tracker-shaped object. Also
 * rewrites `best_seller_url` (used by the dashboard list endpoint) if
 * present. Returns a shallow copy; original is unchanged.
 */
export function affiliateTracker<T extends { url: string; best_seller_url?: string | null }>(
  tracker: T,
): T {
  return {
    ...tracker,
    url: affiliateUrl(tracker.url),
    ...(tracker.best_seller_url !== undefined
      ? { best_seller_url: tracker.best_seller_url == null ? tracker.best_seller_url : affiliateUrl(tracker.best_seller_url) }
      : {}),
  };
}

/**
 * Rewrite the `url` field on a list of Tracker-shaped objects.
 */
export function affiliateTrackers<T extends { url: string; best_seller_url?: string | null }>(
  trackers: T[],
): T[] {
  return trackers.map(affiliateTracker);
}

/**
 * Rewrite the `url` field on a single TrackerUrl (seller row) or any
 * object exposing a string `url`. Returns a shallow copy.
 */
export function affiliateUrlOnObject<T extends { url: string }>(obj: T): T {
  return { ...obj, url: affiliateUrl(obj.url) };
}

/**
 * Convenience: rewrite a list of seller-URL rows.
 */
export function affiliateUrlOnObjects<T extends { url: string }>(objs: T[]): T[] {
  return objs.map(affiliateUrlOnObject);
}
