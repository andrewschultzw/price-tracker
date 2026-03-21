import { Router, Request, Response } from 'express';
import { getAllSettings, setSetting } from '../db/queries.js';
import { testWebhook } from '../notifications/discord.js';

const router = Router();

router.get('/', (_req: Request, res: Response) => {
  const settings = getAllSettings();
  res.json(settings);
});

router.put('/', (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(body)) {
    if (typeof key === 'string' && typeof value === 'string') {
      setSetting(key, value);
    }
  }
  const settings = getAllSettings();
  res.json(settings);
});

router.post('/test-webhook', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Webhook URL is required' });
    return;
  }
  const ok = await testWebhook(url);
  res.json({ success: ok });
});

export default router;
