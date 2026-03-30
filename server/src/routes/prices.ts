import { Router, Request, Response } from 'express';
import { getPriceHistory, getTrackerById } from '../db/queries.js';

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

export default router;
