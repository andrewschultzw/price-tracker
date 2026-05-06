import { Router, Request, Response } from 'express';
import {
  getProductBySlug,
  getDailyMinHistoryForNormalizedUrl,
  getStatsForNormalizedUrl,
  listAllSlugs,
} from '../db/queries.js';

/**
 * Public, anonymous endpoints for product price history at /p/<slug>. NO
 * auth middleware — these are intentionally exposed to drive-by traffic +
 * SEO. Privacy: aggregated-only data, daily MIN granularity, no per-user
 * fields. See docs/superpowers/specs/2026-05-06-public-product-pages-design.md
 */

const router = Router();

const PUBLIC_BASE_URL = 'https://prices.schultzsolutions.tech';

router.get('/products/:slug', (req: Request, res: Response) => {
  // Express types mark dynamic params as `string | string[]`. URL routing
  // never produces arrays for our :slug segment, but we coerce to string
  // defensively to satisfy the type checker.
  const slug = String(req.params.slug ?? '');
  const product = getProductBySlug(slug);
  if (!product) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const stats = getStatsForNormalizedUrl(product.normalized_url);
  const price_history = getDailyMinHistoryForNormalizedUrl(product.normalized_url);
  // 15-minute cache: aggregations are cheap to recompute; this just smooths
  // burst traffic from search engines and from a dashboard linking back.
  res.set('Cache-Control', 'public, max-age=900, s-maxage=900');
  res.json({
    slug: product.slug,
    display_name: product.display_name,
    normalized_url: product.normalized_url,
    lowest_current_price: stats.lowest_current_price,
    lowest_ever_price: stats.lowest_ever_price,
    sample_count: stats.sample_count,
    first_observed: stats.first_observed,
    price_history,
  });
});

/**
 * Sitemap handler — registered at the app root in index.ts (NOT under
 * /api). Re-exported here so the route module owns the URL-building logic
 * close to the slug helpers.
 */
export function sitemapHandler(_req: Request, res: Response): void {
  const slugs = listAllSlugs();
  const urls = slugs
    .map(s => `  <url><loc>${PUBLIC_BASE_URL}/p/${encodeURIComponent(s.slug)}</loc></url>`)
    .join('\n');
  const body =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls + (urls ? '\n' : '') +
    '</urlset>\n';
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  res.status(200).send(body);
}

export default router;
