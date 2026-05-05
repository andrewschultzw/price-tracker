import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  upsertWebPushSubscription,
  getActiveWebPushSubscriptionsForUser,
  getWebPushSubscriptionById,
  deleteWebPushSubscription,
} from '../db/queries.js';
import { deriveDeviceLabel } from '../lib/device-label.js';
import { logger } from '../logger.js';

const router = Router();

function endpointHost(endpoint: string): string {
  try { return new URL(endpoint).hostname; } catch { return 'unknown'; }
}

const SubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  device_label: z.string().max(120).optional(),
});

// POST /api/web-push/subscribe
router.post('/subscribe', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const parsed = SubscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });
  }
  const ua = (req.get('user-agent') || '').slice(0, 500);
  const label = parsed.data.device_label?.slice(0, 120) || deriveDeviceLabel(ua);
  const id = upsertWebPushSubscription({
    user_id: userId,
    endpoint: parsed.data.endpoint,
    p256dh_key: parsed.data.keys.p256dh,
    auth_key: parsed.data.keys.auth,
    device_label: label,
    user_agent: ua || null,
  });
  const sub = getWebPushSubscriptionById(id);
  logger.info({
    user_id: userId,
    subscription_id: id,
    device_label: label,
    endpoint_host: endpointHost(parsed.data.endpoint),
  }, 'web_push_subscribe');
  res.status(201).json({
    id: sub!.id,
    device_label: sub!.device_label,
    created_at: sub!.created_at,
    last_used_at: sub!.last_used_at,
  });
});

// GET /api/web-push/devices — keys redacted
router.get('/devices', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const subs = getActiveWebPushSubscriptionsForUser(userId);
  res.json(subs.map(s => ({
    id: s.id,
    device_label: s.device_label,
    created_at: s.created_at,
    last_used_at: s.last_used_at,
  })));
});

// DELETE /api/web-push/subscriptions/:id
router.delete('/subscriptions/:id', (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const id = Number(req.params.id);
  const sub = getWebPushSubscriptionById(id);
  if (!sub || sub.user_id !== userId) {
    return res.status(404).json({ error: 'not_found' });
  }
  deleteWebPushSubscription(id);
  logger.info({ user_id: userId, subscription_id: id }, 'web_push_unsubscribe');
  res.status(204).send();
});

export default router;
