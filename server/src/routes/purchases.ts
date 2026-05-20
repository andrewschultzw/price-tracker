import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createPurchase,
  getTrackerById,
  listPurchases,
  getPurchase,
  updatePurchase,
  deletePurchase,
} from '../db/queries.js';

// Two routers in one file — the tracker-scoped POST lives at
// /api/trackers/:id/purchases and the rest live at /api/purchases/*.
// Both are mounted with authMiddleware in index.ts.

export const trackerPurchasesRouter = Router();
export const purchasesRouter = Router();

const createSchema = z.object({
  purchase_price: z.number().nonnegative().optional(),
  quantity: z.number().int().min(1).optional(),
  purchased_at: z.string().datetime().optional(),
  tracker_url_id: z.number().int().nullable().optional(),
  keep_watching: z.boolean().optional(),
});

// POST /api/trackers/:id/purchases — log a purchase against a tracker.
trackerPurchasesRouter.post('/:id/purchases', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const trackerId = Number(req.params.id);
  if (!Number.isFinite(trackerId)) {
    return res.status(404).json({ error: 'tracker not found' });
  }
  const tracker = getTrackerById(trackerId, userId);
  if (!tracker) {
    return res.status(404).json({ error: 'tracker not found' });
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body', details: parsed.error.format() });
  }

  const purchasePrice = parsed.data.purchase_price ?? tracker.last_price;
  if (purchasePrice == null) {
    return res
      .status(400)
      .json({ error: 'purchase_price required when tracker has no last_price' });
  }

  const purchase = createPurchase(
    trackerId,
    {
      purchase_price: purchasePrice,
      quantity: parsed.data.quantity,
      purchased_at: parsed.data.purchased_at,
      tracker_url_id: parsed.data.tracker_url_id ?? null,
    },
    { keep_watching: parsed.data.keep_watching === true },
  );

  const updatedTracker = getTrackerById(trackerId, userId)!;
  res.status(201).json({ purchase, tracker: updatedTracker });
});

// GET /api/purchases — paged list of the current user's purchases,
// newest-first. limit is clamped to [1, 500]; default 50.
purchasesRouter.get('/', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 500);
  const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);
  res.json(listPurchases({ user_id: userId, limit, offset }));
});
