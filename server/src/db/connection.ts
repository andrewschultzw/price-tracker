import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dirname(config.databasePath), { recursive: true });
    db = new Database(config.databasePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

/**
 * Test-only: replace the singleton DB handle. Pass a fresh
 * `new Database(':memory:')` instance in a beforeEach hook to give each
 * test a clean database, then call `_setDbForTesting(null)` in afterEach
 * to close it. Production code path is untouched.
 */
export function _setDbForTesting(testDb: Database.Database | null): void {
  if (db && db !== testDb) {
    try { db.close(); } catch { /* ignore — already closed */ }
  }
  db = testDb;
}
