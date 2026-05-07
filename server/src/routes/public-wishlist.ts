import { Router, Request, Response } from 'express';
import {
  getPublicWishlistByToken,
  getUserByWishlistToken,
  isTrackerInUsersWishlist,
  createWishlistClaim,
  deleteWishlistClaim,
} from '../db/queries.js';
import { logger } from '../logger.js';

/**
 * Anonymous, token-gated wishlist routes for gift-givers. NO auth — these
 * endpoints are intentionally exposed to anyone with the share token. See
 * spec: docs/superpowers/specs/2026-05-07-wishlist-mode-design.md.
 *
 * Privacy invariants:
 *   - threshold_price is NEVER returned (private to the owner).
 *   - 404 on token mismatch / wrong claim token — no existence leaks.
 *   - claim status IS returned so multiple gift-givers don't double-buy.
 */

const router = Router();

router.get('/:token', (req: Request, res: Response) => {
  // Express params are typed as `string | string[]`; coerce defensively to
  // satisfy the type checker (URL routing never produces arrays here).
  const token = String(req.params.token ?? '');
  const data = getPublicWishlistByToken(token);
  if (!data) {
    res.status(404).json({ error: 'Wishlist not found' });
    return;
  }
  // 60-second cache balances staleness against load — claim status changes
  // mid-session need to surface to other tabs reasonably quickly.
  res.set('Cache-Control', 'public, max-age=60');
  res.json({
    display_name: data.share_display_name_on ? data.display_name : null,
    items: data.items,
  });
});

router.post('/:token/claim/:tracker_id', (req: Request, res: Response) => {
  const token = String(req.params.token ?? '');
  const owner = getUserByWishlistToken(token);
  if (!owner) {
    res.status(404).json({ error: 'Wishlist not found' });
    return;
  }
  const trackerId = Number(req.params.tracker_id);
  if (!Number.isFinite(trackerId)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  // Verify the tracker actually belongs to this owner's wishlist before
  // creating a claim row — prevents claiming someone else's non-wishlisted
  // tracker by guessing IDs.
  if (!isTrackerInUsersWishlist(trackerId, owner.id)) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }
  const result = createWishlistClaim(trackerId);
  if ('error' in result) {
    res.status(409).json({ error: result.error });
    return;
  }
  logger.info(
    { owner_id: owner.id, tracker_id: trackerId },
    'wishlist_item_claimed',
  );
  res.status(201).json({ claim_token: result.claim_token });
});

router.delete('/:token/claim/:tracker_id', (req: Request, res: Response) => {
  // claim_token may arrive in the body (preferred) or in an X-Claim-Token
  // header for clients that prefer body-less DELETE.
  const claimToken =
    (req.body?.claim_token as string | undefined) ||
    (req.header('x-claim-token') as string | undefined);
  if (!claimToken) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }
  const token = String(req.params.token ?? '');
  const owner = getUserByWishlistToken(token);
  if (!owner) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }
  const trackerId = Number(req.params.tracker_id);
  if (!Number.isFinite(trackerId)) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }
  const ok = deleteWishlistClaim(trackerId, claimToken);
  if (!ok) {
    res.status(404).json({ error: 'Claim not found' });
    return;
  }
  logger.info(
    { owner_id: owner.id, tracker_id: trackerId },
    'wishlist_claim_released',
  );
  res.status(204).send();
});

export default router;
