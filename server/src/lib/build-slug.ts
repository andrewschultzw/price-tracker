import { createHash } from 'crypto';

/**
 * Build a stable slug for a public product page from its display name and
 * normalized URL. Pure + deterministic — same `normalizedUrl` always produces
 * the same 6-char hash suffix, so renaming a tracker does NOT change the
 * slug for an existing row (the migration / createSlugForUrl helpers use
 * INSERT OR IGNORE keyed on normalized_url and never overwrite display_name).
 *
 * Algorithm:
 *   1. Lowercase the display name.
 *   2. Strip everything that's not a word char, whitespace, or hyphen (this
 *      naturally drops Unicode like ®, em-dash, parentheses, registered marks).
 *   3. Collapse whitespace runs to a single hyphen.
 *   4. Collapse hyphen runs to a single hyphen.
 *   5. Trim leading/trailing hyphens.
 *   6. Truncate to 60 chars (URL aesthetics — long names get cut off).
 *   7. Append `-<6 hex>` derived from sha256(normalizedUrl).
 *
 * Empty / whitespace-only display names fall back to just the hash suffix
 * with no leading hyphen so the URL doesn't start with `-`.
 */
export function buildSlug(displayName: string, normalizedUrl: string): string {
  const base = (displayName ?? '')
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  const hash = createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 6);

  return base.length > 0 ? `${base}-${hash}` : hash;
}
