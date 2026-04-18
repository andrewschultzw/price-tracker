import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker,
  getOverlapForTracker,
  getOverlapCountsForUser,
  setSetting,
} from './queries.js';

function setupDb() {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
  // Three users: Alice (opts in), Bob (opts out), Carol (opts in).
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('a@x', 'h', 'Alice')`).run();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('b@x', 'h', 'Bob')`).run();
  db.prepare(`INSERT INTO users (email, password_hash, display_name) VALUES ('c@x', 'h', 'Carol')`).run();
  setSetting('share_display_name', 'true', 1);
  setSetting('share_display_name', 'false', 2);
  setSetting('share_display_name', 'true', 3);
}

describe('getOverlapForTracker', () => {
  beforeEach(setupDb);

  it('excludes self from count and names; includes only opted-in names', () => {
    const tAlice = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 });
    createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 3 });

    const r = getOverlapForTracker(tAlice.id, 1);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);           // Bob + Carol
    expect(r!.names).toEqual(['Carol']); // only Carol opted in among peers
  });

  it('returns count 0 and empty names when no other user tracks it', () => {
    const t = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0UNIQUE', user_id: 1 });
    const r = getOverlapForTracker(t.id, 1);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(0);
    expect(r!.names).toEqual([]);
    expect(r!.communityLow).toBeNull();
  });

  it('returns null if the tracker is not owned by the user', () => {
    const t = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    expect(getOverlapForTracker(t.id, 2)).toBeNull();
  });

  it('handles malformed URL tracker (null normalized_url)', () => {
    const t = createTracker({ name: 'T', url: 'not-a-url', user_id: 1 });
    const r = getOverlapForTracker(t.id, 1);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(0);
    expect(r!.names).toEqual([]);
    expect(r!.communityLow).toBeNull();
  });

  it('community low is MIN(last_price) INCLUDING self', () => {
    const tAlice = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    const tBob = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 });
    const db = getDb();
    db.prepare('UPDATE trackers SET last_price = ? WHERE id = ?').run(40, tAlice.id);
    db.prepare('UPDATE trackers SET last_price = ? WHERE id = ?').run(35, tBob.id);
    expect(getOverlapForTracker(tAlice.id, 1)!.communityLow).toBe(35);
  });

  it('community low excludes null prices', () => {
    const tAlice = createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    createTracker({ name: 'T', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 }); // no price
    const db = getDb();
    db.prepare('UPDATE trackers SET last_price = ? WHERE id = ?').run(40, tAlice.id);
    expect(getOverlapForTracker(tAlice.id, 1)!.communityLow).toBe(40);
  });
});

describe('getOverlapCountsForUser', () => {
  beforeEach(setupDb);

  it('returns a map of trackerId -> count for every tracker owned by the user', () => {
    const tA = createTracker({ name: 'A', url: 'https://amazon.com/dp/B0XYZ', user_id: 1 });
    const tB = createTracker({ name: 'B', url: 'https://amazon.com/dp/B0UNIQUE', user_id: 1 });
    createTracker({ name: 'shared-A', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 });
    createTracker({ name: 'shared-A', url: 'https://amazon.com/dp/B0XYZ', user_id: 3 });

    const counts = getOverlapCountsForUser(1);
    expect(counts[tA.id]).toBe(2);
    expect(counts[tB.id]).toBe(0);
  });

  it('does not include trackers from other users in the result', () => {
    createTracker({ name: 'A', url: 'https://amazon.com/dp/B0XYZ', user_id: 2 });
    expect(getOverlapCountsForUser(1)).toEqual({});
  });
});
