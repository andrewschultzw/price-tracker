/**
 * Product-title extraction (share-flow name autofill). Same philosophy as the
 * price strategies: regex over raw HTML, structured data first, cascading
 * fallbacks, null when nothing trustworthy is found.
 *
 * Precedence: JSON-LD Product.name → og:title → <title>. The <title> tag is
 * the noisiest source, so retailer boilerplate is stripped before returning.
 */

const MAX_TITLE_LENGTH = 200; // trackers.name route-layer max

/** Minimal HTML entity decode for the handful that appear in real titles. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * Strip retailer boilerplate. Mirrors the client's cleanSharedTitle rules
 * (client/src/lib/share-url.ts) — conservative on purpose: an untouched
 * title is fine, a mangled product name is not.
 */
export function cleanProductTitle(raw: string): string | null {
  let t = decodeEntities(raw).replace(/\s+/g, ' ').trim();
  // "Amazon.com: Product Name"
  t = t.replace(/^amazon\.[a-z.]+\s*:\s*/i, '');
  // Trailing " | Best Buy" — split once from the right, keep a non-empty head.
  t = t.replace(/\s*\|\s*[^|]*$/, (m, offset) => (offset === 0 ? m : ''));
  // Trailing " - Amazon.com"-style store suffixes (require a dot-TLD so
  // "Cast Iron - 12 inch" survives).
  t = t.replace(/\s+-\s+[A-Za-z0-9 ]+\.[a-z]{2,}\s*$/i, '');
  t = t.trim();
  if (!t) return null;
  return t.length > MAX_TITLE_LENGTH ? t.slice(0, MAX_TITLE_LENGTH).trim() : t;
}

function findNameInJsonLd(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const name = findNameInJsonLd(item);
      if (name !== null) return name;
    }
    return null;
  }
  const obj = data as Record<string, unknown>;
  if (obj['@type'] === 'Product' && typeof obj.name === 'string' && obj.name.trim()) {
    return obj.name;
  }
  // @graph / nested containers (mirrors findPriceInJsonLd's recursion).
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const name = findNameInJsonLd(value);
      if (name !== null) return name;
    }
  }
  return null;
}

export function extractProductTitle(html: string): string | null {
  // 1. JSON-LD Product.name — the same blocks the price strategy reads.
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const name = findNameInJsonLd(JSON.parse(match[1]));
      if (name) {
        const cleaned = cleanProductTitle(name);
        if (cleaned) return cleaned;
      }
    } catch {
      // Invalid JSON, skip — same tolerance as the price strategy.
    }
  }

  // 2. og:title (either attribute order).
  const og =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og?.[1]) {
    const cleaned = cleanProductTitle(og[1]);
    if (cleaned) return cleaned;
  }

  // 3. <title> — noisiest, cleaned hardest.
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1]) {
    const cleaned = cleanProductTitle(title[1]);
    if (cleaned) return cleaned;
  }

  return null;
}
