/**
 * Amazon add-to-cart handoff for the buy-on-trigger feature. We never
 * automate checkout or store payment in v1 — we just hand the owner into
 * Amazon's own cart with the item pre-loaded. The AssociateTag rides along
 * so armed buys route through Associates (same tag as lib/affiliate.ts).
 *
 * NB: the /gp/aws/cart/add.html endpoint is long-standing but partially
 * deprecated by Amazon. Validate against a live ASIN during rollout; if it
 * no longer pre-loads the cart, fall back to a /dp/<ASIN> deep-link here.
 */
export function buildAmazonCartUrl(asin: string, quantity: number, affiliateTag: string): string {
  const qty = Math.max(1, Math.floor(quantity) || 1);
  const parts = [`ASIN.1=${asin}`, `Quantity.1=${qty}`];
  if (affiliateTag.trim() !== '') parts.push(`AssociateTag=${affiliateTag.trim()}`);
  return `https://www.amazon.com/gp/aws/cart/add.html?${parts.join('&')}`;
}
