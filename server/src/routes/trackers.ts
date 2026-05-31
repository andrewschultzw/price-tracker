import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getAllTrackers, getTrackerById, createTracker, updateTracker, deleteTracker,
  getRecentPricesForAllTrackers, getTrackerStats,
  getTrackerUrlsForTracker, addTrackerUrl, deleteTrackerUrl, refreshTrackerAggregates,
  updateTrackerUrlCondition,
  getOverlapForTracker, getOverlapCountsForUser,
  getSlugByNormalizedUrl,
  searchTrackersByName,
} from '../db/queries.js';
import { checkTracker, checkTrackerUrl } from '../scheduler/cron.js';
import { cancelOpenIntentsForTracker } from '../db/purchase-intents.js';
import { extractPrice } from '../scraper/extractor.js';
import {
  affiliateTracker,
  affiliateTrackers,
  affiliateUrlOnObjects,
} from '../lib/serialize-affiliate.js';

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url(),
  threshold_price: z.number().positive().nullable().optional(),
  check_interval_minutes: z.number().int().min(5).optional(),
  css_selector: z.string().nullable().optional(),
});

const updateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    url: z.string().url().optional(),
    threshold_price: z.number().positive().nullable().optional(),
    check_interval_minutes: z.number().int().min(5).optional(),
    css_selector: z.string().nullable().optional(),
    status: z.enum(['active', 'paused']).optional(),
    // Doorbuster fields (migration v14). All three are atomic — see refine
    // below. ISO strings (datetime-local from the UI is .toISOString()).
    doorbuster_start_at: z.string().nullable().optional(),
    doorbuster_end_at: z.string().nullable().optional(),
    doorbuster_interval_minutes: z.number().int().min(1).nullable().optional(),
    // Wishlist toggle (migration v16). Convenience path — the dedicated
    // PATCH /api/wishlist/items/:id is the primary flow but PUT here keeps
    // bulk-updates working uniformly.
    is_wishlisted: z.boolean().optional(),
    // Autonomous purchasing (migration v19). buy_armed arms/disarms the
    // buy-on-trigger flow; buy_quantity sets the Amazon cart quantity (min 1).
    buy_armed: z.boolean().optional(),
    buy_quantity: z.number().int().min(1).optional(),
  })
  .refine(
    data => {
      // The three doorbuster fields are atomic: either all three set
      // (turning the feature on) or all three null/absent (turning it off
      // or leaving it off). Mixed states are rejected so the UI can never
      // half-configure the window.
      const fields = [
        data.doorbuster_start_at,
        data.doorbuster_end_at,
        data.doorbuster_interval_minutes,
      ];
      const setCount = fields.filter(f => f !== undefined && f !== null).length;
      return setCount === 0 || setCount === 3;
    },
    {
      message:
        'doorbuster_start_at, doorbuster_end_at, and doorbuster_interval_minutes must all be set together',
    },
  );

router.get('/', (req: Request, res: Response) => {
  const trackers = getAllTrackers(req.user!.userId);
  res.json(affiliateTrackers(trackers));
});

router.get('/sparklines', (req: Request, res: Response) => {
  const data = getRecentPricesForAllTrackers(req.user!.userId, 10);
  res.json(data);
});

router.get('/stats', (req: Request, res: Response) => {
  const data = getTrackerStats(req.user!.userId, 10);
  res.json(data);
});

router.get('/overlap-counts', (req: Request, res: Response) => {
  const counts = getOverlapCountsForUser(req.user!.userId);
  res.json(counts);
});

// Fuzzy tracker search by name. Used by the NL-query OpenClaw skill to
// resolve a free-text reference ("the LG monitor") to a tracker_id.
// Declared BEFORE /:id so Express's pattern matcher doesn't capture
// "search" as the :id param.
router.get('/search', (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) {
    res.status(400).json({ error: 'Query parameter q is required' });
    return;
  }
  const limit = req.query.limit ? Math.min(Number(req.query.limit) || 5, 20) : 5;
  const results = searchTrackersByName(req.user!.userId, q, limit);
  res.json({ query: q, results });
});

router.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const tracker = createTracker({ ...parsed.data, user_id: req.user!.userId });
  res.status(201).json(affiliateTracker(tracker));
});

router.get('/:id', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.json(affiliateTracker(tracker));
});

router.get('/:id/public-slug', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker || !tracker.normalized_url) {
    res.status(404).json({ error: 'No public page' });
    return;
  }
  const slug = getSlugByNormalizedUrl(tracker.normalized_url);
  if (!slug) {
    res.status(404).json({ error: 'No public page' });
    return;
  }
  res.json({ slug });
});

router.put('/:id', (req: Request, res: Response) => {
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  // is_wishlisted and buy_armed come in as booleans from the client but are
  // stored as 0/1 in SQLite; coerce at the boundary so the rest of the data
  // shape passes through to updateTracker unchanged.
  // buy_quantity is a plain number (min 1 enforced by zod) — no coercion needed.
  const { is_wishlisted, buy_armed, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest };
  if (is_wishlisted !== undefined) data.is_wishlisted = is_wishlisted ? 1 : 0;
  if (buy_armed !== undefined) data.buy_armed = buy_armed ? 1 : 0;
  const tracker = updateTracker(Number(req.params.id), data, req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  // On explicit disarm, cancel any open (armed/approved) intent so the /buy
  // link stops working immediately — don't wait for the 24-h expiry sweep.
  if (parsed.data.buy_armed === false) {
    cancelOpenIntentsForTracker(Number(req.params.id));
  }
  res.json(affiliateTracker(tracker));
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
    res.json(updated ? affiliateTracker(updated) : updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

router.get('/:id/overlap', (req: Request, res: Response) => {
  const overlap = getOverlapForTracker(Number(req.params.id), req.user!.userId);
  if (overlap === null) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.json(overlap);
});

// --- Seller URLs (tracker_urls) ---

const CONDITION_VALUES = ['new', 'warehouse', 'refurb', 'open_box'] as const;

const addUrlSchema = z.object({
  url: z.string().url(),
  condition: z.enum(CONDITION_VALUES).default('new'),
});

const updateUrlConditionSchema = z.object({
  condition: z.enum(CONDITION_VALUES),
});

// List sellers for a tracker
router.get('/:id/urls', (req: Request, res: Response) => {
  const tracker = getTrackerById(Number(req.params.id), req.user!.userId);
  if (!tracker) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.json(affiliateUrlOnObjects(getTrackerUrlsForTracker(tracker.id)));
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
  const newSeller = addTrackerUrl(tracker.id, parsed.data.url, parsed.data.condition);

  // Scrape immediately so the user sees a price right away instead of
  // waiting for the next cron tick. bypassCooldown=true because this is
  // a manual action and suppressing a below-threshold alert for a seller
  // the user just added would be surprising.
  try {
    await checkTrackerUrl(newSeller.id, true);
  } catch (err) {
    // Don't fail the request — the seller is created, just unpopulated.
    // The scheduler will pick it up.
    void err;
  }

  const updated = getTrackerUrlsForTracker(tracker.id);
  res.status(201).json(affiliateUrlOnObjects(updated));
});

// Update a seller URL's condition (new/warehouse/refurb/open_box)
router.patch('/:id/urls/:urlId', (req: Request, res: Response) => {
  const parsed = updateUrlConditionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const ok = updateTrackerUrlCondition(
    Number(req.params.urlId),
    Number(req.params.id),
    req.user!.userId,
    parsed.data.condition,
  );
  if (!ok) {
    // Either the tracker doesn't belong to this user, or the URL doesn't
    // belong to that tracker. Return 404 either way — same pattern as
    // the existing tracker URL CRUD: never leak existence of cross-user
    // resources.
    res.status(404).json({ error: 'Tracker URL not found' });
    return;
  }
  res.status(204).send();
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
  res.json(affiliateUrlOnObjects(getTrackerUrlsForTracker(tracker.id)));
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
