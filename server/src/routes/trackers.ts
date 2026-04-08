import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getAllTrackers, getTrackerById, createTracker, updateTracker, deleteTracker,
  getRecentPricesForAllTrackers, getTrackerStats,
  getTrackerUrlsForTracker, addTrackerUrl, deleteTrackerUrl, refreshTrackerAggregates,
} from '../db/queries.js';
import { checkTracker, checkTrackerUrl } from '../scheduler/cron.js';
import { extractPrice } from '../scraper/extractor.js';

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url(),
  threshold_price: z.number().positive().nullable().optional(),
  check_interval_minutes: z.number().int().min(5).optional(),
  css_selector: z.string().nullable().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  url: z.string().url().optional(),
  threshold_price: z.number().positive().nullable().optional(),
  check_interval_minutes: z.number().int().min(5).optional(),
  css_selector: z.string().nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
});

router.get('/', (req: Request, res: Response) => {
  const trackers = getAllTrackers(req.user!.userId);
  res.json(trackers);
});

router.get('/sparklines', (req: Request, res: Response) => {
  const data = getRecentPricesForAllTrackers(req.user!.userId, 10);
  res.json(data);
});

router.get('/stats', (req: Request, res: Response) => {
  const data = getTrackerStats(req.user!.userId, 10);
  res.json(data);
});

router.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const tracker = createTracker({ ...parsed.data, user_id: req.user!.userId });
  res.status(201).json(tracker);
});

router.get('/:id', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.json(tracker);
});

router.put('/:id', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const tracker = updateTracker(Number(req.params.id), parsed.data, req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.json(tracker);
});

router.delete('/:id', (req: Request, res: Response) => {
  const deleted = deleteTracker(Number(req.params.id), req.user!.userId);
  if (!deleted) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.status(204).send();
});

// Trigger immediate check
router.post('/:id/check', async (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  try {
    await checkTracker(tracker.id);
    const updated = getTrackerById(tracker.id, req.user!.userId);
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

// --- Seller URLs (tracker_urls) ---

const addUrlSchema = z.object({
  url: z.string().url(),
});

// List sellers for a tracker
router.get('/:id/urls', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.json(getTrackerUrlsForTracker(tracker.id));
});

// Add a seller URL to a tracker
router.post('/:id/urls', async (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  const parsed = addUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const newSeller = addTrackerUrl(tracker.id, parsed.data.url);

  // Scrape immediately so the user sees a price right away instead of
  // waiting for the next cron tick. Fire-and-forget on failure — the
  // scheduler will retry on its normal cadence.
  try {
    await checkTrackerUrl(newSeller.id);
  } catch (err) {
    // Don't fail the request — the seller is created, just unpopulated.
    // The scheduler will pick it up.
    void err;
  }

  const updated = getTrackerUrlsForTracker(tracker.id);
  res.status(201).json(updated);
});

// Delete a seller URL from a tracker
router.delete('/:id/urls/:urlId', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  const result = deleteTrackerUrl(Number(req.params.urlId));
  if (!result.deleted) {
    res.status(400).json({ error: result.error || 'Could not delete seller' });
    return;
  }
  // Re-aggregate — if we just deleted the seller that had the lowest
  // price, the tracker's displayed price needs to update.
  refreshTrackerAggregates(tracker.id);
  res.json(getTrackerUrlsForTracker(tracker.id));
});

// Test scrape without saving
router.post('/test-scrape', async (req: Request, res: Response) => {
  const { url, css_selector } = req.body;
  if (!url) {
    res.status(400).json({ error: 'URL is required' });
    return;
  }
  try {
    const result = await extractPrice(url, css_selector);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(422).json({ error: msg });
  }
});

export default router;
