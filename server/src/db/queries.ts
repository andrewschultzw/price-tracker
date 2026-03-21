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
}

// --- Trackers ---

export function getAllTrackers(): Tracker[] {
  return getDb().prepare('SELECT * FROM trackers ORDER BY created_at DESC').all() as Tracker[];
}

export function getTrackerById(id: number): Tracker | undefined {
  return getDb().prepare('SELECT * FROM trackers WHERE id = ?').get(id) as Tracker | undefined;
}

export function createTracker(data: {
  name: string;
  url: string;
  threshold_price?: number | null;
  check_interval_minutes?: number;
  css_selector?: string | null;
}): Tracker {
  const stmt = getDb().prepare(`
    INSERT INTO trackers (name, url, threshold_price, check_interval_minutes, css_selector)
    VALUES (@name, @url, @threshold_price, @check_interval_minutes, @css_selector)
  `);
  const result = stmt.run({
    name: data.name,
    url: data.url,
    threshold_price: data.threshold_price ?? null,
    check_interval_minutes: data.check_interval_minutes ?? 360,
    css_selector: data.css_selector ?? null,
  });
  return getTrackerById(Number(result.lastInsertRowid))!;
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
}>): Tracker | undefined {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }

  if (fields.length === 0) return getTrackerById(id);

  fields.push("updated_at = datetime('now')");

  getDb().prepare(`UPDATE trackers SET ${fields.join(', ')} WHERE id = @id`).run(values);
  return getTrackerById(id);
}

export function deleteTracker(id: number): boolean {
  const result = getDb().prepare('DELETE FROM trackers WHERE id = ?').run(id);
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

export function getRecentPricesForAllTrackers(limit: number = 10): Record<number, number[]> {
  const rows = getDb().prepare(`
    SELECT tracker_id, price FROM (
      SELECT tracker_id, price, ROW_NUMBER() OVER (PARTITION BY tracker_id ORDER BY scraped_at DESC) as rn
      FROM price_history
    ) WHERE rn <= ?
    ORDER BY tracker_id, rn DESC
  `).all(limit) as { tracker_id: number; price: number }[];

  const result: Record<number, number[]> = {};
  for (const row of rows) {
    if (!result[row.tracker_id]) result[row.tracker_id] = [];
    result[row.tracker_id].push(row.price);
  }
  return result;
}

// --- Notifications ---

export function addNotification(trackerId: number, price: number, thresholdPrice: number): NotificationRecord {
  const stmt = getDb().prepare(`
    INSERT INTO notifications (tracker_id, price, threshold_price)
    VALUES (?, ?, ?)
  `);
  const result = stmt.run(trackerId, price, thresholdPrice);
  return getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(Number(result.lastInsertRowid)) as NotificationRecord;
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

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
