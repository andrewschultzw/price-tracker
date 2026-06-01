/**
 * Amazon product-page handoff for the buy-on-trigger feature. We hand the
 * owner to the product page (with our Associates tag); they add to cart /
 * Buy Now in their own logged-in session. v1 deliberately does NOT use the
 * legacy /gp/aws/cart/add.html add-to-cart URL — validated 2026-06-01 to
 * redirect to an Associates sign-in wall rather than pre-loading a cart.
 */
export function buildAmazonBuyUrl(asin: string, affiliateTag: string): string {
  const base = `https://www.amazon.com/dp/${asin}`;
  const tag = affiliateTag.trim();
  return tag === '' ? base : `${base}?tag=${tag}`;
}
