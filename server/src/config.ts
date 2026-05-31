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
  // Plausibility guard. A scrape that would otherwise fire an alert is
  // suppressed when its price is below this fraction of the seller's
  // trailing median (warm) or last_price (cold-start). Confirmation
  // re-scrape decides whether to fire the alert. Set to 0 to disable
  // the guard entirely. See docs/superpowers/specs/2026-04-27-
  // plausibility-guard-design.md.
  plausibilityGuardDropThreshold: parseFloat(
    process.env.PLAUSIBILITY_GUARD_DROP_THRESHOLD || '0.5',
  ),
  // Auth
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? '' : 'dev-secret-do-not-use-in-prod'),
  jwtAccessExpirySeconds: 900,       // 15 minutes
  jwtRefreshExpiryDays: 30,
  bcryptRounds: 12,
  // Per-user invite quotas. Default 3 unused/active invites per non-admin
  // user; admins bypass entirely. Default expiry is 30 days when callers
  // omit `expires_at`. See:
  // docs/superpowers/specs/2026-05-06-per-user-invite-quotas-design.md
  defaultInviteQuota: 3,
  defaultInviteExpiryDays: 30,
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
  // AI Buyer's Assistant (Claude API)
  // NB: AI_ENABLED is read directly from process.env in client.ts, generators.ts,
  // and cron.ts so test env mutations (process.env.AI_ENABLED = 'true' in
  // beforeEach) take effect at call-time. Don't add a cached `aiEnabled` field
  // here — it would be a stale snapshot under tests.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  aiModel: process.env.AI_MODEL || 'claude-haiku-4-5-20251001',
  aiAlertCopyTimeoutMs: 3000,
  aiSummaryStalenessDays: 7,
  // Verdict staleness window for the nightly backfill sweep. Same default
  // as summaries (7 days). Configurable separately so the verdict sweep
  // (single Haiku call per tracker) can be tuned independently of the
  // heavier summary sweep if cost or volume profiles diverge.
  aiVerdictStalenessDays: 7,
  aiVerdictMinDataDays: 14,
  // Web Push (PWA notifications)
  webPushVapidPublic: process.env.WEB_PUSH_VAPID_PUBLIC_KEY || '',
  webPushVapidPrivate: process.env.WEB_PUSH_VAPID_PRIVATE_KEY || '',
  webPushSubject: process.env.WEB_PUSH_SUBJECT || '',
  // Amazon Associates affiliate tag. When set, all Amazon URLs the
  // API returns get `?tag=<tag>` appended on the way out. Empty
  // string disables the feature (no rewrite, no disclosure footer).
  // Compliance: rewritten URLs are sent to UI and public pages only.
  // Email channel is NOT tagged (Amazon ToS section 5(b) prohibits
  // affiliate links in email); push channels (Discord/ntfy/webhook/
  // web_push) currently also skip the rewrite to keep notification
  // bodies copy-pasteable, but could opt in later.
  amazonAffiliateTag: process.env.AMAZON_AFFILIATE_TAG || '',
  // Buy-on-trigger (autonomous purchasing v1). armExpiryHours: how long an
  // armed/approved intent stays actionable before the expiry sweep retires
  // it. reArmCooldownHours: after an intent expires or is marked
  // not-completed, suppress re-arming the same tracker for this long so a
  // deal sitting below threshold doesn't nag every cron tick.
  armExpiryHours: parseInt(process.env.ARM_EXPIRY_HOURS || '24', 10),
  reArmCooldownHours: parseInt(process.env.RE_ARM_COOLDOWN_HOURS || '24', 10),
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

/**
 * True when all VAPID values needed to send Web Push are present.
 * The actual sender (`server/src/notifications/web-push.ts`) reads from
 * `process.env` directly so test env mutations work, but consumers that
 * need the boolean (e.g. startup banner, future Settings UI hint) should
 * use this helper.
 */
export function isWebPushConfigured(): boolean {
  return !!(config.webPushVapidPublic && config.webPushVapidPrivate && config.webPushSubject);
}

/**
 * True when the Amazon Associates tag is configured. The API
 * serialization layer skips the rewrite when this is false; the
 * client renders the disclosure footer only when this is true (via
 * the public `/api/config/public` endpoint).
 */
export function isAmazonAffiliateConfigured(): boolean {
  return config.amazonAffiliateTag.trim() !== '';
}
