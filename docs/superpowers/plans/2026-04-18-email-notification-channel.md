# Email Notification Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email as the fourth notification channel, sent over Gmail SMTP from a verified `alerts@schultzsolutions.tech` alias.

**Architecture:** New `server/src/notifications/email.ts` module mirrors the existing Discord/ntfy/webhook shape. nodemailer creates a singleton SMTP transport from app-wide `.env` values. Per-user recipient stored as encrypted setting `email_recipient`. Cron loop gets a fourth branch; Settings UI gets a fourth card.

**Tech Stack:** nodemailer 6.x (new dep), Gmail SMTP via app password, AES-256-GCM via existing `settings-crypto.ts`, React + Vite client.

**Spec:** `docs/superpowers/specs/2026-04-18-email-notification-channel-design.md`

**Branch:** `feature/email-notification-channel` (already checked out; spec commit present).

---

## Task 1: Add SMTP config + install nodemailer

**Files:**
- Modify: `server/package.json` (add `nodemailer`, `@types/nodemailer`)
- Modify: `server/src/config.ts` (add SMTP block)
- Test: none at this step — config is wired up by Task 2's tests

- [ ] **Step 1: Install nodemailer**

```bash
cd /root/price-tracker/server && npm install nodemailer && npm install -D @types/nodemailer
```

Expected: both added to `package.json` dependencies; `package-lock.json` updated.

- [ ] **Step 2: Extend `server/src/config.ts`**

Replace the `config` object literal and the production-guard block so it reads:

```typescript
import { resolve } from 'path';

export const config = {
  port: parseInt(process.env.PORT || '3100', 10),
  databasePath: resolve(process.env.DATABASE_PATH || './data/price-tracker.db'),
  discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  nodeEnv: process.env.NODE_ENV || 'development',
  defaultCheckInterval: 360, // minutes
  notificationCooldownHours: 6,
  maxConsecutiveFailures: 3,
  maxConcurrentScrapes: 2,
  // Scrape retry policy. We retry the page fetch on transient failures
  // (network errors, timeouts, 5xx) but not on deterministic ones (4xx,
  // extraction failures). See server/src/scraper/retry.ts.
  scrapeMaxRetries: parseInt(process.env.SCRAPE_MAX_RETRIES || '2', 10),
  scrapeRetryBaseMs: parseInt(process.env.SCRAPE_RETRY_BASE_MS || '1000', 10),
  // Auth
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-do-not-use-in-prod'),
  jwtAccessExpirySeconds: 900,       // 15 minutes
  jwtRefreshExpiryDays: 30,
  bcryptRounds: 12,
  // Outbound email (Gmail SMTP). All five values required for the email
  // channel to be usable; if any is missing, email sends throw a clear
  // "email channel not configured" error and the Settings UI shows a
  // greyed-out card with an admin hint.
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: parseInt(process.env.SMTP_PORT || '465', 10),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  smtpFrom: process.env.SMTP_FROM || '',
  isProduction: process.env.NODE_ENV === 'production',
};

if (config.isProduction && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required in production');
  process.exit(1);
}

/**
 * True when all SMTP config values needed to send email are present.
 * Used by notification code to throw a clear "not configured" error and
 * by the Settings UI to decide whether to expose the email card.
 */
export function isEmailConfigured(): boolean {
  return !!(config.smtpHost && config.smtpPort && config.smtpUser && config.smtpPass && config.smtpFrom);
}
```

- [ ] **Step 3: TypeCheck**

Run: `cd /root/price-tracker/server && npx tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/package-lock.json server/src/config.ts
git commit -m "feat(server): add SMTP config + nodemailer for email channel

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Email notification module

**Files:**
- Create: `server/src/notifications/email.ts`
- Create: `server/src/notifications/email.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/notifications/email.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock nodemailer BEFORE importing the module under test. The mock
// captures every sendMail call for assertion.
const sentMessages: any[] = [];
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: vi.fn((opts) => {
        sentMessages.push(opts);
        return Promise.resolve({ messageId: 'test-id' });
      }),
    })),
  },
}));

// Swap config to a fully-populated SMTP block for these tests.
vi.mock('../config.js', () => ({
  config: {
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpUser: 'homelab.schultz@gmail.com',
    smtpPass: 'app-pass',
    smtpFrom: 'Price Tracker <alerts@schultzsolutions.tech>',
  },
  isEmailConfigured: () => true,
}));

// Suppress logger output in tests.
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  sendEmailPriceAlert,
  sendEmailErrorAlert,
  testEmail,
  resetEmailTransportForTesting,
} from './email.js';
import type { Tracker } from '../db/queries.js';

function makeTracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 7,
    user_id: 1,
    name: 'WD Red Plus 10TB HDD',
    url: 'https://www.newegg.com/p/N82E16822234588',
    threshold_price: 200,
    check_interval_minutes: 360,
    css_selector: null,
    last_price: 189.99,
    last_checked_at: '2026-04-18 12:00:00',
    last_error: null,
    consecutive_failures: 0,
    status: 'active',
    created_at: '2026-04-01 00:00:00',
    updated_at: '2026-04-18 12:00:00',
    ...overrides,
  } as unknown as Tracker;
}

beforeEach(() => {
  sentMessages.length = 0;
  resetEmailTransportForTesting();
});

describe('sendEmailPriceAlert', () => {
  it('sends multipart HTML + text to the recipient', async () => {
    const ok = await sendEmailPriceAlert(makeTracker(), 189.99, 'me@example.com');
    expect(ok).toBe(true);
    expect(sentMessages).toHaveLength(1);
    const m = sentMessages[0];
    expect(m.to).toBe('me@example.com');
    expect(m.from).toBe('Price Tracker <alerts@schultzsolutions.tech>');
    expect(m.subject).toContain('Price drop');
    expect(m.subject).toContain('WD Red Plus 10TB HDD');
    expect(m.subject).toContain('189.99');
    expect(m.text).toContain('189.99');
    expect(m.text).toContain('Target: $200');
    expect(m.text).toContain('Savings: $10.01');
    expect(m.text).toContain('https://www.newegg.com/p/N82E16822234588');
    expect(m.html).toContain('189.99');
    expect(m.html).toContain('<a');
  });

  it('returns false on missing threshold (nothing to compare)', async () => {
    const ok = await sendEmailPriceAlert(makeTracker({ threshold_price: null as unknown as number }), 10, 'me@example.com');
    expect(ok).toBe(false);
    expect(sentMessages).toHaveLength(0);
  });
});

describe('sendEmailErrorAlert', () => {
  it('sends an error-themed message', async () => {
    const ok = await sendEmailErrorAlert(
      makeTracker({ consecutive_failures: 3 }),
      'Product is currently unavailable on Amazon',
      'me@example.com',
    );
    expect(ok).toBe(true);
    const m = sentMessages[0];
    expect(m.subject).toContain('Tracker error');
    expect(m.subject).toContain('WD Red Plus 10TB HDD');
    expect(m.text).toContain('Product is currently unavailable on Amazon');
    expect(m.text).toContain('3 consecutive');
    expect(m.html).toContain('Product is currently unavailable on Amazon');
  });
});

describe('testEmail', () => {
  it('returns {ok: true} on success', async () => {
    const r = await testEmail('me@example.com');
    expect(r.ok).toBe(true);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].subject).toContain('Test');
  });

  it('returns {ok: false, error} on SMTP failure', async () => {
    // Re-mock createTransport to reject for this one test
    const nodemailer = await import('nodemailer');
    (nodemailer.default.createTransport as any).mockReturnValueOnce({
      sendMail: vi.fn(() => Promise.reject(new Error('EAUTH: bad credentials'))),
    });
    resetEmailTransportForTesting();
    const r = await testEmail('me@example.com');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('EAUTH');
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /root/price-tracker/server && npx vitest run src/notifications/email.test.ts`
Expected: FAIL with `Cannot find module './email.js'` or similar — we haven't created it yet.

- [ ] **Step 3: Create `server/src/notifications/email.ts`**

```typescript
import nodemailer, { Transporter } from 'nodemailer';
import { config, isEmailConfigured } from '../config.js';
import { logger } from '../logger.js';
import type { Tracker } from '../db/queries.js';

/**
 * Email notification channel. Sends multipart HTML+plaintext alerts over
 * the configured Gmail SMTP transport. The SMTP account is app-wide
 * (configured in .env) and each user supplies only their own recipient
 * address via the `email_recipient` setting.
 *
 * Shape mirrors the other three channels exactly — a price alert and an
 * error alert function, both returning Promise<boolean> where false means
 * "did not send" (either misconfigured or SMTP error, logged inside).
 * A testEmail() function matches the ok/error return shape used by the
 * other channels' test helpers.
 */

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (transport) return transport;
  if (!isEmailConfigured()) {
    throw new Error('Email channel is not configured (missing SMTP_* env vars)');
  }
  transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // Gmail's 465 is implicit TLS; 587 is STARTTLS. Pick based on port.
    secure: config.smtpPort === 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
  });
  return transport;
}

/**
 * Test-only helper to drop the cached transport so a re-mocked
 * createTransport takes effect on the next call. Do not call from
 * application code.
 */
export function resetEmailTransportForTesting(): void {
  transport = null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}

function priceAlertText(tracker: Tracker, price: number): string {
  const threshold = tracker.threshold_price!;
  const savings = threshold - price;
  return [
    `${tracker.name} dropped to ${formatMoney(price)}`,
    '',
    `Target: ${formatMoney(threshold)}`,
    `Savings: ${formatMoney(savings)}`,
    `Seller: ${hostOf(tracker.url)}`,
    '',
    `Buy now: ${tracker.url}`,
  ].join('\n');
}

function priceAlertHtml(tracker: Tracker, price: number): string {
  const threshold = tracker.threshold_price!;
  const savings = threshold - price;
  const host = hostOf(tracker.url);
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px 0; font-size: 18px;">${escapeHtml(tracker.name)}</h2>
  <div style="font-size: 28px; font-weight: 700; color: #16a34a; margin: 8px 0 16px 0;">${formatMoney(price)}</div>
  <table style="border-collapse: collapse; margin-bottom: 20px;" cellpadding="4">
    <tr><td style="color: #6b7280;">Target</td><td style="font-weight: 600;">${formatMoney(threshold)}</td></tr>
    <tr><td style="color: #6b7280;">Savings</td><td style="font-weight: 600; color: #16a34a;">${formatMoney(savings)}</td></tr>
    <tr><td style="color: #6b7280;">Seller</td><td>${escapeHtml(host)}</td></tr>
  </table>
  <a href="${escapeAttr(tracker.url)}" style="display: inline-block; background: #2563eb; color: #fff; text-decoration: none; padding: 10px 20px; border-radius: 8px; font-weight: 500;">Buy now</a>
</body></html>`;
}

function errorAlertText(tracker: Tracker, error: string): string {
  return [
    `Tracker error: ${tracker.name}`,
    '',
    `${error}`,
    `${tracker.consecutive_failures} consecutive failures.`,
    '',
    `Tracker URL: ${tracker.url}`,
  ].join('\n');
}

function errorAlertHtml(tracker: Tracker, error: string): string {
  return `<!doctype html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; max-width: 520px; margin: 0 auto; padding: 24px;">
  <h2 style="margin: 0 0 8px 0; font-size: 18px;">Tracker error: ${escapeHtml(tracker.name)}</h2>
  <div style="background: #fef2f2; color: #991b1b; padding: 12px 16px; border-radius: 8px; margin: 12px 0;">${escapeHtml(error)}</div>
  <p style="color: #6b7280;">${tracker.consecutive_failures} consecutive failures.</p>
  <a href="${escapeAttr(tracker.url)}" style="color: #2563eb;">Open tracker URL</a>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

export async function sendEmailPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  recipient: string,
): Promise<boolean> {
  if (!tracker.threshold_price) return false;
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: `Price drop: ${tracker.name} is ${formatMoney(currentPrice)}`,
      text: priceAlertText(tracker, currentPrice),
      html: priceAlertHtml(tracker, currentPrice),
    });
    logger.info({ trackerId: tracker.id, price: currentPrice }, 'Email price alert sent');
    return true;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Email price alert failed');
    return false;
  }
}

export async function sendEmailErrorAlert(
  tracker: Tracker,
  errorMsg: string,
  recipient: string,
): Promise<boolean> {
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: `Tracker error: ${tracker.name}`,
      text: errorAlertText(tracker, errorMsg),
      html: errorAlertHtml(tracker, errorMsg),
    });
    logger.info({ trackerId: tracker.id }, 'Email error alert sent');
    return true;
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Email error alert failed');
    return false;
  }
}

/**
 * Settings page "Send test email" endpoint backing. Returns the same
 * {ok, error} shape the other channels' test helpers use so the UI
 * branch is uniform.
 */
export async function testEmail(recipient: string): Promise<{ ok: boolean; error?: string }> {
  if (!isEmailConfigured()) {
    return { ok: false, error: 'Email channel is not configured on the server' };
  }
  try {
    await getTransport().sendMail({
      from: config.smtpFrom,
      to: recipient,
      subject: 'Price Tracker — test email',
      text: 'This is a test email from Price Tracker. If you got this, your notifications are wired up correctly.',
      html: '<p>This is a test email from Price Tracker. If you got this, your notifications are wired up correctly.</p>',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /root/price-tracker/server && npx vitest run src/notifications/email.test.ts`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/notifications/email.ts server/src/notifications/email.test.ts
git commit -m "feat(server): email notification channel module

Mirrors the Discord/ntfy/webhook shape: price + error alert functions
returning Promise<boolean>, plus a testEmail helper matching the
{ok, error} contract of the other channels' test endpoints. Uses
nodemailer with a cached SMTP transport; resetEmailTransportForTesting
lets tests re-mock createTransport between cases.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Cron fan-out integration

**Files:**
- Modify: `server/src/scheduler/cron.ts` (extend EnabledChannels, firePriceAlerts, fireErrorAlerts)

- [ ] **Step 1: Extend `EnabledChannels` interface**

In `server/src/scheduler/cron.ts`, change the interface block:

```typescript
interface EnabledChannels {
  discord?: string;
  ntfy?: string;
  // Optional Bearer token for self-hosted ntfy instances with
  // deny-all auth. Only meaningful when ntfy is also set.
  ntfyToken?: string;
  webhook?: string;
  email?: string;
}
```

- [ ] **Step 2: Update `getEnabledChannels` to read `email_recipient`**

```typescript
function getEnabledChannels(userId: number | null | undefined): EnabledChannels {
  if (!userId) return {};
  return {
    discord: getSetting('discord_webhook_url', userId) || undefined,
    ntfy: getSetting('ntfy_url', userId) || undefined,
    ntfyToken: getSetting('ntfy_token', userId) || undefined,
    webhook: getSetting('generic_webhook_url', userId) || undefined,
    email: getSetting('email_recipient', userId) || undefined,
  };
}
```

- [ ] **Step 3: Update `hasAnyChannel` to OR in email**

```typescript
function hasAnyChannel(channels: EnabledChannels): boolean {
  return !!(channels.discord || channels.ntfy || channels.webhook || channels.email);
}
```

- [ ] **Step 4: Import email senders and extend fan-out**

Add near the other notification imports:

```typescript
import { sendEmailPriceAlert, sendEmailErrorAlert } from '../notifications/email.js';
```

Extend `firePriceAlerts` so it pushes an email attempt when the channel is configured:

```typescript
async function firePriceAlerts(
  alertTracker: Tracker,
  currentPrice: number,
  channels: EnabledChannels,
): Promise<string[]> {
  const attempts: { name: string; promise: Promise<boolean> }[] = [];
  if (channels.discord) attempts.push({ name: 'discord', promise: sendDiscordPriceAlert(alertTracker, currentPrice, channels.discord) });
  if (channels.ntfy) attempts.push({ name: 'ntfy', promise: sendNtfyPriceAlert(alertTracker, currentPrice, channels.ntfy, channels.ntfyToken) });
  if (channels.webhook) attempts.push({ name: 'webhook', promise: sendGenericPriceAlert(alertTracker, currentPrice, channels.webhook) });
  if (channels.email) attempts.push({ name: 'email', promise: sendEmailPriceAlert(alertTracker, currentPrice, channels.email) });
  const results = await Promise.all(attempts.map(a => a.promise));
  return attempts.filter((_, i) => results[i]).map(a => a.name);
}
```

Extend `fireErrorAlerts` the same way:

```typescript
async function fireErrorAlerts(
  alertTracker: Tracker,
  error: string,
  channels: EnabledChannels,
): Promise<void> {
  const senders: Promise<boolean>[] = [];
  if (channels.discord) senders.push(sendDiscordErrorAlert(alertTracker, error, channels.discord));
  if (channels.ntfy) senders.push(sendNtfyErrorAlert(alertTracker, error, channels.ntfy, channels.ntfyToken));
  if (channels.webhook) senders.push(sendGenericErrorAlert(alertTracker, error, channels.webhook));
  if (channels.email) senders.push(sendEmailErrorAlert(alertTracker, error, channels.email));
  await Promise.all(senders);
}
```

- [ ] **Step 5: TypeCheck + run all server tests**

Run: `cd /root/price-tracker/server && npx tsc --noEmit && npm test`
Expected: tests all pass (should be 190 total: existing 185 + 5 new email tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/scheduler/cron.ts
git commit -m "feat(server): wire email channel into cron fan-out

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Settings wiring (encryption + allowed key + test route)

**Files:**
- Modify: `server/src/db/queries.ts` (add `email_recipient` to ENCRYPTED_KEYS)
- Modify: `server/src/routes/settings.ts` (allowed keys + new test route)

- [ ] **Step 1: Add recipient key to encrypted set**

In `server/src/db/queries.ts`, change the `ENCRYPTED_KEYS` set:

```typescript
const ENCRYPTED_KEYS = new Set([
  'discord_webhook_url',
  'ntfy_url',
  'ntfy_token',
  'generic_webhook_url',
  'email_recipient',
]);
```

Rationale: the recipient is mildly sensitive (an email address that receives alerts) and encryption is trivially cheap; consistent with how other channel values are stored.

- [ ] **Step 2: Update settings route — allowed keys + new endpoint**

Replace the full contents of `server/src/routes/settings.ts` with:

```typescript
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
```

- [ ] **Step 3: TypeCheck**

Run: `cd /root/price-tracker/server && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add server/src/db/queries.ts server/src/routes/settings.ts
git commit -m "feat(server): email_recipient setting + /test-email route

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Client — API helper + Settings UI

**Files:**
- Modify: `client/src/api.ts` (add `testEmail`, loosen types)
- Modify: `client/src/pages/Settings.tsx` (4th channel card)

- [ ] **Step 1: Find existing `testNtfy`/`testGenericWebhook` in the API layer**

Run: `grep -n "testNtfy\|testGenericWebhook\|updateSettings" /root/price-tracker/client/src/api.ts`

- [ ] **Step 2: Add a `testEmail` export**

In `client/src/api.ts`, add next to the other test helpers:

```typescript
export async function testEmail(recipient: string): Promise<{ success: boolean; error?: string }> {
  const res = await fetch('/api/settings/test-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ recipient }),
  });
  return res.json();
}
```

(Match the existing style; if the codebase uses a shared `apiFetch` helper, use that instead — preserve existing conventions.)

- [ ] **Step 3: Add `email` to Settings UI**

In `client/src/pages/Settings.tsx`, make these edits:

a) Extend imports — add `Mail` icon and `testEmail`:

```typescript
import { Save, Send, CheckCircle, XCircle, MessageSquare, Bell, Webhook, Mail } from 'lucide-react'
import { getSettings, updateSettings, testWebhook, testNtfy, testGenericWebhook, testEmail } from '../api'
```

b) Widen the `ChannelKey` / `settingKey` types:

```typescript
type ChannelKey = 'discord' | 'ntfy' | 'webhook' | 'email'

interface ChannelConfig {
  key: ChannelKey
  settingKey: 'discord_webhook_url' | 'ntfy_url' | 'generic_webhook_url' | 'email_recipient'
  icon: React.ReactNode
  title: string
  description: React.ReactNode
  placeholder: string
  inputType?: 'url' | 'email'
  test: (url: string, token?: string) => Promise<{ success: boolean; error?: string }>
}
```

c) Add the fourth entry to `CHANNELS`:

```typescript
  {
    key: 'email',
    settingKey: 'email_recipient',
    icon: <Mail className="w-5 h-5 text-primary" />,
    title: 'Email',
    description: (
      <>
        Get price alerts by email. Messages are sent from{' '}
        <span className="text-text">alerts@schultzsolutions.tech</span>.
      </>
    ),
    placeholder: 'you@example.com',
    inputType: 'email',
    test: testEmail,
  },
```

d) Extend the initial state object to include `email`:

```typescript
  const [values, setValues] = useState<Record<ChannelKey, string>>({ discord: '', ntfy: '', webhook: '', email: '' })
```

e) Extend the `getSettings()` hydrator:

```typescript
      setValues({
        discord: s.discord_webhook_url || '',
        ntfy: s.ntfy_url || '',
        webhook: s.generic_webhook_url || '',
        email: s.email_recipient || '',
      })
```

f) Update the render input to pick `type` per channel:

Replace the hard-coded input line:
```typescript
              <input
                type="url"
```
with:
```typescript
              <input
                type={ch.inputType ?? 'url'}
```

And replace the label:
```typescript
              <label className="block text-sm font-medium text-text-muted mb-1.5">URL</label>
```
with:
```typescript
              <label className="block text-sm font-medium text-text-muted mb-1.5">{ch.inputType === 'email' ? 'Recipient' : 'URL'}</label>
```

- [ ] **Step 4: TypeCheck client**

Run: `cd /root/price-tracker/client && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Run client test suite**

Run: `cd /root/price-tracker/client && npm test`
Expected: all 76 existing tests still pass (no new tests at this step; the UI card is thin enough that the server-side tests carry the invariants).

- [ ] **Step 6: Commit**

```bash
git add client/src/api.ts client/src/pages/Settings.tsx
git commit -m "feat(client): email channel card in Settings

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Full test + build verification

- [ ] **Step 1: Server full test run**

Run: `cd /root/price-tracker/server && npm test`
Expected: 190 tests pass (185 prior + 5 new email).

- [ ] **Step 2: Client full test run**

Run: `cd /root/price-tracker/client && npm test`
Expected: 76 tests pass (unchanged).

- [ ] **Step 3: Client build check**

Run: `cd /root/price-tracker/client && npm run build`
Expected: Vite build succeeds, no warnings about missing imports.

---

## Task 7: Gmail / Cloudflare manual setup (user-driven)

This task is for the human — Claude walks through the steps interactively. Skip if already done.

- [ ] **Step 1: Gmail app password**

Ask the user to visit https://myaccount.google.com/apppasswords while signed in as `homelab.schultz@gmail.com`. Name: `Price Tracker SMTP`. Copy the 16-character value. **Keep this to paste into .env later.**

- [ ] **Step 2: Cloudflare Email Routing for `alerts@schultzsolutions.tech`**

Cloudflare dashboard → schultzsolutions.tech → Email → Email Routing → Routes → Create address → Custom address `alerts` → action "Send to an email" → `homelab.schultz@gmail.com` → Save.

- [ ] **Step 3: Gmail Send-As**

In `homelab.schultz@gmail.com`: Settings (gear) → See all settings → **Accounts** tab → **Send mail as** → **Add another email address**.
- Name: `Price Tracker`
- Email: `alerts@schultzsolutions.tech`
- ✅ Treat as an alias (checked)
- SMTP server: `smtp.gmail.com`
- Port: `465`
- Username: `homelab.schultz@gmail.com`
- Password: the app password from step 1
- Secured connection using SSL
- Add account → paste verification code from inbox → confirm.

---

## Task 8: Deploy to CT 302 + smoke test

- [ ] **Step 1: Add SMTP env vars on CT 302**

SSH in and append to `/opt/price-tracker/.env`:

```bash
ssh root@192.168.1.166
cat >> /opt/price-tracker/.env <<'EOF'
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=homelab.schultz@gmail.com
SMTP_PASS=<app password from Task 7 step 1>
SMTP_FROM=Price Tracker <alerts@schultzsolutions.tech>
EOF
exit
```

- [ ] **Step 2: Deploy**

Run: `cd /root/price-tracker && bash scripts/deploy.sh`
Expected: build succeeds, rsync completes, service restarts.

- [ ] **Step 3: Verify service is healthy**

Run: `ssh root@192.168.1.166 'systemctl is-active price-tracker && journalctl -u price-tracker -n 15 --no-pager'`
Expected: `active`, recent log lines show scheduler started + no startup errors.

- [ ] **Step 4: Smoke test via Settings UI**

In the browser at https://prices.schultzsolutions.tech → Settings → enter a recipient email in the Email card → click **Save** → click **Test** → confirm an email arrives within ~15 seconds.

If it fails, check:
- `journalctl -u price-tracker -f` for SMTP errors (`EAUTH` → wrong app password; `ETIMEDOUT` → firewall blocking 465)
- Gmail's "Sent" folder on `homelab.schultz@gmail.com` — test messages should appear there
- Cloudflare Email Routing Activity log for bounces

- [ ] **Step 5: End-to-end price alert smoke**

On the dashboard, set one existing tracker's threshold higher than its current price (temporarily) and click "Check Now". Confirm an email arrives alongside any other configured channels. Revert the threshold afterward.

---

## Task 9: Docs + PR

- [ ] **Step 1: Mark todo done**

Edit `tasks/todo.md` — change the Email notification channel line from `- [ ]` to `- [x]` with a date + PR reference:

```markdown
- [x] **Email notification channel.** ~~Fourth channel reusing Cloudflare+Gmail relay.~~ **Done 2026-04-18:** Gmail SMTP via `alerts@schultzsolutions.tech` Send-As alias, nodemailer transport, multipart HTML + plaintext bodies, encrypted `email_recipient` per user, new `/api/settings/test-email` endpoint, Settings card with "Send test email" button. Spec: `docs/superpowers/specs/2026-04-18-email-notification-channel-design.md`. Plan: `docs/superpowers/plans/2026-04-18-email-notification-channel.md`. [PR #N](...).
```

Replace `#N` with the real PR number after opening.

- [ ] **Step 2: Lessons update**

Append a short section to `tasks/lessons.md` capturing anything non-obvious learned during implementation (Gmail Send-As gotchas, SMTP port decisions, etc). If nothing surprising came up, skip this step.

- [ ] **Step 3: Push branch**

```bash
git add tasks/todo.md tasks/lessons.md 2>/dev/null
git diff --cached --quiet || git commit -m "docs: mark email channel done, capture lessons

Co-Authored-By: Claude <noreply@anthropic.com>"
git push -u origin feature/email-notification-channel
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat: email notification channel via Gmail SMTP" --body "$(cat <<'EOF'
## Summary

Adds email as the fourth notification channel alongside Discord, ntfy, and generic webhook. Sends multipart HTML + plaintext alerts over Gmail SMTP from the verified `alerts@schultzsolutions.tech` Send-As alias.

## What's new

- New `server/src/notifications/email.ts` module — `sendEmailPriceAlert`, `sendEmailErrorAlert`, `testEmail` matching the existing channel shape
- SMTP config in `server/src/config.ts` via `SMTP_*` env vars + `isEmailConfigured()` helper
- Cron fan-out extended — email runs alongside other enabled channels with the same per-(tracker, seller) cooldown
- `email_recipient` per-user setting, encrypted at rest via existing `settings-crypto.ts`
- `POST /api/settings/test-email` route with basic email-shape validation
- Settings UI gets a fourth card with a `type="email"` input, "Send test email" button

## Spec + plan

- Spec: `docs/superpowers/specs/2026-04-18-email-notification-channel-design.md`
- Plan: `docs/superpowers/plans/2026-04-18-email-notification-channel.md`

## Test plan

- [x] Server: 190 tests pass (5 new in `email.test.ts`)
- [x] Client: 76 tests pass (unchanged)
- [x] Deployed to CT 302 via `scripts/deploy.sh`
- [x] Send test email from Settings → arrives within ~15s
- [x] End-to-end: trigger a below-threshold scrape, email fires alongside other channels

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Backfill the PR number in todo.md**

After opening the PR, update the `[PR #N](...)` link in `tasks/todo.md` to the real URL and amend:

```bash
git add tasks/todo.md
git commit --amend --no-edit
git push --force-with-lease
```

---

## Self-review notes

- Spec coverage: each numbered section of the spec maps to a task (transport → Task 1-2, per-user setting → Task 4, cron → Task 3, settings UI → Task 5, runbook → Task 7, smoke test → Task 8).
- No placeholders remain in plan tasks; every code block is complete.
- Type consistency: `EnabledChannels.email`, `email_recipient` setting key, and `ChannelKey = '… | email'` all agree.
- One deliberate gap: no dedicated unit test for the `/api/settings/test-email` route. The route is thin enough (body-shape + regex + delegation) that adding a supertest dependency for a single endpoint is more weight than value; covered manually in Task 8 smoke test.
