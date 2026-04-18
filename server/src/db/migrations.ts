import { getDb } from './connection.js';
import { logger } from '../logger.js';
import { encrypt, isEncrypted } from '../crypto/settings-crypto.js';

interface Migration {
  version: number;
  description: string;
  up: () => void;
}

const migrations: Migration[] = [
  {
    version: 1,
    description: 'Add user accounts, invite codes, refresh tokens',
    up: () => {
      const db = getDb();

      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          display_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS invite_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          code TEXT UNIQUE NOT NULL,
          created_by INTEGER REFERENCES users(id),
          used_by INTEGER REFERENCES users(id),
          expires_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_invite_codes_created_by ON invite_codes(created_by);
        CREATE INDEX IF NOT EXISTS idx_invite_codes_used_by ON invite_codes(used_by);

        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT UNIQUE NOT NULL,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);
        CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires_at ON refresh_tokens(expires_at);
      `);

      // Add user_id to trackers (nullable for migration)
      const trackerCols = db.prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
      if (!trackerCols.some(c => c.name === 'user_id')) {
        db.exec('ALTER TABLE trackers ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE');
        db.exec('CREATE INDEX IF NOT EXISTS idx_trackers_user_id ON trackers(user_id)');
      }

      // Recreate settings table with composite PK (user_id, key)
      const settingsCols = db.prepare("PRAGMA table_info(settings)").all() as { name: string }[];
      if (!settingsCols.some(c => c.name === 'user_id')) {
        db.exec(`
          CREATE TABLE settings_new (
            user_id INTEGER,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY (user_id, key)
          );
          INSERT INTO settings_new (user_id, key, value)
            SELECT NULL, key, value FROM settings;
          DROP TABLE settings;
          ALTER TABLE settings_new RENAME TO settings;
        `);
      }
    },
  },
  {
    version: 2,
    description: 'Record notification channel per alert',
    up: () => {
      const db = getDb();
      const cols = db.prepare("PRAGMA table_info(notifications)").all() as { name: string }[];
      if (!cols.some(c => c.name === 'channel')) {
        // Nullable so pre-migration rows (which don't know which channel fired)
        // just show as "unknown" in the UI.
        db.prepare('ALTER TABLE notifications ADD COLUMN channel TEXT').run();
      }
      db.prepare('CREATE INDEX IF NOT EXISTS idx_notifications_sent_at ON notifications(sent_at)').run();
    },
  },
  {
    version: 4,
    description: 'Multi-seller support: tracker_urls table + backfill existing trackers',
    up: () => {
      const db = getDb();

      // Create tracker_urls if it doesn't already exist (schema.ts creates
      // it for fresh installs; migration is for pre-existing DBs).
      db.prepare(`
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
        )
      `).run();
      db.prepare('CREATE INDEX IF NOT EXISTS idx_tracker_urls_tracker_id ON tracker_urls(tracker_id)').run();

      // Add nullable foreign keys to the child tables if missing.
      const phCols = db.prepare("PRAGMA table_info(price_history)").all() as { name: string }[];
      if (!phCols.some(c => c.name === 'tracker_url_id')) {
        db.prepare('ALTER TABLE price_history ADD COLUMN tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL').run();
        db.prepare('CREATE INDEX IF NOT EXISTS idx_price_history_tracker_url_id ON price_history(tracker_url_id)').run();
      }

      const nCols = db.prepare("PRAGMA table_info(notifications)").all() as { name: string }[];
      if (!nCols.some(c => c.name === 'tracker_url_id')) {
        db.prepare('ALTER TABLE notifications ADD COLUMN tracker_url_id INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL').run();
        db.prepare('CREATE INDEX IF NOT EXISTS idx_notifications_tracker_url_id ON notifications(tracker_url_id)').run();
      }

      // Backfill: for each existing tracker that doesn't already have a
      // tracker_urls row, create a primary (position=0) row copying the
      // per-seller state that used to live on the trackers row itself.
      const trackersNeedingBackfill = db.prepare(`
        SELECT t.id, t.url, t.last_price, t.last_checked_at, t.last_error,
               t.consecutive_failures, t.status, t.created_at, t.updated_at
        FROM trackers t
        LEFT JOIN tracker_urls tu ON tu.tracker_id = t.id AND tu.position = 0
        WHERE tu.id IS NULL
      `).all() as Array<{
        id: number; url: string; last_price: number | null; last_checked_at: string | null;
        last_error: string | null; consecutive_failures: number; status: string;
        created_at: string; updated_at: string;
      }>;

      const insertTu = db.prepare(`
        INSERT INTO tracker_urls (
          tracker_id, url, position, last_price, last_checked_at, last_error,
          consecutive_failures, status, created_at, updated_at
        ) VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const t of trackersNeedingBackfill) {
        insertTu.run(
          t.id, t.url, t.last_price, t.last_checked_at, t.last_error,
          t.consecutive_failures, t.status, t.created_at, t.updated_at,
        );
      }
      logger.info({ count: trackersNeedingBackfill.length }, 'Backfilled tracker_urls primary rows');

      // Point existing price_history and notifications rows at the primary
      // tracker_url for their tracker. Only touches rows where
      // tracker_url_id is still NULL (idempotent).
      const phBackfill = db.prepare(`
        UPDATE price_history
        SET tracker_url_id = (
          SELECT id FROM tracker_urls
          WHERE tracker_urls.tracker_id = price_history.tracker_id AND position = 0
        )
        WHERE tracker_url_id IS NULL
      `).run();
      const nBackfill = db.prepare(`
        UPDATE notifications
        SET tracker_url_id = (
          SELECT id FROM tracker_urls
          WHERE tracker_urls.tracker_id = notifications.tracker_id AND position = 0
        )
        WHERE tracker_url_id IS NULL
      `).run();
      logger.info(
        { priceHistoryRows: phBackfill.changes, notificationRows: nBackfill.changes },
        'Backfilled tracker_url_id on child tables',
      );
    },
  },
  {
    version: 3,
    description: 'Encrypt sensitive settings (webhook URLs) at rest',
    up: () => {
      // initSettingsCrypto() must have been called before runMigrations()
      // (see server/src/index.ts startup order).
      const db = getDb();
      const ENCRYPTED_KEYS = ['discord_webhook_url', 'ntfy_url', 'generic_webhook_url'];

      const rows = db.prepare(
        `SELECT rowid, user_id, key, value FROM settings WHERE key IN (${ENCRYPTED_KEYS.map(() => '?').join(',')})`,
      ).all(...ENCRYPTED_KEYS) as { rowid: number; user_id: number | null; key: string; value: string }[];

      const update = db.prepare('UPDATE settings SET value = ? WHERE rowid = ?');
      let encryptedCount = 0;
      for (const row of rows) {
        if (!row.value) continue;              // skip empty
        if (isEncrypted(row.value)) continue;  // already encrypted — idempotent re-run
        const ciphertext = encrypt(row.value);
        update.run(ciphertext, row.rowid);
        encryptedCount++;
      }
      logger.info({ encryptedCount }, 'Encrypted existing webhook settings rows');
    },
  },
  {
    version: 5,
    description: 'Add jitter_minutes to trackers to spread scheduled checks',
    up: () => {
      const db = getDb();
      const cols = db.prepare("PRAGMA table_info(trackers)").all() as { name: string }[];
      if (!cols.some(c => c.name === 'jitter_minutes')) {
        db.prepare('ALTER TABLE trackers ADD COLUMN jitter_minutes INTEGER NOT NULL DEFAULT 0').run();
      }
      // Backfill: give every existing tracker a per-tracker offset so a DB
      // imported mid-flight also gets spread. Formula matches createTracker
      // in queries.ts — keep these in sync.
      const rows = db.prepare('SELECT id, check_interval_minutes FROM trackers WHERE jitter_minutes = 0').all() as { id: number; check_interval_minutes: number }[];
      const update = db.prepare('UPDATE trackers SET jitter_minutes = ? WHERE id = ?');
      for (const r of rows) {
        const cap = Math.min(Math.floor(r.check_interval_minutes / 6), 30);
        const jitter = cap > 0 ? Math.floor(Math.random() * (cap + 1)) : 0;
        update.run(jitter, r.id);
      }
      logger.info({ backfilled: rows.length }, 'Backfilled jitter_minutes for existing trackers');
    },
  },
];

export function runMigrations(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[])
      .map(r => r.version)
  );

  // Run in numeric order regardless of source order in the array.
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  for (const migration of sorted) {
    if (applied.has(migration.version)) continue;

    logger.info({ version: migration.version, description: migration.description }, 'Applying migration');

    db.transaction(() => {
      migration.up();
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    })();

    logger.info({ version: migration.version }, 'Migration applied');
  }
}
