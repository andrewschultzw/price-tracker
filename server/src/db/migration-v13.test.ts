import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';
import { buildSlug } from '../lib/build-slug.js';

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
});

describe('migration v13 — public_product_slugs', () => {
  it('creates the table with expected columns and the index', () => {
    initializeSchema();
    const cols = (getDb()
      .prepare(`PRAGMA table_info(public_product_slugs)`)
      .all() as Array<{ name: string }>).map(c => c.name).sort();
    expect(cols).toEqual(['created_at', 'display_name', 'normalized_url', 'slug']);

    const indexes = (getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='public_product_slugs'`)
      .all() as Array<{ name: string }>).map(i => i.name);
    expect(indexes).toContain('idx_public_product_slugs_normalized_url');
  });

  it('enforces normalized_url uniqueness', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO public_product_slugs (slug, normalized_url, display_name, created_at)
                VALUES (?, ?, ?, ?)`).run('a-aaaaaa', 'amazon.com/dp/X', 'A', Date.now());
    expect(() =>
      db.prepare(`INSERT INTO public_product_slugs (slug, normalized_url, display_name, created_at)
                  VALUES (?, ?, ?, ?)`).run('b-bbbbbb', 'amazon.com/dp/X', 'B', Date.now()),
    ).toThrow(/UNIQUE/);
  });

  it('backfills one slug row per distinct normalized_url, picking newest tracker name', () => {
    // Seed pre-migration state by initializing the schema (which runs all
    // migrations up to current). Then INSERT trackers and re-run the v13
    // migration body manually. Easier: initialize fresh, then verify via
    // a synthetic seeding of trackers + manual rerun.
    const db = getDb();
    initializeSchema();
    // After initializeSchema, v13 has run with 0 trackers — so the table is empty.
    expect((db.prepare(`SELECT COUNT(*) AS n FROM public_product_slugs`).get() as { n: number }).n).toBe(0);

    // Seed two trackers sharing one normalized_url + a third on a different URL.
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO trackers (name, url, normalized_url, user_id, created_at)
                VALUES ('Old Name', 'https://amazon.com/dp/B0AAA', 'amazon.com/dp/b0aaa', 1, '2024-01-01')`).run();
    db.prepare(`INSERT INTO trackers (name, url, normalized_url, user_id, created_at)
                VALUES ('New Name', 'https://amazon.com/dp/B0AAA', 'amazon.com/dp/b0aaa', 1, '2025-01-01')`).run();
    db.prepare(`INSERT INTO trackers (name, url, normalized_url, user_id, created_at)
                VALUES ('Other', 'https://newegg.com/p/N1', 'newegg.com/p/n1', 1, '2024-06-01')`).run();
    db.prepare(`INSERT INTO trackers (name, url, normalized_url, user_id, created_at)
                VALUES ('No URL', 'https://garbage', NULL, 1, '2024-06-01')`).run();

    // Re-run migration v13 by force: clear the version row and reapply.
    db.prepare(`DELETE FROM schema_migrations WHERE version = 13`).run();
    db.prepare(`DELETE FROM public_product_slugs`).run();
    // Re-run schema init which will apply v13 again.
    initializeSchema();

    const rows = db.prepare(`SELECT * FROM public_product_slugs ORDER BY normalized_url`).all() as Array<{
      slug: string; normalized_url: string; display_name: string; created_at: number;
    }>;
    expect(rows).toHaveLength(2);
    // Picked the NEWEST display_name for the duplicated normalized_url.
    const amazonRow = rows.find(r => r.normalized_url === 'amazon.com/dp/b0aaa')!;
    expect(amazonRow.display_name).toBe('New Name');
    expect(amazonRow.slug).toBe(buildSlug('New Name', 'amazon.com/dp/b0aaa'));
    // The newegg row exists.
    const neweggRow = rows.find(r => r.normalized_url === 'newegg.com/p/n1')!;
    expect(neweggRow.display_name).toBe('Other');
    // Tracker with NULL normalized_url is skipped (not represented).
    expect(rows.find(r => r.display_name === 'No URL')).toBeUndefined();
  });

  it('migration is idempotent — running again does not duplicate rows or throw', () => {
    initializeSchema();
    const db = getDb();
    db.prepare(`INSERT INTO users (email, password_hash, display_name, role, is_active)
                VALUES ('a@x.com','h','A','user',1)`).run();
    db.prepare(`INSERT INTO trackers (name, url, normalized_url, user_id)
                VALUES ('T', 'https://amazon.com/dp/B0AAA', 'amazon.com/dp/b0aaa', 1)`).run();

    // First reapply.
    db.prepare(`DELETE FROM schema_migrations WHERE version = 13`).run();
    initializeSchema();
    const first = (db.prepare(`SELECT COUNT(*) AS n FROM public_product_slugs`).get() as { n: number }).n;

    // Second reapply.
    db.prepare(`DELETE FROM schema_migrations WHERE version = 13`).run();
    expect(() => initializeSchema()).not.toThrow();
    const second = (db.prepare(`SELECT COUNT(*) AS n FROM public_product_slugs`).get() as { n: number }).n;
    expect(second).toBe(first);
  });
});
