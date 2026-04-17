import { parsePrice } from '../extractor.js';
import { sliceBalancedDiv } from './css-patterns.js';

/**
 * Newegg product pages embed the main buy box inside a single
 * `<div class="product-price">` container with lots of sponsored /
 * recommended-product carousels around it. Stripping tags and doing a
 * frequency-mode over page-wide `$NNN` matches is dominated by
 * carousel items (e.g. the 10TB-HDD regression reported $10/$249/$389
 * from random sponsored drives). Scoping the regex to the main
 * container first eliminates that noise.
 */
function extractNeweggMainPriceScope(html: string): string | null {
  const match = html.match(/<div[^>]*class=["'][^"']*\bproduct-price\b[^"']*["'][^>]*>/i);
  if (!match) return null;
  return sliceBalancedDiv(html, match);
}

export function extractFromRegex(html: string): number | null {
  // Scope to Newegg's main product-price container when present so we
  // don't pick up carousel/recommendation prices.
  const scoped = extractNeweggMainPriceScope(html);
  const source = scoped ?? html;

  // Strip HTML tags to get visible text
  const text = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Match common price patterns: $1,234.56 or $12.99
  const priceRegex = /\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
  const prices: number[] = [];

  let match;
  while ((match = priceRegex.exec(text)) !== null) {
    const price = parsePrice(match[0]);
    if (price !== null && price > 0 && price < 100000) {
      prices.push(price);
    }
  }

  if (prices.length === 0) return null;

  // Return the most common price, or the first one
  const freq = new Map<number, number>();
  for (const p of prices) {
    freq.set(p, (freq.get(p) || 0) + 1);
  }

  let bestPrice = prices[0];
  let bestCount = 0;
  for (const [price, count] of freq) {
    if (count > bestCount) {
      bestCount = count;
      bestPrice = price;
    }
  }

  return bestPrice;
}
