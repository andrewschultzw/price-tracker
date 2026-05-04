import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { getTrackerById } from '../db/queries.js';

describe('Tracker API payload — AI fields', () => {
  beforeEach(() => {
    resetCrypto();
    initSettingsCrypto(randomBytes(32).toString('base64'));
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    _setDbForTesting(db);
    initializeSchema();
  });

  it('exposes ai_verdict_* and ai_summary fields when populated', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes, last_price)
       VALUES ('T','https://x',?,100,'active',60,0,80)`
    ).run(userId);
    const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get('T') as { id: number }).id;

    db.prepare(`UPDATE trackers SET
      ai_verdict_tier='BUY', ai_verdict_reason='At low.', ai_verdict_reason_key='at_all_time_low',
      ai_verdict_updated_at=?, ai_summary='Story.', ai_summary_updated_at=?,
      ai_signals_json='{}', ai_failure_count=0
    WHERE id=?`).run(Date.now(), Date.now(), trackerId);

    const t = getTrackerById(trackerId);
    expect(t).toBeDefined();
    expect(t!.ai_verdict_tier).toBe('BUY');
    expect(t!.ai_verdict_reason).toBe('At low.');
    expect(t!.ai_verdict_reason_key).toBe('at_all_time_low');
    expect(t!.ai_verdict_updated_at).toBeGreaterThan(0);
    expect(t!.ai_summary).toBe('Story.');
    expect(t!.ai_summary_updated_at).toBeGreaterThan(0);
    expect(t!.ai_signals_json).toBe('{}');
    expect(t!.ai_failure_count).toBe(0);
  });

  it('AI fields are null on a fresh tracker', () => {
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('t@x.com','h','T')`).run();
    const userId = (db.prepare('SELECT id FROM users WHERE email=?').get('t@x.com') as { id: number }).id;
    db.prepare(
      `INSERT INTO trackers (name, url, user_id, threshold_price, status, check_interval_minutes, jitter_minutes)
       VALUES ('T','https://x',?,100,'active',60,0)`
    ).run(userId);
    const trackerId = (db.prepare('SELECT id FROM trackers WHERE name=?').get('T') as { id: number }).id;

    const t = getTrackerById(trackerId);
    expect(t).toBeDefined();
    expect(t!.ai_verdict_tier).toBeNull();
    expect(t!.ai_verdict_reason).toBeNull();
    expect(t!.ai_verdict_reason_key).toBeNull();
    expect(t!.ai_verdict_updated_at).toBeNull();
    expect(t!.ai_summary).toBeNull();
    expect(t!.ai_summary_updated_at).toBeNull();
    expect(t!.ai_signals_json).toBeNull();
    expect(t!.ai_failure_count).toBe(0); // default 0 from migration v8
  });
});
