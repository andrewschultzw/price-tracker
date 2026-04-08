import { Router, Request, Response } from 'express';
import { getPriceHistory, getPriceHistoryWithSeller, getTrackerById } from '../db/queries.js';
import { toCsv, slugify } from '../util/csv.js';

const router = Router();

router.get('/:id/prices', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  const range = req.query.range as string | undefined;
  const prices = getPriceHistory(tracker.id, range);
  res.json(prices);
});

router.get('/:id/export', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }

  const format = (req.query.format as string) || 'csv';
  if (format !== 'csv' && format !== 'json') {
    res.status(400).json({ error: 'format must be csv or json' });
    return;
  }

  // Full history, no range filter — the point of export is a complete
  // dataset for analysis / migration, not a dashboard view. The WithSeller
  // variant joins tracker_urls so each row carries which retailer it came
  // from (historical pre-migration rows may have null seller_url).
  const prices = getPriceHistoryWithSeller(tracker.id);
  const slug = slugify(tracker.name);

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="price-history-${tracker.id}-${slug}.json"`,
    );
    res.json({
      tracker: {
        id: tracker.id,
        name: tracker.name,
        url: tracker.url,
        threshold_price: tracker.threshold_price,
      },
      exported_at: new Date().toISOString(),
      prices,
    });
    return;
  }

  const csv = toCsv(
    ['scraped_at', 'seller_url', 'price', 'currency'],
    prices.map(p => [p.scraped_at, p.seller_url, p.price, p.currency]),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="price-history-${tracker.id}-${slug}.csv"`,
  );
  res.send(csv);
});

export default router;
