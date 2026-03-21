import { parsePrice } from '../extractor.js';

export function extractFromRegex(html: string): number | null {
  // Strip HTML tags to get visible text
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

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
