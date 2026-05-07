import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  generateOrGetWishlistShareToken,
  rotateWishlistShareToken,
  getOwnerWishlist,
  setTrackerWishlistFlag,
} from '../db/queries.js';
import { logger } from '../logger.js';

/**
 * Owner-side wishlist routes. All mounted under /api/wishlist with the same
 * (apiKeyMiddleware, authMiddleware) chain as the rest of the authenticated
 * API. Privacy invariant: NONE of these endpoints expose claim status. The
 * owner is intentionally surprise-blind. Public claim status lives on
 * /api/public/wishlist/:token. See spec:
 *   docs/superpowers/specs/2026-05-07-wishlist-mode-design.md
 */

const router = Router();

// Hard-coded production origin used to build share_url. Mirrors the same
// constant used by public-products.ts; if/when this becomes configurable
// pull it from config.
const PUBLIC_ORIGIN = 'https://prices.schultzsolutions.tech';

router.post('/share-token', (req: Request, res: Response) => {
  const rotate = req.body?.rotate === true;
  const token = rotate
    ? rotateWishlistShareToken(req.user!.userId)
    : generateOrGetWishlistShareToken(req.user!.userId);
  logger.info(
    { user_id: req.user!.userId, rotated: rotate },
    'wishlist_share_token_generated',
  );
  res.json({ token, share_url: `${PUBLIC_ORIGIN}/wishlist/${token}` });
});

router.get('/me', (req: Request, res: Response) => {
  // The query already excludes claim columns. This response intentionally
  // does NOT join wishlist_claims — the owner stays surprise-blind.
  const items = getOwnerWishlist(req.user!.userId);
  res.json({ items, count: items.length });
});

const patchSchema = z.object({
  is_wishlisted: z.boolean(),
});

router.patch('/items/:tracker_id', (req: Request, res: Response) => {
  const trackerId = Number(req.params.tracker_id);
  if (!Number.isFinite(trackerId)) {
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const ok = setTrackerWishlistFlag(trackerId, req.user!.userId, parsed.data.is_wishlisted);
  if (!ok) {
    // 404 covers both "no such tracker" and "tracker belongs to another
    // user" — same posture as every other ownership-scoped mutation.
    res.status(404).json({ error: 'Tracker not found' });
    return;
  }
  res.status(204).send();
});

export default router;
