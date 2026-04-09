import { parsePrice } from '../extractor.js';

// Common CSS selectors used by major retailers, used by the fallback generic
// match loop below. Amazon has a dedicated direct regex at the top of
// extractFromCssPatterns() because Amazon's split-dollar/cents markup doesn't
// play well with naive class-based extraction.
const COMMON_SELECTORS = [
  // Generic price selectors
  '[data-price]',
  '.price .current',
  '.price-current',
  '.product-price',
  '.sale-price',
  '.offer-price',
  // Amazon legacy ids (still used on some pages)
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  // NOTE: '.a-price-whole' was REMOVED from this list because it returns
  // only the dollar portion of a split-price (e.g. "53" for "$53.99"),
  // silently truncating the real price. The direct `a-offscreen` regex
  // in extractFromCssPatterns() covers Amazon correctly.
  // NOTE: '.a-price .a-offscreen' was REMOVED because the matchSelectorInHtml
  // helper below can't handle descendant combinators.
  // Best Buy
  '.priceView-hero-price span',
  '.priceView-customer-price span',
  // Walmart
  '[data-testid="price-wrap"] [itemprop="price"]',
  '.price-characteristic',
  // Target
  '[data-test="product-price"]',
  // Newegg
  '.price-current',
  // B&H
  '[data-selenium="pricingPrice"]',
  // Generic
  '.price',
  '#price',
  '.product-price',
];

/**
 * Direct regex for Amazon's "offscreen" price span — the most reliable
 * source of the full price on amazon.com. Amazon populates this span for
 * screen reader accessibility; it always contains the complete price text
 * with currency symbol and full decimals (e.g. "$53.99"), even when the
 * visual markup uses the split a-price-whole / a-price-fraction pattern
 * that naive class extraction can't reassemble correctly.
 *
 * Example markup:
 *   <span class="a-offscreen">$53.99</span>
 */
const AMAZON_OFFSCREEN_RE = /<span[^>]*class=["']a-offscreen["'][^>]*>([^<]+)<\/span>/i;

export function extractFromCssPatterns(html: string): number | null {
  // Amazon: try the offscreen span first. If present, this is always the
  // right answer and beats every other strategy in the pipeline.
  const amazonMatch = AMAZON_OFFSCREEN_RE.exec(html);
  if (amazonMatch) {
    const parsed = parsePrice(amazonMatch[1]);
    if (parsed !== null) return parsed;
  }

  // Look for data-price attributes next (usually the cleanest non-Amazon source)
  const dataPriceRegex = /data-price=["']([^"']+)["']/gi;
  const match = dataPriceRegex.exec(html);
  if (match) {
    const parsed = parseFloat(match[1]);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // Look for common class/id patterns with price content
  for (const selector of COMMON_SELECTORS) {
    const price = matchSelectorInHtml(html, selector);
    if (price !== null) return price;
  }

  return null;
}

function matchSelectorInHtml(html: string, selector: string): number | null {
  // Extract class or id from simple selectors only. Compound selectors
  // (descendant combinators, attribute selectors) are intentionally not
  // handled here - anything that complex should get its own direct regex.
  let pattern: RegExp | null = null;

  if (selector.startsWith('.') && !selector.includes(' ')) {
    const className = selector.slice(1);
    // Match the class as a whole token within the space-separated class
    // attribute value. \b is NOT sufficient because hyphens count as word
    // boundaries in regex, so \bprice\b would falsely match inside
    // "price-characteristic". Require either start-of-quote OR whitespace
    // on each side.
    pattern = new RegExp(
      `class=["'](?:[^"']*?\\s)?${escapeRegex(className)}(?:\\s[^"']*?)?["'][^>]*>([^<]{1,50})`,
      'gi',
    );
  } else if (selector.startsWith('#')) {
    const id = selector.slice(1);
    pattern = new RegExp(`id=["']${escapeRegex(id)}["'][^>]*>([^<]{1,50})`, 'gi');
  }

  if (!pattern) return null;

  const match = pattern.exec(html);
  if (match) {
    const result = parsePrice(match[1]);
    if (result !== null) return result;
  }

  return null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
