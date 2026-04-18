// MIRROR of client/src/lib/domains.ts. Keep these two files in sync when
// adding retailer aliases. A future refactor could hoist to a shared
// package; for now the cost of duplication is a single list update and
// the benefit is zero build/tooling changes.

const ALIASES: Record<string, string> = {
  // Amazon
  'amazon.com': 'amazon.com',
  'a.co': 'amazon.com',
  'amzn.to': 'amazon.com',
  'amzn.com': 'amazon.com',
  'smile.amazon.com': 'amazon.com',
  'amazon.ca': 'amazon.com',
  'amazon.co.uk': 'amazon.com',
  'amazon.de': 'amazon.com',
  'amazon.fr': 'amazon.com',
  'amazon.it': 'amazon.com',
  'amazon.es': 'amazon.com',
  'amazon.co.jp': 'amazon.com',
  'amazon.com.mx': 'amazon.com',
  'amazon.com.au': 'amazon.com',
  // Newegg
  'newegg.com': 'newegg.com',
  'newegg.ca': 'newegg.com',
  'newegg.io': 'newegg.com',
  // Best Buy
  'bestbuy.com': 'bestbuy.com',
  'bestbuy.ca': 'bestbuy.com',
  // Walmart
  'walmart.com': 'walmart.com',
  'walmart.ca': 'walmart.com',
  // Target
  'target.com': 'target.com',
  // eBay
  'ebay.com': 'ebay.com',
  'ebay.co.uk': 'ebay.com',
  'ebay.ca': 'ebay.com',
  'ebay.de': 'ebay.com',
  'ebay.to': 'ebay.com',
  // B&H Photo
  'bhphotovideo.com': 'bhphotovideo.com',
  'bh.com': 'bhphotovideo.com',
  // Costco
  'costco.com': 'costco.com',
  'costco.ca': 'costco.com',
  // Home Depot
  'homedepot.com': 'homedepot.com',
  'homedepot.ca': 'homedepot.com',
  // Lowe's
  'lowes.com': 'lowes.com',
  'lowes.ca': 'lowes.com',
  // Micro Center
  'microcenter.com': 'microcenter.com',
  // Adorama
  'adorama.com': 'adorama.com',
  // AliExpress
  'aliexpress.com': 'aliexpress.com',
  'aliexpress.us': 'aliexpress.com',
  's.click.aliexpress.com': 'aliexpress.com',
  // Etsy
  'etsy.com': 'etsy.com',
  'etsy.me': 'etsy.com',
};

function stripWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

export function canonicalDomain(url: string): string {
  let hostname = '';
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  hostname = stripWww(hostname);
  if (ALIASES[hostname]) return ALIASES[hostname];
  for (const alias of Object.keys(ALIASES)) {
    if (hostname.endsWith('.' + alias)) return ALIASES[alias];
  }
  return hostname;
}
