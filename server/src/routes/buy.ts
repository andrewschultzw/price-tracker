import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { getTrackerById } from '../db/queries.js';
import {
  getIntentByToken,
  approveIntent,
  resolveIntentPurchased,
  resolveIntentNotCompleted,
} from '../db/purchase-intents.js';
import { buildAmazonCartUrl } from '../lib/buy-arm.js';
import { config } from '../config.js';

export const buyRouter = Router();

/**
 * Resolve the intent by token and verify the logged-in user owns its tracker.
 * Returns null in any failure case — callers always return 404, never revealing
 * whether the token exists.
 */
function ownedIntent(token: string, userId: number) {
  const intent = getIntentByToken(token);
  if (!intent) return null;
  const tracker = getTrackerById(intent.tracker_id, userId);
  if (!tracker) return null;
  return { intent, tracker };
}

// GET /api/buy/:token — order summary for the Buy Confirmation page.
// cartUrl is only populated once the intent is 'approved'.
buyRouter.get('/:token', (req: Request, res: Response) => {
  const found = ownedIntent(String(req.params.token), req.user!.userId);
  if (!found) return res.status(404).json({ error: 'not found' });
  const { intent, tracker } = found;
  res.json({
    intent: {
      status: intent.status,
      asin: intent.asin,
      price_at_arm: intent.price_at_arm,
      threshold_at_arm: intent.threshold_at_arm,
      quantity: intent.quantity,
      expires_at: intent.expires_at,
    },
    tracker: { id: tracker.id, name: tracker.name },
    cartUrl:
      intent.status === 'approved'
        ? buildAmazonCartUrl(intent.asin, intent.quantity, config.amazonAffiliateTag)
        : null,
  });
});

// POST /api/buy/:token/approve — armed -> approved; returns the cart URL so
// the client can redirect the user straight into Amazon's cart.
buyRouter.post('/:token/approve', (req: Request, res: Response) => {
  const found = ownedIntent(String(req.params.token), req.user!.userId);
  if (!found) return res.status(404).json({ error: 'not found' });
  if (!['armed', 'approved'].includes(found.intent.status)) {
    return res.status(409).json({ error: `cannot approve a ${found.intent.status} intent` });
  }
  try {
    const intent = approveIntent(found.intent.id);
    res.json({ cartUrl: buildAmazonCartUrl(intent.asin, intent.quantity, config.amazonAffiliateTag) });
  } catch {
    return res.status(409).json({ error: 'intent state changed; please reload' });
  }
});

const resolveSchema = z.object({ outcome: z.enum(['purchased', 'not_completed']) });

// POST /api/buy/:token/resolve — close the loop after the user completes (or
// abandons) native Amazon checkout.
buyRouter.post('/:token/resolve', (req: Request, res: Response) => {
  const found = ownedIntent(String(req.params.token), req.user!.userId);
  if (!found) return res.status(404).json({ error: 'not found' });
  if (found.intent.status !== 'approved') {
    return res.status(409).json({ error: `cannot resolve a ${found.intent.status} intent` });
  }
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid body' });

  try {
    if (parsed.data.outcome === 'purchased') {
      const { intent, purchase } = resolveIntentPurchased(found.intent.id);
      return res.json({ intent: { status: intent.status }, purchase });
    }
    const intent = resolveIntentNotCompleted(found.intent.id);
    res.json({ intent: { status: intent.status } });
  } catch {
    return res.status(409).json({ error: 'intent state changed; please reload' });
  }
});
