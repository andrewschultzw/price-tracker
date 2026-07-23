/**
 * Web Share Target payload parsing (deal-intelligence phase 2).
 *
 * Android's share sheet is sloppy about which field carries what: browsers
 * put the page URL in `url`, but many apps (including Amazon's) put it in
 * `text` — sometimes surrounded by marketing copy — and a few only populate
 * `title`. Extraction precedence: url → first link in text → first link in
 * title.
 */

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/;

function firstUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(URL_RE);
  if (!match) return null;
  // Shared text often ends the link with punctuation ("check this out:
  // https://... !") — trim obvious trailing junk that regex greed captured.
  const cleaned = match[0].replace(/[.,;:!?]+$/, '');
  try {
    new URL(cleaned);
    return cleaned;
  } catch {
    return null;
  }
}

export function extractSharedUrl(params: {
  url?: string | null;
  text?: string | null;
  title?: string | null;
}): string | null {
  return firstUrl(params.url) ?? firstUrl(params.text) ?? firstUrl(params.title);
}

/**
 * Strip retailer boilerplate from a shared page title so it prefills the
 * tracker-name field as a product name, not an SEO string. Conservative:
 * only patterns that are unambiguously boilerplate; an untouched title is
 * fine, a mangled product name is not.
 */
export function cleanSharedTitle(title: string | null | undefined): string {
  if (!title) return '';
  let t = title.trim();
  // "Amazon.com: Product Name" / "Amazon.com : Product Name"
  t = t.replace(/^amazon\.[a-z.]+\s*:\s*/i, '');
  // Trailing " | Best Buy", " | Newegg.com", etc. — split once from the right.
  t = t.replace(/\s*\|\s*[^|]*$/,
    (m, offset) => (offset === 0 ? m : ''));
  // Trailing " - Amazon.com" / " - Walmart.com" style store suffixes only
  // (require a dot-something so "Cast Iron - 12 inch" survives).
  t = t.replace(/\s+-\s+[A-Za-z0-9 ]+\.[a-z]{2,}\s*$/i, '');
  // Titles that were ONLY a URL (some apps) prefill nothing.
  if (URL_RE.test(t) && t.replace(URL_RE, '').trim() === '') return '';
  return t.trim();
}
