import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  createUserApiToken, listUserApiTokensForUser, revokeUserApiToken,
} from '../db/queries.js';
import { logger } from '../logger.js';

const router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(100),
});

router.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const created = createUserApiToken(req.user!.userId, parsed.data.name);
  logger.info({
    user_id: req.user!.userId, token_id: created.id, name: created.name,
  }, 'api_token_created');
  res.status(201).json(created);
});

router.get('/', (req: Request, res: Response) => {
  res.json(listUserApiTokensForUser(req.user!.userId));
});

router.delete('/:id', (req: Request, res: Response) => {
  const tokenId = Number(req.params.id);
  if (!Number.isFinite(tokenId)) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  const ok = revokeUserApiToken(tokenId, req.user!.userId);
  if (!ok) {
    res.status(404).json({ error: 'Token not found' });
    return;
  }
  logger.info({ user_id: req.user!.userId, token_id: tokenId }, 'api_token_revoked');
  res.status(204).send();
});

export default router;
