/**
 * Amazon Associates tag insertion.
 *
 * Pure function — given a URL and a tag, return the URL with
 * `?tag=<tag>` set on the query string. Existing `tag` values are
 * replaced (we don't keep someone else's tag if the user pasted a URL
 * with one); other query params are preserved.
 *
 * Only applies to URLs whose hostname matches a recognized Amazon
 * storefront (amazon.com plus regional TLDs and smile.amazon.com).
 * Short links (amzn.to, a.co) pass through unchanged: those redirect
 * server-side and strip query params, so adding `tag` to the short
 * URL doesn't reach the destination. The scrape pipeline already
 * resolves short links to canonical product URLs in `normalized_url`,
 * but we don't rewrite display URLs to the canonical form (would
 * break copy-paste expectations); we just decline to tag short links.
 *
 * Compliance note: callers must not use this for email channel
 * content — Amazon Associates Operating Agreement section 5(b)
 * prohibits affiliate links in email. The push-channel callers
 * (Discord/ntfy/webhook/web_push) are permitted.
 */

/**
 * Hostname suffixes we treat as Amazon storefronts. Lower-cased,
 * leading-dot form so `endsWith` matches both bare and subdomained
 * forms (smile.amazon.com, www.amazon.co.uk, etc.).
 */
const AMAZON_HOST_SUFFIXES: readonly string[] = [
  'amazon.com',
  'amazon.co.uk',
  'amazon.ca',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.co.jp',
  'amazon.com.au',
  'amazon.in',
  'amazon.com.mx',
  'amazon.com.br',
  'amazon.nl',
  'amazon.se',
  'amazon.pl',
];

/**
 * True when `url`'s hostname is an Amazon storefront we can affix
 * a tag to. Returns false for short links, non-Amazon, and malformed
 * URLs. Used both by callers that need to know "is this an affiliate
 * candidate?" and internally by `addAmazonTag`.
 */
export function isAmazonStorefrontUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const suffix of AMAZON_HOST_SUFFIXES) {
    if (host === suffix || host.endsWith('.' + suffix)) return true;
  }
  return false;
}

/**
 * Return `url` with `?tag=<tag>` set. Replaces any existing `tag`
 * parameter so we don't keep someone else's affiliate ID. Non-Amazon
 * URLs, short links, and malformed URLs pass through unchanged. Empty
 * or whitespace-only `tag` is treated as "affiliate disabled" — also
 * pass through unchanged.
 */
export function addAmazonTag(url: string, tag: string): string {
  if (!tag || !tag.trim()) return url;
  if (!isAmazonStorefrontUrl(url)) return url;
  // We know the URL parses because isAmazonStorefrontUrl already
  // validated; recreate the URL object here for the mutation.
  const parsed = new URL(url);
  parsed.searchParams.set('tag', tag);
  return parsed.toString();
}

/**
 * Extract the 10-char ASIN from an Amazon product URL path. Returns
 * null when the path doesn't match a known product-URL shape (e.g.
 * search-results, /b/<browse-node>, /stores/<brand>). The patterns
 * here cover the forms users actually paste from product pages,
 * search results, deal pages, and the mobile app:
 *
 *   /dp/<ASIN>
 *   /<title-slug>/dp/<ASIN>            ← most common from search
 *   /gp/product/<ASIN>                 ← legacy product link
 *   /gp/aw/d/<ASIN>                    ← mobile-web form
 *   /exec/obidos/asin/<ASIN>           ← very old, still works
 *   /product-reviews/<ASIN>            ← reviews page
 *
 * ASIN is always 10 chars, uppercase alphanumeric. Case-insensitive
 * match here because the path can be lowercase in some URLs; we
 * upper-case before returning to keep the canonical form stable.
 */
const AMAZON_ASIN_PATH_RE =
  /\/(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/asin|product-reviews)\/([A-Z0-9]{10})(?:[/?#]|$)/i;
const AMAZON_TITLE_DP_RE = /\/[^/]+\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/i;

export function extractAmazonAsin(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const m = path.match(AMAZON_ASIN_PATH_RE) ?? path.match(AMAZON_TITLE_DP_RE);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Canonicalize an Amazon product URL to the minimal `/dp/<ASIN>` form,
 * dropping search-rank refs (`/ref=sr_1_3`), title slugs, and every
 * non-essential query param (`crid`, `dib`, `keywords`, `qid`,
 * `refinements`, `rnid`, `sr`, `sprefix`, `psc`, `th`, etc.). The
 * result is a clean link that any Amazon URL handler will resolve to
 * the same product page — but without the 800 chars of search context
 * the user accidentally pasted from a search-result click.
 *
 * Behavior:
 *  - Non-Amazon hosts → return unchanged
 *  - Amazon host but no extractable ASIN → return unchanged (better
 *    to keep a working URL than to mangle it)
 *  - Amazon host with ASIN → return `https://<host>/dp/<ASIN>` with
 *    no query string, no hash. Preserves the regional host (so
 *    amazon.co.uk stays amazon.co.uk) — only the path and noise get
 *    stripped.
 *
 * Combine with `addAmazonTag` to produce the affiliate-ready display
 * URL: `canonicalizeAmazonUrl` then `addAmazonTag` yields
 * `https://www.amazon.com/dp/<ASIN>?tag=<id>`.
 */
export function canonicalizeAmazonUrl(url: string): string {
  if (!isAmazonStorefrontUrl(url)) return url;
  const asin = extractAmazonAsin(url);
  if (!asin) return url;
  try {
    const parsed = new URL(url);
    parsed.pathname = `/dp/${asin}`;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
