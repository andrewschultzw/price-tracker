import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createInviteCode,
  countActiveInvitesByUser,
  getInviteCodesByUser,
  deleteInviteCode,
  getInviteCodeById,
} from '../db/user-queries.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const router = Router();

interface QuotaState {
  used: number;
  remaining: number | null; // null = unlimited (admin)
  default: number;
}

/**
 * Compute quota state for a user. Admins are always unlimited
 * (`remaining: null`); the spec keeps `default` populated so the UI can
 * still render the configured cap if it ever cares to.
 */
function getQuotaState(userId: number, isAdmin: boolean): QuotaState {
  if (isAdmin) {
    return { used: 0, remaining: null, default: config.defaultInviteQuota };
  }
  const used = countActiveInvitesByUser(userId);
  const remaining = Math.max(0, config.defaultInviteQuota - used);
  return { used, remaining, default: config.defaultInviteQuota };
}

const createSchema = z.object({
  expires_at: z.string().optional(),
});

// GET /api/invites/quota
router.get('/quota', (req: Request, res: Response) => {
  const isAdmin = req.user!.role === 'admin';
  res.json(getQuotaState(req.user!.userId, isAdmin));
});

// POST /api/invites
router.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const isAdmin = req.user!.role === 'admin';
  if (!isAdmin) {
    const used = countActiveInvitesByUser(req.user!.userId);
    if (used >= config.defaultInviteQuota) {
      res.status(429).json({
        error: 'Invite quota reached',
        used,
        limit: config.defaultInviteQuota,
      });
      return;
    }
  }
  const invite = createInviteCode(req.user!.userId, parsed.data.expires_at);
  logger.info(
    { user_id: req.user!.userId, invite_id: invite.id },
    'invite_created',
  );
  res.status(201).json(invite);
});

// GET /api/invites
router.get('/', (req: Request, res: Response) => {
  res.json(getInviteCodesByUser(req.user!.userId));
});

// DELETE /api/invites/:id
router.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  // Ownership check before delete: 404 (not 403) on miss/foreign/used so
  // we don't leak whether an id exists for some other user.
  const existing = getInviteCodeById(id);
  if (
    !existing ||
    existing.created_by !== req.user!.userId ||
    existing.used_by !== null
  ) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  const deleted = deleteInviteCode(id);
  if (!deleted) {
    res.status(404).json({ error: 'Invite not found' });
    return;
  }
  logger.info(
    { user_id: req.user!.userId, invite_id: id },
    'invite_deleted',
  );
  res.status(204).send();
});

export default router;
