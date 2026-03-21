import { logger } from '../../logger.js';

export function extractFromJsonLd(html: string): number | null {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(match[1]);
      const price = findPriceInJsonLd(data);
      if (price !== null) return price;
    } catch {
      // Invalid JSON, skip
    }
  }
  return null;
}

function findPriceInJsonLd(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;

  if (Array.isArray(data)) {
    for (const item of data) {
      const price = findPriceInJsonLd(item);
      if (price !== null) return price;
    }
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Direct offer price
  if (obj['@type'] === 'Offer' || obj['@type'] === 'AggregateOffer') {
    const p = obj.price ?? obj.lowPrice;
    if (p !== undefined) {
      const parsed = parseFloat(String(p));
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }

  // Product with offers
  if (obj['@type'] === 'Product') {
    const offers = obj.offers;
    if (offers) {
      const price = findPriceInJsonLd(offers);
      if (price !== null) return price;
    }
  }

  // @graph array
  if (obj['@graph']) {
    const price = findPriceInJsonLd(obj['@graph']);
    if (price !== null) return price;
  }

  // Recurse into nested objects
  for (const value of Object.values(obj)) {
    if (typeof value === 'object' && value !== null) {
      const price = findPriceInJsonLd(value);
      if (price !== null) return price;
    }
  }

  return null;
}
