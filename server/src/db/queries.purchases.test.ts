import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import {
  createPurchase,
  listPurchases,
  getPurchase,
  updatePurchase,
  deletePurchase,
  getSavingsSummary,
  createTracker,
  getTrackerById,
} from './queries.js';

/**
 * Test helpers — `createTracker` doesn't take `last_price` and `addPriceRecord`
 * doesn't accept a custom timestamp, so the tests poke the DB directly for
 * those two specific concerns (matching the pattern in queries.project.test.ts).
 */
function seedUser(email = 't@x.com'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', 'T', 'user', 1)`,
  ).run(email).lastInsertRowid);
}

function setLastPrice(trackerId: number, price: number): void {
  getDb().prepare('UPDATE trackers SET last_price = ? WHERE id = ?').run(price, trackerId);
}

function addHistory(trackerId: number, price: number, scrapedAt: string): void {
  getDb().prepare(
    `INSERT INTO price_history (tracker_id, tracker_url_id, price, currency, scraped_at)
     VALUES (?, NULL, ?, 'USD', ?)`,
  ).run(trackerId, price, scrapedAt);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  _setDbForTesting(db);
  initializeSchema();
});

describe('purchase queries', () => {
  describe('createPurchase', () => {
    it('snapshots first_price from earliest price_history row', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/a', user_id: userId, name: 'Widget' });
      addHistory(t.id, 100, '2026-01-01T00:00:00Z');
      addHistory(t.id, 80,  '2026-02-01T00:00:00Z');
      addHistory(t.id, 60,  '2026-03-01T00:00:00Z');

      const p = createPurchase(t.id, { purchase_price: 50 }, { keep_watching: false });

      expect(p.first_price).toBe(100);
      expect(p.purchase_price).toBe(50);
      expect(p.quantity).toBe(1);
      expect(getTrackerById(t.id)?.status).toBe('purchased');
    });

    it('falls back to tracker.last_price when no price history exists', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/b', user_id: userId, name: 'NoHistory' });
      setLastPrice(t.id, 42);
      const p = createPurchase(t.id, { purchase_price: 30 }, { keep_watching: false });
      expect(p.first_price).toBe(42);
    });

    it('last-resort first_price = purchase_price when no history and no last_price', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/c', user_id: userId, name: 'Empty' });
      const p = createPurchase(t.id, { purchase_price: 25 }, { keep_watching: false });
      expect(p.first_price).toBe(25);
    });

    it('leaves tracker active when keep_watching=true', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/d', user_id: userId, name: 'Repeat' });
      setLastPrice(t.id, 50);
      createPurchase(t.id, { purchase_price: 40 }, { keep_watching: true });
      expect(getTrackerById(t.id)?.status).toBe('active');
    });

    it('appends a second purchase to an already-purchased tracker', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/e', user_id: userId, name: 'Multi' });
      setLastPrice(t.id, 50);
      createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
      createPurchase(t.id, { purchase_price: 35 }, { keep_watching: false });
      const all = listPurchases({ user_id: userId });
      expect(all.purchases.filter(p => p.tracker_id === t.id)).toHaveLength(2);
    });
  });

  describe('getSavingsSummary', () => {
    it('sums savings clamped at $0 for negative deltas', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/f', user_id: userId, name: 'Bad Deal' });
      setLastPrice(t.id, 50);
      addHistory(t.id, 100, '2026-01-01T00:00:00Z');
      createPurchase(t.id, { purchase_price: 120, quantity: 1 }, { keep_watching: false });
      const s = getSavingsSummary();
      expect(s.total_saved).toBe(0);
      expect(s.purchase_count).toBe(1);
    });

    it('multiplies savings by quantity', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/g', user_id: userId, name: 'Bulk' });
      setLastPrice(t.id, 100);
      addHistory(t.id, 100, '2026-01-01T00:00:00Z');
      createPurchase(t.id, { purchase_price: 50, quantity: 3 }, { keep_watching: false });
      const s = getSavingsSummary();
      expect(s.total_saved).toBe(150);
    });
  });

  describe('deletePurchase', () => {
    it('reverts tracker to active when deleting the only purchase', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/h', user_id: userId, name: 'Solo' });
      setLastPrice(t.id, 50);
      const p = createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
      expect(getTrackerById(t.id)?.status).toBe('purchased');
      deletePurchase(p.id);
      expect(getTrackerById(t.id)?.status).toBe('active');
    });

    it('leaves tracker purchased when other purchases remain', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/i', user_id: userId, name: 'Many' });
      setLastPrice(t.id, 50);
      createPurchase(t.id, { purchase_price: 45 }, { keep_watching: false });
      const second = createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
      deletePurchase(second.id);
      expect(getTrackerById(t.id)?.status).toBe('purchased');
    });
  });

  describe('getPurchase / updatePurchase', () => {
    it('returns undefined for unknown id', () => {
      expect(getPurchase(9999)).toBeUndefined();
    });

    it('updates quantity and purchase_price', () => {
      const userId = seedUser();
      const t = createTracker({ url: 'https://example.com/j', user_id: userId, name: 'Patch' });
      setLastPrice(t.id, 50);
      const p = createPurchase(t.id, { purchase_price: 40 }, { keep_watching: false });
      const u = updatePurchase(p.id, { purchase_price: 30, quantity: 2 });
      expect(u.purchase_price).toBe(30);
      expect(u.quantity).toBe(2);
    });
  });
});
