import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createTracker,
  addTrackerUrl,
  deleteTrackerUrl,
  getTrackerById,
  getTrackerUrlsForTracker,
} from './queries.js';

/**
 * Integration tests for deleteTrackerUrl — the function that removes a
 * seller URL from a tracker. This has two tricky invariants:
 *
 * 1. EVERY tracker must always keep at least one seller. Deleting the
 *    last remaining seller is refused with a clear error.
 *
 * 2. When the primary (position=0) seller is deleted, the next-lowest
 *    position is promoted to primary AND trackers.url is synced to
 *    match. Either half silently breaking would break category
 *    grouping (which reads tracker.url) and the dashboard card
 *    hostname display.
 */

function seedTestUser(): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, display_name, role, is_active)
    VALUES ('test@example.com', 'fakehash', 'Test User', 'user', 1)
  `).run();
  return Number(result.lastInsertRowid);
}

describe('deleteTrackerUrl', () => {
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

  describe('last-seller protection', () => {
    it('refuses to delete the only remaining seller', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Only one seller',
        url: 'https://amazon.com/dp/A',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];

      const result = deleteTrackerUrl(primary.id);
      expect(result.deleted).toBe(false);
      expect(result.error).toMatch(/last remaining seller/i);

      // The row should still exist after the refusal
      expect(getTrackerUrlsForTracker(tracker.id)).toHaveLength(1);
    });

    it('returns an error when the seller id does not exist', () => {
      const result = deleteTrackerUrl(99999);
      expect(result.deleted).toBe(false);
      expect(result.error).toMatch(/not found/i);
    });
  });

  describe('non-primary deletion', () => {
    it('deletes a secondary seller without touching the primary', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Primary + secondary',
        url: 'https://amazon.com/dp/A',
        user_id: userId,
      });
      const secondary = addTrackerUrl(tracker.id, 'https://newegg.com/p/B');

      const result = deleteTrackerUrl(secondary.id);
      expect(result.deleted).toBe(true);

      const remaining = getTrackerUrlsForTracker(tracker.id);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].position).toBe(0);
      expect(remaining[0].url).toBe('https://amazon.com/dp/A');

      // trackers.url should still match the primary
      expect(getTrackerById(tracker.id)!.url).toBe('https://amazon.com/dp/A');
    });

    it('deleting a middle seller does not renumber positions', () => {
      // Gaps in position are intentional — the implementation doesn't
      // renumber because gaps are harmless and renumbering risks edge
      // cases. This test locks that choice in so accidental renumbering
      // is caught.
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Three sellers',
        url: 'https://amazon.com/dp/A',
        user_id: userId,
      });
      const s2 = addTrackerUrl(tracker.id, 'https://newegg.com/p/B');
      const s3 = addTrackerUrl(tracker.id, 'https://bhphotovideo.com/c/C');

      expect(getTrackerUrlsForTracker(tracker.id).map(s => s.position)).toEqual([0, 1, 2]);

      deleteTrackerUrl(s2.id);
      const positions = getTrackerUrlsForTracker(tracker.id).map(s => s.position);
      // Gap at position 1 is fine — position 2 stays at position 2
      expect(positions).toEqual([0, 2]);
      void s3;
    });
  });

  describe('primary promotion', () => {
    it('promotes the next-lowest position to primary when the primary is deleted', () => {
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Three sellers',
        url: 'https://amazon.com/dp/A',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      addTrackerUrl(tracker.id, 'https://newegg.com/p/B'); // pos 1
      addTrackerUrl(tracker.id, 'https://bhphotovideo.com/c/C'); // pos 2

      const result = deleteTrackerUrl(primary.id);
      expect(result.deleted).toBe(true);

      const remaining = getTrackerUrlsForTracker(tracker.id);
      expect(remaining).toHaveLength(2);

      // The lowest-position remaining seller should be promoted to 0
      const primaryAfter = remaining.find(s => s.position === 0);
      expect(primaryAfter).toBeDefined();
      expect(primaryAfter!.url).toBe('https://newegg.com/p/B');
    });

    it('syncs trackers.url to the newly promoted primary', () => {
      // This is the critical half that catches "I renamed the tracker_urls
      // row but forgot to update trackers.url" regressions. Category
      // grouping reads tracker.url so any drift breaks the UI silently.
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Primary promotion',
        url: 'https://amazon.com/dp/A',
        user_id: userId,
      });
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      addTrackerUrl(tracker.id, 'https://newegg.com/p/B');

      deleteTrackerUrl(primary.id);

      const refreshed = getTrackerById(tracker.id)!;
      expect(refreshed.url).toBe('https://newegg.com/p/B');
    });

    it('promotes correctly when positions have gaps from previous deletions', () => {
      // Sequence of operations that leaves positions = [0, 2, 3], then
      // delete position 0 and expect position 2 promoted.
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Gapped positions',
        url: 'https://amazon.com/dp/A',
        user_id: userId,
      });
      const s1 = getTrackerUrlsForTracker(tracker.id)[0]; // pos 0
      const s2 = addTrackerUrl(tracker.id, 'https://b.com/2'); // pos 1
      addTrackerUrl(tracker.id, 'https://c.com/3'); // pos 2
      addTrackerUrl(tracker.id, 'https://d.com/4'); // pos 3

      // Delete the secondary at position 1, leaving positions [0, 2, 3]
      deleteTrackerUrl(s2.id);

      // Now delete the primary
      deleteTrackerUrl(s1.id);

      const remaining = getTrackerUrlsForTracker(tracker.id);
      expect(remaining).toHaveLength(2);

      // The new primary should be whatever had the lowest position after
      // the deletions — c.com was at position 2, now promoted to 0.
      const primaryAfter = remaining.find(s => s.position === 0);
      expect(primaryAfter).toBeDefined();
      expect(primaryAfter!.url).toBe('https://c.com/3');
      expect(getTrackerById(tracker.id)!.url).toBe('https://c.com/3');
    });

    it('updates trackers.updated_at when a promotion happens', () => {
      // Sanity: the promotion path sets updated_at so the trackers row
      // reflects recent activity. Not critical but worth locking in.
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'Timestamp check',
        url: 'https://amazon.com/dp/A',
        user_id: userId,
      });
      const originalUpdatedAt = getTrackerById(tracker.id)!.updated_at;
      const primary = getTrackerUrlsForTracker(tracker.id)[0];
      addTrackerUrl(tracker.id, 'https://newegg.com/p/B');

      // sqlite datetime('now') has second resolution so wait just
      // enough to guarantee a different timestamp.
      const start = Date.now();
      while (Date.now() - start < 1100) { /* spin briefly */ }

      deleteTrackerUrl(primary.id);

      const refreshed = getTrackerById(tracker.id)!;
      expect(refreshed.updated_at).not.toBe(originalUpdatedAt);
    });
  });

  describe('foreign-key side effects', () => {
    it('child rows in price_history point to null (ON DELETE SET NULL) not deleted', () => {
      // The migration v4 schema uses ON DELETE SET NULL on the FK from
      // price_history.tracker_url_id → tracker_urls.id so history
      // survives seller deletion. Confirm that contract holds.
      const userId = seedTestUser();
      const tracker = createTracker({
        name: 'History preservation',
        url: 'https://amazon.com/dp/A',
        user_id: userId,
      });
      const s2 = addTrackerUrl(tracker.id, 'https://newegg.com/p/B');

      // Insert a fake price history row attributed to s2
      const db = getDb();
      db.prepare(`
        INSERT INTO price_history (tracker_id, tracker_url_id, price, currency)
        VALUES (?, ?, 50, 'USD')
      `).run(tracker.id, s2.id);

      const historyBefore = db.prepare('SELECT * FROM price_history WHERE tracker_id = ?').all(tracker.id) as Array<{ tracker_url_id: number | null; price: number }>;
      expect(historyBefore).toHaveLength(1);
      expect(historyBefore[0].tracker_url_id).toBe(s2.id);
      expect(historyBefore[0].price).toBe(50);

      deleteTrackerUrl(s2.id);

      // History row should still exist but with tracker_url_id nulled
      const historyAfter = db.prepare('SELECT * FROM price_history WHERE tracker_id = ?').all(tracker.id) as Array<{ tracker_url_id: number | null; price: number }>;
      expect(historyAfter).toHaveLength(1);
      expect(historyAfter[0].tracker_url_id).toBeNull();
      expect(historyAfter[0].price).toBe(50);
    });
  });
});
