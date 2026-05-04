import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  generateVerdictForTracker,
  generateSummaryForTracker,
  generateAlertCopy,
  _setClientForTesting,
} from './generators.js';
import type { ClaudeResponse } from './client.js';
import { AIGenerationError } from './types.js';

const mockCall = vi.fn();

function seedTrackerWithHistory(): number {
  const db = getDb();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('test@x.com', 'h', 'Test')`).run();
  const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('test@x.com') as { id: number }).id;
  db.prepare(
    `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
     VALUES ('Test', 'https://example.com/p', ?, 100, 'active', 60, 0, 100)`
  ).run(userId);
  const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get('Test') as { id: number }).id;
  const now = Date.now();
  for (let i = 30; i >= 0; i--) {
    db.prepare(`INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, ?, ?)`)
      .run(trackerId, 100 - i * 0.5, new Date(now - i * 86_400_000).toISOString());
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
  mockCall.mockReset();
  _setClientForTesting(mockCall);
});
afterEach(() => _setDbForTesting(null));

describe('generateVerdictForTracker', () => {
  it('writes tier, reason, signals_json on success', async () => {
    const id = seedTrackerWithHistory();
    const resp: ClaudeResponse = { text: 'At the all-time low.', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 50 };
    mockCall.mockResolvedValueOnce(resp);
    await generateVerdictForTracker(id);
    const t = getDb().prepare('SELECT * FROM trackers WHERE id=?').get(id) as Record<string, unknown>;
    expect(t.ai_verdict_tier).toBeTruthy();
    expect(t.ai_verdict_reason).toBe('At the all-time low.');
    expect(t.ai_verdict_reason_key).toBeTruthy();
    expect(t.ai_signals_json).toBeTruthy();
    expect(t.ai_failure_count).toBe(0);
    expect(t.ai_verdict_updated_at).toBeGreaterThan(0);
  });

  it('increments failure count and leaves prior values intact on error', async () => {
    const id = seedTrackerWithHistory();
    getDb().prepare(`UPDATE trackers SET ai_verdict_tier='BUY', ai_verdict_reason='old' WHERE id=?`).run(id);
    mockCall.mockRejectedValueOnce(new AIGenerationError('rate_limit', '429'));
    await generateVerdictForTracker(id);
    const t = getDb().prepare('SELECT * FROM trackers WHERE id=?').get(id) as Record<string, unknown>;
    expect(t.ai_verdict_tier).toBe('BUY');
    expect(t.ai_verdict_reason).toBe('old');
    expect(t.ai_failure_count).toBe(1);
  });

  it('skips Claude entirely when signals are null (sparse data)', async () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@b.c','h','A')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('a@b.c') as { id: number }).id;
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
       VALUES ('Sparse', 'https://example.com/sparse', ?, 100, 'active', 60, 0, 100)`
    ).run(userId);
    const id = (db.prepare('SELECT id FROM trackers WHERE name=?').get('Sparse') as { id: number }).id;
    db.prepare(`INSERT INTO price_history (tracker_id, price, scraped_at) VALUES (?, 100, ?)`)
      .run(id, new Date().toISOString());
    await generateVerdictForTracker(id);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('generateAlertCopy', () => {
  it('returns the trimmed text', async () => {
    const resp: ClaudeResponse = { text: '  9-month low.  ', inputTokens: 100, outputTokens: 5, cachedTokens: 90, latencyMs: 30 };
    mockCall.mockResolvedValueOnce(resp);
    const out = await generateAlertCopy({
      trackerName: 'X', oldPrice: 100, newPrice: 80,
      signals: {} as never, reasonKey: 'at_all_time_low',
    });
    expect(out).toBe('9-month low.');
  });

  it('returns null on AIGenerationError', async () => {
    mockCall.mockRejectedValueOnce(new AIGenerationError('rate_limit', '429'));
    const out = await generateAlertCopy({
      trackerName: 'X', oldPrice: 100, newPrice: 80,
      signals: {} as never, reasonKey: 'at_all_time_low',
    });
    expect(out).toBeNull();
  });
});
