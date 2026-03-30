import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getAllUsers, getSafeUserById, updateUser, deleteUser,
  getActiveAdminCount, resetUserPassword,
  createInviteCode, getAllInviteCodes, deleteInviteCode,
  deleteAllRefreshTokensForUser,
} from '../db/user-queries.js';
import { hashPassword } from '../auth/passwords.js';

const router = Router();

// GET /api/admin/users
router.get('/users', (_req: Request, res: Response) => {
  res.json(getAllUsers());
});

// PATCH /api/admin/users/:id
const updateUserSchema = z.object({
  role: z.enum(['admin', 'user']).optional(),
  is_active: z.number().min(0).max(1).optional(),
});

router.patch('/users/:id', (req: Request, res: Response) => {
  const userId = Number(req.params.id);
  const parsed = updateUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const existing = getSafeUserById(userId);
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (existing.role === 'admin' && existing.is_active === 1) {
    const wouldLoseAdmin =
      (parsed.data.role && parsed.data.role !== 'admin') ||
      (parsed.data.is_active === 0);

    if (wouldLoseAdmin && getActiveAdminCount() <= 1) {
      res.status(400).json({ error: 'Cannot remove the last active admin' });
      return;
    }
  }

  const updated = updateUser(userId, parsed.data);

  if (parsed.data.is_active === 0) {
    deleteAllRefreshTokensForUser(userId);
  }

  res.json(updated);
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req: Request, res: Response) => {
  const userId = Number(req.params.id);

  if (userId === req.user!.userId) {
    res.status(400).json({ error: 'Cannot delete your own account' });
    return;
  }

  const existing = getSafeUserById(userId);
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  if (existing.role === 'admin' && existing.is_active === 1 && getActiveAdminCount() <= 1) {
    res.status(400).json({ error: 'Cannot delete the last active admin' });
    return;
  }

  deleteUser(userId);
  res.status(204).send();
});

// POST /api/admin/users/:id/reset-password
const resetPasswordSchema = z.object({
  new_password: z.string().min(8),
});

router.post('/users/:id/reset-password', async (req: Request, res: Response) => {
  const userId = Number(req.params.id);
  const parsed = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const existing = getSafeUserById(userId);
  if (!existing) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.new_password);
  resetUserPassword(userId, passwordHash);
  deleteAllRefreshTokensForUser(userId);

  res.json({ success: true });
});

// POST /api/admin/invites
const createInviteSchema = z.object({
  expires_at: z.string().optional(),
});

router.post('/invites', (req: Request, res: Response) => {
  const parsed = createInviteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const invite = createInviteCode(req.user!.userId, parsed.data.expires_at);
  res.status(201).json(invite);
});

// GET /api/admin/invites
router.get('/invites', (_req: Request, res: Response) => {
  res.json(getAllInviteCodes());
});

// DELETE /api/admin/invites/:id
router.delete('/invites/:id', (req: Request, res: Response) => {
  const deleted = deleteInviteCode(Number(req.params.id));
  if (!deleted) {
    res.status(404).json({ error: 'Invite not found or already used' });
    return;
  }
  res.status(204).send();
});

export default router;
