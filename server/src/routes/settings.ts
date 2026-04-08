import { Router, Request, Response } from 'express';
import { getAllSettings, setSetting } from '../db/queries.js';
import { testDiscordWebhook } from '../notifications/discord.js';
import { testNtfyWebhook } from '../notifications/ntfy.js';
import { testGenericWebhook } from '../notifications/webhook.js';

const router = Router();

const ALLOWED_SETTING_KEYS = new Set(['discord_webhook_url', 'ntfy_url', 'generic_webhook_url']);

router.get('/', (req: Request, res: Response) => {
  const settings = getAllSettings(req.user!.userId);
  res.json(settings);
});

router.put('/', (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) continue;
    if (typeof value !== 'string') continue;
    setSetting(key, value, req.user!.userId);
  }
  const settings = getAllSettings(req.user!.userId);
  res.json(settings);
});

router.post('/test-webhook', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Webhook URL is required' });
    return;
  }
  const result = await testDiscordWebhook(url);
  res.json({ success: result.ok, error: result.error });
});

router.post('/test-ntfy', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'ntfy URL is required' });
    return;
  }
  const result = await testNtfyWebhook(url);
  res.json({ success: result.ok, error: result.error });
});

router.post('/test-generic-webhook', async (req: Request, res: Response) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Webhook URL is required' });
    return;
  }
  const result = await testGenericWebhook(url);
  res.json({ success: result.ok, error: result.error });
});

export default router;
