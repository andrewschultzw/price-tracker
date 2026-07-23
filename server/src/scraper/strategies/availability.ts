/**
 * Availability extraction (back-in-stock, phase 4). Positive signals only:
 * schema.org offer availability inside JSON-LD blocks. No signal → null,
 * and the caller leaves the stored state untouched — a scrape FAILURE must
 * never read as out-of-stock.
 *
 * Multi-offer semantics: a product with any purchasable offer is in stock;
 * out_of_stock requires signals to exist AND all of them to be negative
 * (variants sell out independently — one live variant means buyable).
 */

export type AvailabilitySignal = 'in_stock' | 'out_of_stock';

const IN_STOCK = new Set(['instock', 'limitedavailability', 'instoreonly', 'onlineonly']);
const OUT_OF_STOCK = new Set(['outofstock', 'soldout', 'discontinued']);

/** Normalize "https://schema.org/InStock", "http://...", or bare "InStock". */
function classify(value: unknown): AvailabilitySignal | null {
  if (typeof value !== 'string') return null;
  const tail = value.trim().toLowerCase().replace(/^https?:\/\/schema\.org\//, '');
  if (IN_STOCK.has(tail)) return 'in_stock';
  if (OUT_OF_STOCK.has(tail)) return 'out_of_stock';
  return null;
}

function collectSignals(data: unknown, out: AvailabilitySignal[]): void {
  if (!data || typeof data !== 'object') return;
  if (Array.isArray(data)) {
    for (const item of data) collectSignals(item, out);
    return;
  }
  const obj = data as Record<string, unknown>;
  const sig = classify(obj.availability);
  if (sig) out.push(sig);
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') collectSignals(value, out);
  }
}

export function extractAvailability(html: string): AvailabilitySignal | null {
  const scriptRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const signals: AvailabilitySignal[] = [];
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      collectSignals(JSON.parse(match[1]), signals);
    } catch {
      // Invalid JSON, skip — same tolerance as the other strategies.
    }
  }
  if (signals.length === 0) return null;
  return signals.includes('in_stock') ? 'in_stock' : 'out_of_stock';
}
