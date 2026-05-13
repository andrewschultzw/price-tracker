/**
 * Lightweight "does this text look like a price?" predicate used by
 * the element picker to flag whether a clicked element is plausibly
 * the product price. Conservative on purpose: a false negative is
 * fine (the user can still pick a non-price-shaped element if they
 * know what they're doing), but a false positive would mislead them
 * into thinking they picked a price element when they actually
 * picked a product title containing "$".
 *
 * Matched shapes:
 *   $129    €129     £129     ¥129     129
 *   $129.99 €129,99  £129.99  ¥129     129.99
 *   $129.99 USD  ...
 *
 * Trailing whitespace and currency-code suffixes are tolerated.
 * Anything with letters in the body (other than the trailing
 * USD/EUR/GBP) fails — that's the line between "price" and
 * "product title with a number in it."
 */

export const PRICE_TEXT_RE =
  /^[$€£¥]?\s*\d{1,4}(?:[.,]\d{2})?\s*(?:USD|EUR|GBP)?$/;

/**
 * Try to find a price-shaped string at or one level below `el`.
 * Returns the trimmed matching text, or null when nothing matches.
 *
 * Two-level search rationale: Amazon's on-screen price element is
 * commonly two adjacent <span>s ("$" + "129.99") with an
 * <span class="a-offscreen">$129.99</span> sibling for screen
 * readers — that sibling is exactly what we want. So if the parent
 * doesn't itself match the price shape, we scan its immediate
 * children for the first one that does.
 */
export function extractPriceText(el: Element): string | null {
  const text = (el.textContent ?? '').trim();
  if (PRICE_TEXT_RE.test(text)) return text;
  for (const child of el.children) {
    const t = (child.textContent ?? '').trim();
    if (PRICE_TEXT_RE.test(t)) return t;
  }
  return null;
}
