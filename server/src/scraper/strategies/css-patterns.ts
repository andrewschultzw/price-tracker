import { parsePrice } from '../extractor.js';

// Common CSS selectors used by major retailers
const COMMON_SELECTORS = [
  // Generic price selectors
  '[data-price]',
  '.price .current',
  '.price-current',
  '.product-price',
  '.sale-price',
  '.offer-price',
  // Amazon
  '.a-price .a-offscreen',
  '#priceblock_ourprice',
  '#priceblock_dealprice',
  '.a-price-whole',
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

export function extractFromCssPatterns(html: string): number | null {
  // Look for data-price attributes first (most reliable)
  const dataPriceRegex = /data-price=["']([^"']+)["']/gi;
  let match = dataPriceRegex.exec(html);
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
  // Extract class or id from simple selectors
  let pattern: RegExp | null = null;

  if (selector.startsWith('.')) {
    const className = selector.slice(1).replace(/\./g, '[^"]*');
    pattern = new RegExp(`class=["'][^"']*${escapeRegex(className)}[^"']*["'][^>]*>([^<]{1,50})`, 'gi');
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
