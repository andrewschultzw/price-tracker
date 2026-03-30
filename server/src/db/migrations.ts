import { getDb } from './connection.js';
import { logger } from '../logger.js';

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

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    logger.info({ version: migration.version, description: migration.description }, 'Applying migration');

    db.transaction(() => {
      migration.up();
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    })();

    logger.info({ version: migration.version }, 'Migration applied');
  }
}
