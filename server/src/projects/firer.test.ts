import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';

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
import { evaluateAndFireForProject } from './firer.js';
import { sendDiscordBasketAlert } from '../notifications/discord.js';
import { sendNtfyBasketAlert } from '../notifications/ntfy.js';
import { sendEmailBasketAlert } from '../notifications/email.js';
import { sendGenericBasketAlert } from '../notifications/webhook.js';

function seedUser(): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES ('t@x.com','h','T','user',1)`
  ).run().lastInsertRowid);
}

function seedTracker(userId: number, name: string, lastPrice: number | null, status: 'active' | 'paused' | 'error' = 'active'): number {
  return Number(getDb().prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, ?, ?, 100, ?, 60, 0, ?)`
  ).run(name, `https://example/${name}`, userId, status, lastPrice).lastInsertRowid);
}

function setupChannels(userId: number) {
  setSetting('discord_webhook_url', 'https://example/wh', userId);
  setSetting('ntfy_url', 'https://ntfy.example/topic', userId);
  setSetting('email_recipient', 'user@example.com', userId);
  setSetting('generic_webhook_url', 'https://hooks.example/x', userId);
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

describe('evaluateAndFireForProject', () => {
  it('fires across all 4 enabled channels when basket is eligible', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30);
    const t2 = seedTracker(u, 'B', 40);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });

    await evaluateAndFireForProject(p);

    expect(sendDiscordBasketAlert).toHaveBeenCalledTimes(1);
    expect(sendNtfyBasketAlert).toHaveBeenCalledTimes(1);
    expect(sendEmailBasketAlert).toHaveBeenCalledTimes(1);
    expect(sendGenericBasketAlert).toHaveBeenCalledTimes(1);

    const notifs = getDb().prepare('SELECT channel FROM project_notifications WHERE project_id=?').all(p) as { channel: string }[];
    expect(notifs.map(n => n.channel).sort()).toEqual(['discord', 'email', 'ntfy', 'webhook']);
  });

  it('does NOT fire when basket is over target', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 80);
    const t2 = seedTracker(u, 'B', 40);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });

    await evaluateAndFireForProject(p);
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('does NOT fire when any member is errored', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30, 'active');
    const t2 = seedTracker(u, 'B', 40, 'error');
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    addProjectTracker({ project_id: p, tracker_id: t2 });

    await evaluateAndFireForProject(p);
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('does NOT fire when project is archived', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });
    getDb().prepare(`UPDATE projects SET status='archived' WHERE id=?`).run(p);

    await evaluateAndFireForProject(p);
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('respects per-channel cooldown — Discord skipped within 6h, ntfy still fires', async () => {
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });

    // Seed a recent Discord notification (1 hour ago — well within default 6h cooldown).
    getDb().prepare(
      `INSERT INTO project_notifications (project_id, channel, basket_total, target_total, sent_at)
       VALUES (?, 'discord', 30, 100, datetime('now', '-1 hour'))`
    ).run(p);

    await evaluateAndFireForProject(p);
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
    expect(sendNtfyBasketAlert).toHaveBeenCalledTimes(1);
  });

  it('does not throw when no channels are enabled', async () => {
    const u = seedUser();
    // No setupChannels call — user has nothing configured
    const t1 = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });

    await expect(evaluateAndFireForProject(p)).resolves.not.toThrow();
    expect(sendDiscordBasketAlert).not.toHaveBeenCalled();
  });

  it('does not throw if project does not exist', async () => {
    await expect(evaluateAndFireForProject(99999)).resolves.not.toThrow();
  });

  it('one channel failing does not block other channels', async () => {
    vi.mocked(sendDiscordBasketAlert).mockResolvedValueOnce(false);
    const u = seedUser();
    setupChannels(u);
    const t1 = seedTracker(u, 'A', 30);
    const p = createProject({ user_id: u, name: 'NAS', target_total: 100 });
    addProjectTracker({ project_id: p, tracker_id: t1 });

    await evaluateAndFireForProject(p);

    expect(sendDiscordBasketAlert).toHaveBeenCalledTimes(1);
    expect(sendNtfyBasketAlert).toHaveBeenCalledTimes(1);
    // Discord failure → no notification logged for it; ntfy/email/webhook all logged
    const notifs = getDb().prepare('SELECT channel FROM project_notifications WHERE project_id=?').all(p) as { channel: string }[];
    expect(notifs.map(n => n.channel).sort()).toEqual(['email', 'ntfy', 'webhook']);
  });
});
