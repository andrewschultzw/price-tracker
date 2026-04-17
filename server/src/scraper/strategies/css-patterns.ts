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
 * Amazon.com's marketplace retail seller ID. This is a stable,
 * well-known identifier for Amazon-direct offers (as opposed to
 * third-party sellers in the Marketplace). It appears in hidden form
 * inputs alongside each buying option so we can identify which offer
 * is shipped-and-sold-by-Amazon.
 *
 * Reference: https://www.amazon.com/sp?seller=ATVPDKIKX0DER
 */
const AMAZON_RETAIL_SELLER_ID = 'ATVPDKIKX0DER';

/**
 * Extract the Amazon-direct price from a multi-seller buy box.
 *
 * Amazon product pages with multiple buying options render each option
 * as its own hidden form, each containing:
 *   1. <input name="items[0.base][customerVisiblePrice][displayString]" value="$XX.YY">
 *   2. <input id="merchantID" name="merchantID" value="<seller-id>">
 *
 * The merchantID tells us which seller is behind that specific offer.
 * By pairing every customerVisiblePrice with its nearest following
 * merchantID, we can find the form where merchantID == ATVPDKIKX0DER
 * (Amazon-direct) and return its price — even when Amazon's
 * anonymous-session buy box winner is a cheaper third-party seller.
 *
 * This matches the user's mental model: "I want the Amazon-direct
 * price, not whichever third-party seller Amazon decided to surface
 * today." If no Amazon-direct offer exists on the page, returns null
 * and the caller falls back to other extraction strategies.
 *
 * Discovered 2026-04-09 diagnosing tracker #20 (Husq Chainsaw Case)
 * where Amazon's anonymous buy box winner was Aardvark Trading at
 * $53.99 but Amazon.com's own offer was $72.00 — matching what the
 * user saw in their logged-in browser.
 */
function extractAmazonDirectPrice(html: string): number | null {
  // Find every customerVisiblePrice hidden input. There's one per
  // buy option in the accordion (3 for the Husq Chainsaw page — two
  // duplicates of the third-party offer and one Amazon-direct offer).
  const priceRe = /items\[\d+\.base\]\[customerVisiblePrice\]\[displayString\]"\s*value="([^"]+)"/g;
  const priceMatches = [...html.matchAll(priceRe)];
  if (priceMatches.length === 0) return null;

  for (const pm of priceMatches) {
    const priceIdx = pm.index ?? 0;
    // Look in the next ~3000 chars for the merchantID input paired with
    // this price. The observed delta on real Amazon markup is ~1250 chars
    // so 3000 gives comfortable margin without risking bleeding into the
    // NEXT form's merchantID.
    const window = html.slice(priceIdx, priceIdx + 3000);
    const merchantMatch = window.match(/<input[^>]*id="merchantID"[^>]*value="([^"]+)"/);
    if (!merchantMatch) continue;
    if (merchantMatch[1] === AMAZON_RETAIL_SELLER_ID) {
      const parsed = parsePrice(pm[1]);
      if (parsed !== null) return parsed;
    }
  }

  return null;
}

/**
 * Direct regex for Amazon's authoritative "price to pay" accessibility
 * label. This is the SINGLE most reliable source of the main buy box
 * price on amazon.com and should be tried before anything else.
 *
 * Why this beats `.a-offscreen`: on a product with multiple sellers in
 * the buy box accordion, Amazon renders multiple copies of
 * `apex-pricetopay-value` — one per buy option. The first `.a-offscreen`
 * span on the page frequently belongs to the cheapest third-party seller
 * in the "Other Sellers" tooltip or the first accordion row, NOT the
 * main price Amazon displays in the browser. The
 * `apex-pricetopay-accessibility-label` id is a singleton that Amazon
 * uses explicitly for its screen-reader "the price you pay" label, and
 * it always points at the authoritative main-line price.
 *
 * Example markup:
 *   <span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> $72.00 </span>
 *
 * Discovered 2026-04-09 while diagnosing tracker #20 (Husq Chainsaw
 * Case) scraping $53.99 from the "Other Sellers" tooltip when the
 * actual buy box price was $72.00.
 */
const AMAZON_PRICETOPAY_ACCESSIBILITY_RE =
  /<span[^>]*id=["']apex-pricetopay-accessibility-label["'][^>]*>([^<]+)<\/span>/i;

/**
 * Fallback regex for Amazon's generic "offscreen" price span. Used when
 * the accessibility label isn't present (older Amazon layouts, search
 * result cards, non-product pages, short-link preview pages). This
 * matches the FIRST `.a-offscreen` span in the provided HTML, which on
 * an Amazon product page SHOULD be the main price. On unavailable or
 * multi-seller accordion pages the first page-wide `.a-offscreen` can
 * be a sponsored-carousel item, so this regex is run against a scoped
 * main-price container when one is detected — see
 * `extractAmazonMainPriceScope` below.
 *
 * Example markup:
 *   <span class="a-offscreen">$53.99</span>
 */
const AMAZON_OFFSCREEN_RE = /<span[^>]*class=["']a-offscreen["'][^>]*>([^<]+)<\/span>/i;

/**
 * Amazon main-price container openers, in priority order. These are
 * all `<div>`s (not leaf spans like `#priceblock_ourprice`, which are
 * the price text itself — handled by the generic selector loop). When
 * any of these divs is present we restrict the `.a-offscreen` fallback
 * to the substring between the opener and its matching `</div>` — so
 * sponsored-carousel `.a-offscreen` spans elsewhere on the page don't
 * leak in when the main buy box is missing (the JetKVM regression
 * where `apex_desktop` rendered empty and we were grabbing $35.99 from
 * a sponsored accessory).
 */
const AMAZON_MAIN_PRICE_OPENERS: RegExp[] = [
  /<div[^>]*id=["']corePriceDisplay_desktop_feature_div["'][^>]*>/i,
  /<div[^>]*id=["']corePrice_feature_div["'][^>]*>/i,
  /<div[^>]*id=["']apex_desktop["'][^>]*>/i,
];

/**
 * Slice a balanced <div>…</div> block starting at the given opening
 * tag match. Counts nested <div> depth so the returned slice ends at
 * the MATCHING </div>, not the first </div> encountered. Returns null
 * on malformed markup (missing close). Used to scope main-price
 * matching to a single container without bleeding into adjacent
 * content — a regex with a fixed window can't do this reliably because
 * price containers vary wildly in size.
 */
export function sliceBalancedDiv(html: string, openerMatch: RegExpMatchArray): string | null {
  if (openerMatch.index === undefined) return null;
  const start = openerMatch.index;
  let depth = 1;
  let i = start + openerMatch[0].length;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose === -1) return null;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      i = nextClose + 6;
      if (depth === 0) return html.slice(start, i);
    }
  }
  return null;
}

/**
 * Return the HTML of the first Amazon main-price container as a
 * balanced <div>…</div> slice, or null if no known container exists.
 * Callers use this to scope `.a-offscreen` matching so sponsored /
 * related-product carousels outside the container can't contaminate
 * the fallback.
 */
function extractAmazonMainPriceScope(html: string): string | null {
  for (const opener of AMAZON_MAIN_PRICE_OPENERS) {
    const match = html.match(opener);
    if (match) {
      const slice = sliceBalancedDiv(html, match);
      if (slice !== null) return slice;
    }
  }
  return null;
}

/**
 * Amazon's `availability_feature_div` is the canonical container for
 * the stock-status message. When the product is unavailable, it
 * contains "Currently unavailable" — return true so the caller can
 * skip extraction and let the pipeline surface a clean "unavailable"
 * error instead of silently scraping a sponsored carousel price.
 *
 * Window is bounded to 5000 chars after the opener to avoid matching
 * "Currently unavailable" text that appears elsewhere on the page
 * (used listings, third-party-only offers, etc.).
 */
export function isAmazonCurrentlyUnavailable(html: string): boolean {
  const match = html.match(/<div[^>]*id=["']availability_feature_div["'][^>]*>/i);
  if (!match || match.index === undefined) return false;
  const scope = html.slice(match.index, match.index + 5000);
  return /Currently unavailable/i.test(scope);
}

/**
 * Newegg's `<div class="product-price">` wraps the main buy box. The
 * rest of the page has many other `.price-current` elements in
 * recommended-product and sponsored-item carousels — scoping to this
 * container prevents the 10TB-HDD regression where random carousel
 * prices ($10, $249, $389) were reported as the product price.
 */
function extractNeweggMainPriceScope(html: string): string | null {
  const match = html.match(/<div[^>]*class=["'][^"']*\bproduct-price\b[^"']*["'][^>]*>/i);
  if (!match) return null;
  return sliceBalancedDiv(html, match);
}

export function extractFromCssPatterns(html: string): number | null {
  // Amazon: prefer the Amazon-direct offer when multiple sellers compete
  // for the buy box. Matches the user's mental model that "the price on
  // Amazon" means Amazon's own price, not whichever third-party seller
  // happened to win the anonymous-session buy box algorithm.
  const amazonDirect = extractAmazonDirectPrice(html);
  if (amazonDirect !== null) return amazonDirect;

  // Amazon: next, try the authoritative "price to pay" accessibility
  // label. This is Amazon's singleton screen-reader marker for the
  // current buy box winner — used when there's no Amazon-direct offer
  // on the page (e.g., the product is only sold by third parties).
  const priceToPayMatch = html.match(AMAZON_PRICETOPAY_ACCESSIBILITY_RE);
  if (priceToPayMatch) {
    const parsed = parsePrice(priceToPayMatch[1]);
    if (parsed !== null) return parsed;
  }

  // Amazon fallback: the generic offscreen span. When a known
  // main-price container is on the page, restrict matching to it —
  // otherwise we'd grab a sponsored-carousel `.a-offscreen` on
  // unavailable-product pages (the JetKVM regression). When no known
  // container is on the page we fall back to the page-wide first
  // match, which is the correct main price on older layouts and
  // non-product pages.
  const amazonScope = extractAmazonMainPriceScope(html);
  const amazonHaystack = amazonScope ?? html;
  const amazonMatch = amazonHaystack.match(AMAZON_OFFSCREEN_RE);
  if (amazonMatch) {
    const parsed = parsePrice(amazonMatch[1]);
    if (parsed !== null) return parsed;
  } else if (amazonScope !== null) {
    // A main-price container exists but has no `.a-offscreen` inside.
    // That's the signal the product has no buy box price (unavailable,
    // deprecated listing, etc). Do NOT fall through to the generic
    // selectors below — they'd pick up a sponsored-carousel price
    // elsewhere on the page. Let the pipeline try the next strategy.
    return null;
  }

  // Look for data-price attributes next (usually the cleanest non-Amazon source)
  const dataPriceRegex = /data-price=["']([^"']+)["']/gi;
  const match = dataPriceRegex.exec(html);
  if (match) {
    const parsed = parseFloat(match[1]);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // Newegg: when the main product-price container is present, scope
  // generic selector matching to it. Newegg pages render many other
  // `.price-current` carousels (recommended items, sponsored displays)
  // that would otherwise poison the page-wide match.
  const neweggScope = extractNeweggMainPriceScope(html);
  const selectorHaystack = neweggScope ?? html;
  for (const selector of COMMON_SELECTORS) {
    const price = matchSelectorInHtml(selectorHaystack, selector);
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
