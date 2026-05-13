/**
 * Thin shim that applies the Amazon affiliate tag to URL-bearing
 * fields on objects we serialize to the API. Centralizing this here
 * keeps route handlers from each having to remember to call
 * `addAmazonTag` on every Tracker / TrackerUrl / deal-feed entry.
 *
 * Design notes:
 *  - Returns shallow copies (never mutates the input) so DB-layer
 *    values stay clean. Internal callers (scrape pipeline, scheduler)
 *    keep working with the untagged URL.
 *  - Pulls the tag from `config` at call time, not at module-load
 *    time, so tests that mutate `config.amazonAffiliateTag` see the
 *    expected behavior.
 *  - Each helper takes the smallest object shape it needs (i.e.
 *    `{ url: string }`-ish) rather than the full `Tracker` /
 *    `TrackerUrl` type, so it composes with route-specific response
 *    shapes too (e.g. deal-feed entries that aren't Tracker-typed).
 */

import { config } from '../config.js';
import { addAmazonTag } from './affiliate.js';

/**
 * Apply the configured Amazon affiliate tag to `url`. No-op when the
 * tag is unset or the URL isn't an Amazon storefront. Centralized
 * here so callers don't import both `config` and `addAmazonTag`.
 */
export function affiliateUrl(url: string): string {
  return addAmazonTag(url, config.amazonAffiliateTag);
}

/**
 * Rewrite the `url` field on a single Tracker-shaped object. Also
 * rewrites `best_seller_url` (used by the dashboard list endpoint) if
 * present. Returns a shallow copy; original is unchanged.
 */
export function affiliateTracker<T extends { url: string; best_seller_url?: string | null }>(
  tracker: T,
): T {
  if (!config.amazonAffiliateTag) return tracker;
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
  if (!config.amazonAffiliateTag) return trackers;
  return trackers.map(affiliateTracker);
}

/**
 * Rewrite the `url` field on a single TrackerUrl (seller row) or any
 * object exposing a string `url`. Returns a shallow copy.
 */
export function affiliateUrlOnObject<T extends { url: string }>(obj: T): T {
  if (!config.amazonAffiliateTag) return obj;
  return { ...obj, url: affiliateUrl(obj.url) };
}

/**
 * Convenience: rewrite a list of seller-URL rows.
 */
export function affiliateUrlOnObjects<T extends { url: string }>(objs: T[]): T[] {
  if (!config.amazonAffiliateTag) return objs;
  return objs.map(affiliateUrlOnObject);
}
