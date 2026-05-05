import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { _setClientForTesting } from './generators.js';
import { runBackfillSweep } from './backfill-cron.js';
import type { ClaudeResponse } from './client.js';

const mockClient = vi.fn<[unknown], Promise<ClaudeResponse>>();

function seedTrackerWithSummaryAge(name: string, summaryAgeDays: number | null): number {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES (?, 'h', ?)`)
    .run(`${name}@x.com`, name);
  const userId = (db.prepare('SELECT id FROM users WHERE email=?').get(`${name}@x.com`) as { id: number }).id;
  db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES (?, 'https://example.com/p', ?, 100, 'active', 60, 0, 100)`
  ).run(name, userId);
  const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get(name) as { id: number }).id;
  const now = Date.now();
  for (let i = 30; i >= 0; i--) {
    db.prepare(`INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, ?)`)
      .run(trackerId, 100 - i * 0.5, new Date(now - i * 86_400_000).toISOString());
  }
  if (summaryAgeDays !== null) {
    db.prepare(`UPDATE trackers SET ai_summary='old', ai_summary_updated_at=? WHERE id=?`)
      .run(Date.now() - summaryAgeDays * 86_400_000, trackerId);
  }
  return trackerId;
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  mockClient.mockReset();
  _setClientForTesting(mockClient);
  process.env.AI_ENABLED = 'true';
  process.env.ANTHROPIC_API_KEY = 'test';
});

describe('runBackfillSweep', () => {
  it('regenerates summaries for trackers older than 7 days', async () => {
    seedTrackerWithSummaryAge('OldA', 10);
    seedTrackerWithSummaryAge('FreshB', 1);
    mockClient.mockResolvedValue({
      text: 'New summary.', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50,
    });
    const out = await runBackfillSweep();
    expect(out.attempted).toBe(1);
    expect(mockClient).toHaveBeenCalledTimes(1);
  });

  it('regenerates summaries for trackers with NULL summary timestamp', async () => {
    seedTrackerWithSummaryAge('Never', null);
    mockClient.mockResolvedValue({
      text: 'New summary.', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50,
    });
    const out = await runBackfillSweep();
    expect(out.attempted).toBe(1);
  });

  it('respects the per-sweep limit of 50', async () => {
    for (let i = 0; i < 60; i++) seedTrackerWithSummaryAge(`T${i}`, 10);
    mockClient.mockResolvedValue({
      text: 'New summary.', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50,
    });
    const out = await runBackfillSweep();
    expect(out.attempted).toBe(50);
  });

  it('returns { attempted: 0 } when AI_ENABLED is false', async () => {
    seedTrackerWithSummaryAge('OldA', 10);
    process.env.AI_ENABLED = 'false';
    const out = await runBackfillSweep();
    expect(out.attempted).toBe(0);
    expect(mockClient).not.toHaveBeenCalled();
  });
});
