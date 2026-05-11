import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker,
  addTrackerUrl,
  getTrackerById,
  getTrackerUrlsForTracker,
} from './queries.js';

/**
 * Confirms that creating a tracker (or adding a seller URL) whose host
 * is on the known-blocked retailer list lands status='blocked'
 * immediately, instead of letting the cron run hit the WAF three
 * times in a row to discover the same thing.
 */

function seedUser(): number {
  return Number(
    getDb()
      .prepare(
        `INSERT INTO users (email, password_hash, display_name, role, is_active)
         VALUES ('t@x.com', 'h', 'T', 'user', 1)`,
      )
      .run().lastInsertRowid,
  );
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

afterEach(() => {
  _setDbForTesting(null);
  resetCrypto();
});

describe('auto-block on creation for known-blocked retailer hosts', () => {
  it("createTracker() for Home Depot URL lands primary seller status='blocked'", () => {
    const userId = seedUser();
    const tracker = createTracker({
      name: 'Kreg 720 Pro',
      url: 'https://www.homedepot.com/p/Kreg-720PRO/313974091',
      threshold_price: 130,
      user_id: userId,
    });
    const sellers = getTrackerUrlsForTracker(tracker.id);
    expect(sellers).toHaveLength(1);
    expect(sellers[0].status).toBe('blocked');
    expect(sellers[0].last_error).toMatch(/blocks automated requests/i);

    // Aggregation roll-up: single blocked seller → tracker also 'blocked'.
    const refreshed = getTrackerById(tracker.id)!;
    expect(refreshed.status).toBe('blocked');
  });

  it("createTracker() for Best Buy URL also auto-blocks", () => {
    const userId = seedUser();
    const tracker = createTracker({
      name: 'TV',
      url: 'https://www.bestbuy.com/site/abc/12345.p',
      threshold_price: 999,
      user_id: userId,
    });
    expect(getTrackerUrlsForTracker(tracker.id)[0].status).toBe('blocked');
  });

  it("createTracker() for Amazon URL stays 'active' (default)", () => {
    const userId = seedUser();
    const tracker = createTracker({
      name: 'Amazon thing',
      url: 'https://www.amazon.com/dp/B0XYZ',
      user_id: userId,
    });
    expect(getTrackerUrlsForTracker(tracker.id)[0].status).toBe('active');
    expect(getTrackerById(tracker.id)!.status).toBe('active');
  });

  it("addTrackerUrl() for Home Depot host lands new seller status='blocked'", () => {
    const userId = seedUser();
    const tracker = createTracker({
      name: 'Mixed retailers',
      url: 'https://www.amazon.com/dp/B0XYZ', // primary: active
      user_id: userId,
    });
    const newSeller = addTrackerUrl(
      tracker.id,
      'https://www.homedepot.com/p/Kreg-720PRO/313974091',
    );
    expect(newSeller.status).toBe('blocked');
    expect(newSeller.last_error).toMatch(/blocks automated requests/i);
  });

  it("addTrackerUrl() for a working retailer stays 'active'", () => {
    const userId = seedUser();
    const tracker = createTracker({
      name: 'Mixed',
      url: 'https://www.amazon.com/dp/B0XYZ',
      user_id: userId,
    });
    const newSeller = addTrackerUrl(tracker.id, 'https://newegg.com/p/N123');
    expect(newSeller.status).toBe('active');
    expect(newSeller.last_error).toBeNull();
  });
});
