import { getDb } from './connection.js';
import { runMigrations } from './migrations.js';

export function initializeSchema(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS trackers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      -- "Primary" URL — mirrors the position=0 row of tracker_urls. Kept on
      -- the trackers row so existing frontend code that reads tracker.url
      -- (category grouping, canonical domain) keeps working unchanged.
      url TEXT NOT NULL,
      threshold_price REAL,
      check_interval_minutes INTEGER NOT NULL DEFAULT 360,
      -- Fixed per-tracker random offset added to check_interval_minutes when
      -- deciding if a seller is due. Prevents ~30-50 trackers with identical
      -- intervals from all firing in the same minute and tripping retailer
      -- rate limits. Populated at creation (see queries.ts#createTracker);
      -- never mutated afterward so "check every N min" stays stable per tracker.
      jitter_minutes INTEGER NOT NULL DEFAULT 0,
      css_selector TEXT,
      -- last_price / last_checked_at / last_error / status / consecutive_failures
      -- are aggregates of the per-seller rows in tracker_urls, updated by the
      -- scheduler after each scrape. last_price = min across sellers so the
      -- dashboard card shows the best available price.
      last_price REAL,
      last_checked_at TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'error')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Per-seller rows. Each tracker has >= 1 tracker_urls row. position=0 is
    -- the primary (drives trackers.url and category grouping).
    CREATE TABLE IF NOT EXISTS tracker_urls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      last_price REAL,
      last_checked_at TEXT,
      last_error TEXT,
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'error')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tracker_urls_tracker_id ON tracker_urls(tracker_id);

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
      -- Nullable for historical rows from before multi-URL. New rows always
      -- populate it so per-seller charts work going forward.
      tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
      price REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_price_history_tracker_id ON price_history(tracker_id);
    CREATE INDEX IF NOT EXISTS idx_price_history_scraped_at ON price_history(scraped_at);
    -- idx_price_history_tracker_url_id lives in migration v4 because
    -- pre-existing DBs won't have the column at this point.

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
      tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
      price REAL NOT NULL,
      threshold_price REAL NOT NULL,
      sent_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_tracker_id ON notifications(tracker_id);
    -- idx_notifications_tracker_url_id lives in migration v4 for the same
    -- reason as idx_price_history_tracker_url_id above.

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  runMigrations();
}
