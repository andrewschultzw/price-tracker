import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyDigest: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/discord.js', () => ({
  sendDiscordDigest: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailDigest: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericDigest: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createTracker, setSetting, getSetting, addNotification } from '../db/queries.js';
import { resolveDigestChannel, runDigestForUser } from './cron.js';
import { sendNtfyDigest } from '../notifications/ntfy.js';
import { sendDiscordDigest } from '../notifications/discord.js';

// Sunday 08:xx America/Chicago (13:07 UTC during CDT).
const DUE_NOW = Date.parse('2026-07-26T13:07:00Z');

function seedUser(): number {
  return Number(getDb().prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('d@x.com', 'h', 'D', 'user', 1)
  `).run().lastInsertRowid);
}

describe('weekly digest cron', () => {
  let userId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
    userId = seedUser();
    setSetting('ntfy_url', 'https://ntfy.sh/digest-test', userId);
  });

  afterEach(() => {
    _setDbForTesting(null);
    resetCrypto();
  });

  /** Give the digest something to say: a record-low notification this week. */
  function seedContent(): void {
    const t = createTracker({ name: 'Widget', url: 'https://amazon.com/dp/W', threshold_price: null, user_id: userId });
    addNotification(t.id, 49.4, 0, 'ntfy', null, 'low_all_time');
  }

  it('sends when due, stamps, and the stamp blocks a re-send', async () => {
    seedContent();
    expect(await runDigestForUser(userId, DUE_NOW)).toBe('sent');
    expect(vi.mocked(sendNtfyDigest)).toHaveBeenCalledTimes(1);
    const body = vi.mocked(sendNtfyDigest).mock.calls[0][1];
    expect(body).toContain('Record lows hit');
    expect(getSetting('digest_last_sent_at', userId)).toBeTruthy();

    // Same hour, second tick: idempotent.
    expect(await runDigestForUser(userId, DUE_NOW + 60_000)).toBe('not_due');
    expect(vi.mocked(sendNtfyDigest)).toHaveBeenCalledTimes(1);
  });

  it('not due outside the configured slot', async () => {
    seedContent();
    expect(await runDigestForUser(userId, DUE_NOW + 5 * 3_600_000)).toBe('not_due');
  });

  it('empty week: skipped but stamped (slot consumed), digest_always overrides', async () => {
    expect(await runDigestForUser(userId, DUE_NOW)).toBe('skipped_empty');
    expect(getSetting('digest_last_sent_at', userId)).toBeTruthy();
    expect(vi.mocked(sendNtfyDigest)).not.toHaveBeenCalled();

    setSetting('digest_last_sent_at', '', userId);
    setSetting('digest_always', 'true', userId);
    expect(await runDigestForUser(userId, DUE_NOW)).toBe('sent');
  });

  it('digest_enabled=false silences everything', async () => {
    seedContent();
    setSetting('digest_enabled', 'false', userId);
    expect(await runDigestForUser(userId, DUE_NOW)).toBe('not_due');
  });

  it('explicit channel wins; unconfigured explicit channel means no send', async () => {
    seedContent();
    setSetting('discord_webhook_url', 'https://discord.com/api/webhooks/x', userId);
    setSetting('digest_channel', 'discord', userId);
    expect(await runDigestForUser(userId, DUE_NOW)).toBe('sent');
    expect(vi.mocked(sendDiscordDigest)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendNtfyDigest)).not.toHaveBeenCalled();

    setSetting('digest_last_sent_at', '', userId);
    setSetting('digest_channel', 'email', userId); // not configured
    expect(await runDigestForUser(userId, DUE_NOW)).toBe('no_channel');
  });

  it('send failure does NOT stamp, so the next tick retries', async () => {
    seedContent();
    vi.mocked(sendNtfyDigest).mockResolvedValueOnce(false);
    expect(await runDigestForUser(userId, DUE_NOW)).toBe('send_failed');
    expect(getSetting('digest_last_sent_at', userId)).toBeFalsy();
    expect(await runDigestForUser(userId, DUE_NOW + 60_000)).toBe('sent');
  });

  it('force ignores scheduling but not channel resolution', async () => {
    seedContent();
    const offSchedule = DUE_NOW + 26 * 3_600_000;
    expect(await runDigestForUser(userId, offSchedule, { force: true })).toBe('sent');
  });
});

describe('resolveDigestChannel', () => {
  it('falls back ntfy → discord → email → webhook', () => {
    expect(resolveDigestChannel(undefined, { email: 'a@b.c', webhook: 'https://x' })).toBe('email');
    expect(resolveDigestChannel(undefined, { webhook: 'https://x' })).toBe('webhook');
    expect(resolveDigestChannel(undefined, {})).toBeNull();
  });
});
