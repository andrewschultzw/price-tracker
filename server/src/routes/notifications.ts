import { Router, Request, Response } from 'express';
import { getNotificationHistory, getUnreadNotificationCount, markNotificationsRead } from '../db/queries.js';

const router = Router();

// Cheap badge endpoint — a bare count, not history rows.
router.get('/unread-count', (req: Request, res: Response) => {
  res.json({ count: getUnreadNotificationCount(req.user!.userId) });
});

// Bulk mark-read, fired when the notifications page loads.
router.post('/mark-read', (req: Request, res: Response) => {
  res.json({ marked: markNotificationsRead(req.user!.userId) });
});

router.get('/', (req: Request, res: Response) => {
  const trackerId = req.query.tracker_id ? Number(req.query.tracker_id) : undefined;
  const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;
  if (trackerId !== undefined && Number.isNaN(trackerId)) {
    res.status(400).json({ error: 'Invalid tracker_id' });
    return;
  }
  const rows = getNotificationHistory(req.user!.userId, trackerId, limit);
  res.json(rows);
});

export default router;
