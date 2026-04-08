import { getDb } from './connection.js';

export interface Tracker {
  id: number;
  name: string;
  url: string;
  threshold_price: number | null;
  check_interval_minutes: number;
  css_selector: string | null;
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  status: 'active' | 'paused' | 'error';
  created_at: string;
  updated_at: string;
  user_id: number | null;
}

export interface PriceRecord {
  id: number;
  tracker_id: number;
  price: number;
  currency: string;
  scraped_at: string;
}

export interface NotificationRecord {
  id: number;
  tracker_id: number;
  price: number;
  threshold_price: number;
  sent_at: string;
  channel: string | null;
}

export interface NotificationHistoryRow extends NotificationRecord {
  tracker_name: string;
  tracker_url: string;
}

// --- Trackers ---

export function getAllTrackers(userId: number): Tracker[] {
  return getDb().prepare('SELECT * FROM trackers WHERE user_id = ? ORDER BY created_at DESC').all(userId) as Tracker[];
}

export function getTrackerById(id: number, userId?: number): Tracker | undefined {
  if (userId !== undefined) {
    return getDb().prepare('SELECT * FROM trackers WHERE id = ? AND user_id = ?').get(id, userId) as Tracker | undefined;
  }
  return getDb().prepare('SELECT * FROM trackers WHERE id = ?').get(id) as Tracker | undefined;
}

export function createTracker(data: {
  name: string;
  url: string;
  threshold_price?: number | null;
  check_interval_minutes?: number;
  css_selector?: string | null;
  user_id: number;
}): Tracker {
  const stmt = getDb().prepare(`
    INSERT INTO trackers (name, url, threshold_price, check_interval_minutes, css_selector, user_id)
    VALUES (@name, @url, @threshold_price, @check_interval_minutes, @css_selector, @user_id)
  `);
  const result = stmt.run({
    name: data.name,
    url: data.url,
    threshold_price: data.threshold_price ?? null,
    check_interval_minutes: data.check_interval_minutes ?? 360,
    css_selector: data.css_selector ?? null,
    user_id: data.user_id,
  });
  return getTrackerById(Number(result.lastInsertRowid), data.user_id)!;
}

export function updateTracker(id: number, data: Partial<{
  name: string;
  url: string;
  threshold_price: number | null;
  check_interval_minutes: number;
  css_selector: string | null;
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  status: string;
}>, userId?: number): Tracker | undefined {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }

  if (fields.length === 0) return getTrackerById(id, userId);

  fields.push("updated_at = datetime('now')");

  let where = 'WHERE id = @id';
  if (userId !== undefined) {
    where += ' AND user_id = @userId';
    values.userId = userId;
  }

  getDb().prepare(`UPDATE trackers SET ${fields.join(', ')} ${where}`).run(values);
  return getTrackerById(id, userId);
}

export function deleteTracker(id: number, userId: number): boolean {
  const result = getDb().prepare('DELETE FROM trackers WHERE id = ? AND user_id = ?').run(id, userId);
  return result.changes > 0;
}

export function getDueTrackers(): Tracker[] {
  return getDb().prepare(`
    SELECT * FROM trackers
    WHERE status = 'active'
    AND (
      last_checked_at IS NULL
      OR datetime(last_checked_at, '+' || check_interval_minutes || ' minutes') <= datetime('now')
    )
  `).all() as Tracker[];
}

// --- Price History ---

export function addPriceRecord(trackerId: number, price: number, currency: string = 'USD'): PriceRecord {
  const stmt = getDb().prepare(`
    INSERT INTO price_history (tracker_id, price, currency)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(trackerId, price, currency);
  return getDb().prepare('SELECT * FROM price_history WHERE id = ?').get(Number(result.lastInsertRowid)) as PriceRecord;
}

export function getPriceHistory(trackerId: number, range?: string): PriceRecord[] {
  let dateFilter = '';
  if (range) {
    const match = range.match(/^(\d+)([dhm])$/);
    if (match) {
      const [, num, unit] = match;
      const unitMap: Record<string, string> = { d: 'days', h: 'hours', m: 'minutes' };
      dateFilter = `AND scraped_at >= datetime('now', '-${num} ${unitMap[unit]}')`;
    }
  }
  return getDb().prepare(`
    SELECT * FROM price_history
    WHERE tracker_id = ? ${dateFilter}
    ORDER BY scraped_at ASC
  `).all(trackerId) as PriceRecord[];
}

export function getRecentPricesForAllTrackers(userId: number, limit: number = 10): Record<number, number[]> {
  const rows = getDb().prepare(`
    SELECT ph.tracker_id, ph.price FROM (
      SELECT tracker_id, price, ROW_NUMBER() OVER (PARTITION BY tracker_id ORDER BY scraped_at DESC) as rn
      FROM price_history
      WHERE tracker_id IN (SELECT id FROM trackers WHERE user_id = ?)
    ) ph WHERE ph.rn <= ?
    ORDER BY ph.tracker_id, ph.rn DESC
  `).all(userId, limit) as { tracker_id: number; price: number }[];

  const result: Record<number, number[]> = {};
  for (const row of rows) {
    if (!result[row.tracker_id]) result[row.tracker_id] = [];
    result[row.tracker_id].push(row.price);
  }
  return result;
}

export interface TrackerStat {
  sparkline: number[];
  min_price: number | null;
  min_price_at: string | null;
}

/**
 * Combined per-tracker stats powering the Dashboard card visuals: the
 * recent-price sparkline and the all-time low (with timestamp). Merged into
 * one query pair so the Dashboard doesn't need a separate round-trip.
 */
export function getTrackerStats(userId: number, sparklineLimit: number = 10): Record<number, TrackerStat> {
  const db = getDb();

  const sparkRows = db.prepare(`
    SELECT ph.tracker_id, ph.price FROM (
      SELECT tracker_id, price, ROW_NUMBER() OVER (PARTITION BY tracker_id ORDER BY scraped_at DESC) as rn
      FROM price_history
      WHERE tracker_id IN (SELECT id FROM trackers WHERE user_id = ?)
    ) ph WHERE ph.rn <= ?
    ORDER BY ph.tracker_id, ph.rn DESC
  `).all(userId, sparklineLimit) as { tracker_id: number; price: number }[];

  // All-time low per tracker, plus the earliest timestamp at which that low
  // was reached. Window function picks the row with the smallest price per
  // tracker, ties broken by earliest scrape time.
  const lowRows = db.prepare(`
    SELECT tracker_id, min_price, min_price_at FROM (
      SELECT
        tracker_id,
        price as min_price,
        scraped_at as min_price_at,
        ROW_NUMBER() OVER (PARTITION BY tracker_id ORDER BY price ASC, scraped_at ASC) as rn
      FROM price_history
      WHERE tracker_id IN (SELECT id FROM trackers WHERE user_id = ?)
    ) WHERE rn = 1
  `).all(userId) as { tracker_id: number; min_price: number; min_price_at: string }[];

  const result: Record<number, TrackerStat> = {};
  for (const row of sparkRows) {
    if (!result[row.tracker_id]) result[row.tracker_id] = { sparkline: [], min_price: null, min_price_at: null };
    result[row.tracker_id].sparkline.push(row.price);
  }
  for (const row of lowRows) {
    if (!result[row.tracker_id]) result[row.tracker_id] = { sparkline: [], min_price: null, min_price_at: null };
    result[row.tracker_id].min_price = row.min_price;
    result[row.tracker_id].min_price_at = row.min_price_at;
  }
  return result;
}

// --- Notifications ---

export function addNotification(
  trackerId: number,
  price: number,
  thresholdPrice: number,
  channel: string | null = null,
): NotificationRecord {
  const stmt = getDb().prepare(`
    INSERT INTO notifications (tracker_id, price, threshold_price, channel)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(trackerId, price, thresholdPrice, channel);
  return getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(Number(result.lastInsertRowid)) as NotificationRecord;
}

/**
 * Notification history for a user, joining in tracker name/url so the UI can
 * render the full history in a single round-trip. Optional trackerId filter
 * powers the per-tracker "Recent Alerts" section on TrackerDetail.
 */
export function getNotificationHistory(
  userId: number,
  trackerId?: number,
  limit: number = 100,
): NotificationHistoryRow[] {
  const db = getDb();
  if (trackerId !== undefined) {
    return db.prepare(`
      SELECT n.*, t.name as tracker_name, t.url as tracker_url
      FROM notifications n
      INNER JOIN trackers t ON t.id = n.tracker_id
      WHERE t.user_id = ? AND n.tracker_id = ?
      ORDER BY n.sent_at DESC
      LIMIT ?
    `).all(userId, trackerId, limit) as NotificationHistoryRow[];
  }
  return db.prepare(`
    SELECT n.*, t.name as tracker_name, t.url as tracker_url
    FROM notifications n
    INNER JOIN trackers t ON t.id = n.tracker_id
    WHERE t.user_id = ?
    ORDER BY n.sent_at DESC
    LIMIT ?
  `).all(userId, limit) as NotificationHistoryRow[];
}

export function getLastNotification(trackerId: number): NotificationRecord | undefined {
  return getDb().prepare(`
    SELECT * FROM notifications
    WHERE tracker_id = ?
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(trackerId) as NotificationRecord | undefined;
}

// --- Settings ---

import { encrypt, decrypt, isEncrypted } from '../crypto/settings-crypto.js';

// Only these three keys are encrypted at rest. Any other setting key would
// be stored plaintext as before — add to this set if you introduce another
// credential-like setting.
const ENCRYPTED_KEYS = new Set(['discord_webhook_url', 'ntfy_url', 'generic_webhook_url']);

function maybeDecrypt(key: string, value: string): string {
  if (!ENCRYPTED_KEYS.has(key)) return value;
  // Old rows from before migration v3 may still be plaintext if the
  // migration was skipped or for a setting added before encryption shipped.
  // Only decrypt values that carry our version prefix.
  if (!isEncrypted(value)) return value;
  return decrypt(value);
}

function maybeEncrypt(key: string, value: string): string {
  if (!ENCRYPTED_KEYS.has(key)) return value;
  // Empty string means "unset" — don't encrypt the empty string, just store
  // it as-is so the UI can show a blank field.
  if (value === '') return value;
  return encrypt(value);
}

export function getSetting(key: string, userId?: number | null): string | undefined {
  let raw: string | undefined;
  if (userId !== undefined && userId !== null) {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ? AND user_id = ?').get(key, userId) as { value: string } | undefined;
    raw = row?.value;
  } else {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ? AND user_id IS NULL').get(key) as { value: string } | undefined;
    raw = row?.value;
  }
  if (raw === undefined) return undefined;
  return maybeDecrypt(key, raw);
}

export function setSetting(key: string, value: string, userId?: number | null): void {
  const stored = maybeEncrypt(key, value);
  if (userId !== undefined && userId !== null) {
    getDb().prepare(`
      INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?)
      ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
    `).run(userId, key, stored);
  } else {
    const db = getDb();
    db.prepare('DELETE FROM settings WHERE key = ? AND user_id IS NULL').run(key);
    db.prepare('INSERT INTO settings (user_id, key, value) VALUES (NULL, ?, ?)').run(key, stored);
  }
}

export function getAllSettings(userId: number): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings WHERE user_id = ?').all(userId) as { key: string; value: string }[];
  return Object.fromEntries(rows.map(r => [r.key, maybeDecrypt(r.key, r.value)]));
}
