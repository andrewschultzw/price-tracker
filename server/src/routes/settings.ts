import { Router, Request, Response } from 'express';
import { getAllSettings, setSetting } from '../db/queries.js';
import { testDiscordWebhook } from '../notifications/discord.js';
import { testNtfyWebhook } from '../notifications/ntfy.js';
import { testGenericWebhook } from '../notifications/webhook.js';
import { testEmail } from '../notifications/email.js';

const router = Router();

const ALLOWED_SETTING_KEYS = new Set([
  'discord_webhook_url',
  'ntfy_url',
  'ntfy_token',
  'generic_webhook_url',
  'email_recipient',
  'share_display_name',
  'share_in_deal_feed',
  'discord_cooldown_hours',
  'ntfy_cooldown_hours',
  'webhook_cooldown_hours',
  'email_cooldown_hours',
  'discord_min_confidence',
  'ntfy_min_confidence',
  'webhook_min_confidence',
  'email_min_confidence',
  'web_push_min_confidence',
  // Weekly digest (phase 3)
  'digest_enabled',
  'digest_channel',
  'digest_day',
  'digest_hour',
  'digest_always',
]);

// Basic email shape check. Not RFC 5322 strict — SMTP will reject
// genuinely invalid addresses. We just want to catch obvious typos
// client-side and stop empty-looking strings from hitting SMTP.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

router.get('/', (req: Request, res: Response) => {
  const settings = getAllSettings(req.user!.userId);
  res.json(settings);
});

router.put('/', (req: Request, res: Response) => {
  const body = req.body as Record<string, string>;
  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTING_KEYS.has(key)) continue;
    if (typeof value !== 'string') continue;
    // Reject an obviously-malformed recipient rather than encrypting
    // garbage. Empty string is allowed — it's how the user clears the
    // setting.
    if (key === 'email_recipient' && value !== '' && !EMAIL_RE.test(value)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }
    // Cooldown values must be a non-negative integer string. Empty
    // string clears the override and falls back to the global default.
    if (key.endsWith('_cooldown_hours') && value !== '') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        res.status(400).json({ error: `Invalid cooldown for ${key} — must be a non-negative integer` });
        return;
      }
    }
    // Digest settings: bounded enums/ints; empty string clears (falls back
    // to defaults: enabled, Sunday 8am, first-configured channel).
    if (key === 'digest_enabled' || key === 'digest_always') {
      if (value !== '' && value !== 'true' && value !== 'false') {
        res.status(400).json({ error: `${key} must be 'true' or 'false'` });
        return;
      }
    }
    if (key === 'digest_channel' && value !== '' && !['ntfy', 'discord', 'email', 'webhook'].includes(value)) {
      res.status(400).json({ error: 'digest_channel must be ntfy, discord, email, or webhook' });
      return;
    }
    if ((key === 'digest_day' || key === 'digest_hour') && value !== '') {
      const n = Number(value);
      const max = key === 'digest_day' ? 6 : 23;
      if (!Number.isInteger(n) || n < 0 || n > max) {
        res.status(400).json({ error: `${key} must be an integer 0-${max}` });
        return;
      }
    }
    // Min confidence values must be 'LOW', 'MEDIUM', or 'HIGH'.
    // Empty string clears the override and falls back to 'LOW' (default).
    if (key.endsWith('_min_confidence') && value !== '') {
      if (!['LOW', 'MEDIUM', 'HIGH'].includes(value)) {
        res.status(400).json({ error: `Invalid confidence level for ${key} — must be 'LOW', 'MEDIUM', or 'HIGH'` });
        return;
      }
    }
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
  const { url, token } = req.body;
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'ntfy URL is required' });
    return;
  }
  const tokenArg = typeof token === 'string' && token.length > 0 ? token : undefined;
  const result = await testNtfyWebhook(url, tokenArg);
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

router.post('/test-email', async (req: Request, res: Response) => {
  const { recipient } = req.body;
  if (!recipient || typeof recipient !== 'string') {
    res.status(400).json({ error: 'Recipient email is required' });
    return;
  }
  if (!EMAIL_RE.test(recipient)) {
    res.status(400).json({ error: 'Invalid email address' });
    return;
  }
  const result = await testEmail(recipient);
  res.json({ success: result.ok, error: result.error });
});

export default router;
