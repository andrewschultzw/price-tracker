import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

vi.mock('../scraper/extractor.js', () => ({ extractPrice: vi.fn() }));
vi.mock('../notifications/discord.js', () => ({
  sendDiscordPriceAlert: vi.fn().mockResolvedValue(true),
  sendDiscordErrorAlert: vi.fn().mockResolvedValue(true),
  sendDiscordBasketAlert: vi.fn().mockResolvedValue(true),
  testDiscordWebhook: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/ntfy.js', () => ({
  sendNtfyPriceAlert: vi.fn().mockResolvedValue(true),
  sendNtfyErrorAlert: vi.fn().mockResolvedValue(true),
  sendNtfyBasketAlert: vi.fn().mockResolvedValue(true),
}));
vi.mock('../notifications/webhook.js', () => ({
  sendGenericPriceAlert: vi.fn().mockResolvedValue(true),
  sendGenericErrorAlert: vi.fn().mockResolvedValue(true),
  sendGenericBasketAlert: vi.fn().mockResolvedValue(true),
  assertWebhookUrl: vi.fn(),
}));
vi.mock('../notifications/email.js', () => ({
  sendEmailPriceAlert: vi.fn().mockResolvedValue(true),
  sendEmailErrorAlert: vi.fn().mockResolvedValue(true),
  sendEmailBasketAlert: vi.fn().mockResolvedValue(true),
}));

import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { createProject, addProjectTracker, setSetting } from '../db/queries.js';
import { checkTrackerUrl } from './cron.js';
import { extractPrice } from '../scraper/extractor.js';
import { sendDiscordBasketAlert } from '../notifications/discord.js';

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function seedTrackerWithSeller(userId: number, name: string, lastPrice: number): { trackerId: number; trackerUrlId: number } {
  const trackerInsert = getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 999, 'active', 60, 0, ?)`
  ).run(name, `https://amazon.com/dp/${name}`, userId, lastPrice);
  const trackerId = Number(trackerInsert.lastInsertRowid);
  const urlInsert = getDb().prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position, last_price, status)
     VALUES (?, ?, 0, ?, 'active')`
  ).run(trackerId, `https://amazon.com/dp/${name}`, lastPrice);
  const trackerUrlId = Number(urlInsert.lastInsertRowid);
  return { trackerId, trackerUrlId };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('cron project re-eval hook', () => {
  it('fires basket alert when scrape brings basket total at-or-below target', async () => {
    const u = seedUser();
    setSetting('discord_webhook_url', 'https://example/wh', u);
    const { trackerId: t1, trackerUrlId: url1 } = seedTrackerWithSeller(u, 'A', 80);
    const { trackerId: t2 } = seedTrackerWithSeller(u, 'B', 40);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });

    // Mock the next scrape to bring A from 80 → 50 (basket: 50+40=90 ≤ 100)
    vi.mocked(extractPrice).mockResolvedValue({
      price: 50, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(url1);
    // Wait a tick for fire-and-forget firer to settle
    await new Promise(r => setTimeout(r, 100));

    expect(sendDiscordBasketAlert).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire basket alert when project is archived', async () => {
    const u = seedUser();
    setSetting('discord_webhook_url', 'https://example/wh', u);
    const { trackerId: t1, trackerUrlId: url1 } = seedTrackerWithSeller(u, 'A', 80);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    getDb().prepare(`UPDATE projects SET status='archived' WHERE id=?`).run(p);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 50, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(url1);
    await new Promise(r => setTimeout(r, 100));

    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('does NOT block the scrape pipeline if the firer throws', async () => {
    const u = seedUser();
    setSetting('discord_webhook_url', 'https://example/wh', u);
    const { trackerId: t1, trackerUrlId: url1 } = seedTrackerWithSeller(u, 'A', 80);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });

    vi.mocked(extractPrice).mockResolvedValue({
      price: 50, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);
    vi.mocked(sendDiscordBasketAlert).mockRejectedValue(new Error('discord down'));

    await expect(checkTrackerUrl(url1)).resolves.not.toThrow();
    // Even if alert fails, the price_history row was inserted by the scrape
    const phRows = getDb().prepare('SELECT COUNT(*) as c FROM price_history WHERE tracker_id=?').get(t1) as { c: number };
    expect(phRows.c).toBeGreaterThan(0);
  });

  it('does nothing when tracker is in no projects', async () => {
    const u = seedUser();
    setSetting('discord_webhook_url', 'https://example/wh', u);
    const { trackerUrlId: url1 } = seedTrackerWithSeller(u, 'A', 80);

    vi.mocked(extractPrice).mockResolvedValue({
      price: 50, currency: 'USD', strategy: 'mock', finalUrl: 'https://amazon.com/dp/A',
    } as never);

    await checkTrackerUrl(url1);
    await new Promise(r => setTimeout(r, 100));

    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });
});
