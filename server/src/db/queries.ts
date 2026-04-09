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

// Per-seller row. Each tracker has >= 1 tracker_urls rows; position=0 is
// the primary (drives trackers.url and category grouping).
export interface TrackerUrl {
  id: number;
  tracker_id: number;
  url: string;
  position: number;
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  status: 'active' | 'paused' | 'error';
  created_at: string;
  updated_at: string;
}

// Returned by the admin/user tracker list API so the client can show per-
// tracker aggregates (seller count, errored seller count, best seller) in
// one round-trip instead of fetching tracker_urls separately.
export interface TrackerWithSellerSummary extends Tracker {
  seller_count: number;
  errored_seller_count: number;
  // The seller currently offering the lowest price (non-null last_price).
  // Drives the dashboard card's "@ seller" indicator.
  best_seller_url: string | null;
}

export interface PriceRecord {
  id: number;
  tracker_id: number;
  tracker_url_id: number | null;
  price: number;
  currency: string;
  scraped_at: string;
}

export interface NotificationRecord {
  id: number;
  tracker_id: number;
  tracker_url_id: number | null;
  price: number;
  threshold_price: number;
  sent_at: string;
  channel: string | null;
}

export interface NotificationHistoryRow extends NotificationRecord {
  tracker_name: string;
  tracker_url: string;
  // URL of the specific seller that triggered the alert, if known.
  // (Historical pre-migration rows may have this null.)
  seller_url: string | null;
}

// --- Trackers ---

export function getAllTrackers(userId: number): TrackerWithSellerSummary[] {
  // Single query returns tracker row + aggregated per-seller stats so the
  // Dashboard never needs a second round-trip for seller counts or the
  // "best seller" indicator.
  return getDb().prepare(`
    SELECT
      t.*,
      COALESCE(agg.seller_count, 0) as seller_count,
      COALESCE(agg.errored_seller_count, 0) as errored_seller_count,
      best.url as best_seller_url
    FROM trackers t
    LEFT JOIN (
      SELECT
        tracker_id,
        COUNT(*) as seller_count,
        SUM(CASE WHEN status = 'error' OR (last_error IS NOT NULL AND consecutive_failures > 0) THEN 1 ELSE 0 END) as errored_seller_count
      FROM tracker_urls
      GROUP BY tracker_id
    ) agg ON agg.tracker_id = t.id
    LEFT JOIN (
      -- Pick the seller with the lowest current last_price per tracker;
      -- ties broken by position (primary wins). ROW_NUMBER window function
      -- gives deterministic selection.
      SELECT tracker_id, url FROM (
        SELECT tracker_id, url,
          ROW_NUMBER() OVER (PARTITION BY tracker_id ORDER BY last_price ASC, position ASC) as rn
        FROM tracker_urls
        WHERE last_price IS NOT NULL
      ) WHERE rn = 1
    ) best ON best.tracker_id = t.id
    WHERE t.user_id = ?
    ORDER BY t.created_at DESC
  `).all(userId) as TrackerWithSellerSummary[];
}

export function getTrackerById(id: number, userId?: number): Tracker | undefined {
  if (userId !== undefined) {
    return getDb().prepare('SELECT * FROM trackers WHERE id = ? AND user_id = ?').get(id, userId) as Tracker | undefined;
  }
  return getDb().prepare('SELECT * FROM trackers WHERE id = ?').get(id) as Tracker | undefined;
}

/**
 * Create a tracker with its primary seller URL in one transaction. The
 * primary URL is also stored on the trackers row itself so existing
 * frontend code that reads `tracker.url` (category grouping, favicons)
 * keeps working.
 */
export function createTracker(data: {
  name: string;
  url: string;
  threshold_price?: number | null;
  check_interval_minutes?: number;
  css_selector?: string | null;
  user_id: number;
}): Tracker {
  const db = getDb();
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO trackers (name, url, threshold_price, check_interval_minutes, css_selector, user_id)
      VALUES (@name, @url, @threshold_price, @check_interval_minutes, @css_selector, @user_id)
    `).run({
      name: data.name,
      url: data.url,
      threshold_price: data.threshold_price ?? null,
      check_interval_minutes: data.check_interval_minutes ?? 360,
      css_selector: data.css_selector ?? null,
      user_id: data.user_id,
    });
    const trackerId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, ?, 0)
    `).run(trackerId, data.url);
    return getTrackerById(trackerId, data.user_id)!;
  })();
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

// --- Tracker URLs (sellers) ---

export interface DueTrackerUrl extends TrackerUrl {
  tracker_check_interval_minutes: number;
  tracker_user_id: number | null;
}

/**
 * Find all seller rows that are due for a check. Due means the parent
 * tracker is active (not paused) and either we've never scraped this
 * seller or it's been more than check_interval_minutes since last check.
 * The seller itself doesn't need to be status='active' — we still retry
 * errored sellers on each cycle so they can self-heal (the scrape retry
 * already handles transient failures).
 */
export function getDueTrackerUrls(): DueTrackerUrl[] {
  return getDb().prepare(`
    SELECT tu.*,
           t.check_interval_minutes as tracker_check_interval_minutes,
           t.user_id as tracker_user_id
    FROM tracker_urls tu
    INNER JOIN trackers t ON t.id = tu.tracker_id
    WHERE t.status != 'paused' AND tu.status != 'paused'
    AND (
      tu.last_checked_at IS NULL
      OR datetime(tu.last_checked_at, '+' || t.check_interval_minutes || ' minutes') <= datetime('now')
    )
  `).all() as DueTrackerUrl[];
}

export function getTrackerUrlById(id: number): TrackerUrl | undefined {
  return getDb().prepare('SELECT * FROM tracker_urls WHERE id = ?').get(id) as TrackerUrl | undefined;
}

export function getTrackerUrlsForTracker(trackerId: number): TrackerUrl[] {
  return getDb().prepare(
    'SELECT * FROM tracker_urls WHERE tracker_id = ? ORDER BY position ASC',
  ).all(trackerId) as TrackerUrl[];
}

/**
 * Add a new seller URL to an existing tracker. Assigned the next-highest
 * position number so ordering is stable and the primary (position=0) never
 * shifts. Caller must verify tracker ownership before calling.
 */
export function addTrackerUrl(trackerId: number, url: string): TrackerUrl {
  const db = getDb();
  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) as mp FROM tracker_urls WHERE tracker_id = ?',
  ).get(trackerId) as { mp: number };
  const nextPos = maxPos.mp + 1;
  const result = db.prepare(
    'INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, ?, ?)',
  ).run(trackerId, url, nextPos);
  return getTrackerUrlById(Number(result.lastInsertRowid))!;
}

/**
 * Delete a seller URL. Refuses to delete the last remaining seller for a
 * tracker — every tracker must keep at least one URL. If the primary
 * (position=0) is deleted, the next-lowest position is promoted to primary
 * and the tracker's `url` field is updated to match.
 */
export function deleteTrackerUrl(id: number): { deleted: boolean; error?: string } {
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM tracker_urls WHERE id = ?').get(id) as TrackerUrl | undefined;
    if (!row) return { deleted: false, error: 'Seller not found' };

    const siblings = db.prepare(
      'SELECT COUNT(*) as c FROM tracker_urls WHERE tracker_id = ?',
    ).get(row.tracker_id) as { c: number };
    if (siblings.c <= 1) {
      return { deleted: false, error: 'Cannot delete the last remaining seller for a tracker' };
    }

    db.prepare('DELETE FROM tracker_urls WHERE id = ?').run(id);

    // If we just deleted the primary, promote the next-lowest position to
    // primary (position=0) and sync trackers.url.
    if (row.position === 0) {
      const next = db.prepare(
        'SELECT id, url FROM tracker_urls WHERE tracker_id = ? ORDER BY position ASC LIMIT 1',
      ).get(row.tracker_id) as { id: number; url: string };
      db.prepare('UPDATE tracker_urls SET position = 0 WHERE id = ?').run(next.id);
      db.prepare('UPDATE trackers SET url = ?, updated_at = datetime(\'now\') WHERE id = ?').run(next.url, row.tracker_id);
    }
    return { deleted: true };
  })();
}

/**
 * Update scrape state on a single seller row. Called by the scheduler
 * after each per-seller check. Does not touch trackers.url or anything
 * that belongs to the parent tracker; that aggregation happens separately
 * in refreshTrackerAggregates().
 */
export function updateTrackerUrl(id: number, data: Partial<{
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  status: string;
}>): TrackerUrl | undefined {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return getTrackerUrlById(id);
  fields.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE tracker_urls SET ${fields.join(', ')} WHERE id = @id`).run(values);
  return getTrackerUrlById(id);
}

/**
 * Recompute the tracker-level aggregate fields from its seller rows.
 * Rules:
 *   - last_price    = MIN non-null across sellers
 *   - last_checked_at = MAX across sellers
 *   - status        = 'error' if all sellers errored, else 'paused' if all
 *                     paused, else 'active'
 *   - last_error    = first non-null last_error (for quick "something's
 *                     wrong" surfacing)
 *   - consecutive_failures = MAX across sellers
 * Called by the scheduler after updating any seller.
 */
export function refreshTrackerAggregates(trackerId: number): void {
  const db = getDb();
  const sellers = db.prepare('SELECT * FROM tracker_urls WHERE tracker_id = ?').all(trackerId) as TrackerUrl[];
  if (sellers.length === 0) return;

  const withPrice = sellers.filter(s => s.last_price != null);
  const minPrice = withPrice.length > 0 ? Math.min(...withPrice.map(s => s.last_price!)) : null;
  const maxChecked = sellers
    .map(s => s.last_checked_at)
    .filter((v): v is string => v != null)
    .sort()
    .pop() ?? null;

  const statuses = new Set(sellers.map(s => s.status));
  let aggStatus: 'active' | 'paused' | 'error';
  if (statuses.size === 1 && statuses.has('error')) aggStatus = 'error';
  else if (statuses.size === 1 && statuses.has('paused')) aggStatus = 'paused';
  else aggStatus = 'active';

  const firstError = sellers.find(s => s.last_error != null)?.last_error ?? null;
  const maxFailures = Math.max(...sellers.map(s => s.consecutive_failures));

  db.prepare(`
    UPDATE trackers
    SET last_price = ?, last_checked_at = ?, status = ?,
        last_error = ?, consecutive_failures = ?,
        updated_at = datetime('now')
    WHERE id = ?
  `).run(minPrice, maxChecked, aggStatus, firstError, maxFailures, trackerId);
}

// --- Price History ---

export function addPriceRecord(
  trackerId: number,
  price: number,
  currency: string = 'USD',
  trackerUrlId: number | null = null,
): PriceRecord {
  const stmt = getDb().prepare(`
    INSERT INTO price_history (tracker_id, tracker_url_id, price, currency)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(trackerId, trackerUrlId, price, currency);
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

/**
 * Price history rows joined with the seller URL that produced each one.
 * Used by the CSV/JSON export and TrackerDetail's per-seller breakdown so
 * each row carries enough context to disambiguate which retailer sold at
 * which price.
 */
export interface PriceHistoryWithSeller extends PriceRecord {
  seller_url: string | null;
}

export function getPriceHistoryWithSeller(
  trackerId: number,
  range?: string,
): PriceHistoryWithSeller[] {
  let dateFilter = '';
  if (range) {
    const match = range.match(/^(\d+)([dhm])$/);
    if (match) {
      const [, num, unit] = match;
      const unitMap: Record<string, string> = { d: 'days', h: 'hours', m: 'minutes' };
      dateFilter = `AND ph.scraped_at >= datetime('now', '-${num} ${unitMap[unit]}')`;
    }
  }
  return getDb().prepare(`
    SELECT ph.*, tu.url as seller_url
    FROM price_history ph
    LEFT JOIN tracker_urls tu ON tu.id = ph.tracker_url_id
    WHERE ph.tracker_id = ? ${dateFilter}
    ORDER BY ph.scraped_at ASC
  `).all(trackerId) as PriceHistoryWithSeller[];
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
  trackerUrlId: number | null = null,
): NotificationRecord {
  const stmt = getDb().prepare(`
    INSERT INTO notifications (tracker_id, tracker_url_id, price, threshold_price, channel)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(trackerId, trackerUrlId, price, thresholdPrice, channel);
  return getDb().prepare('SELECT * FROM notifications WHERE id = ?').get(Number(result.lastInsertRowid)) as NotificationRecord;
}

/**
 * Notification history for a user, joining in tracker name/url and the
 * specific seller URL that triggered the alert (nullable for pre-multi-
 * seller migration rows). Optional trackerId filter powers the per-tracker
 * "Recent Alerts" section on TrackerDetail.
 */
export function getNotificationHistory(
  userId: number,
  trackerId?: number,
  limit: number = 100,
): NotificationHistoryRow[] {
  const db = getDb();
  if (trackerId !== undefined) {
    return db.prepare(`
      SELECT n.*,
             t.name as tracker_name, t.url as tracker_url,
             tu.url as seller_url
      FROM notifications n
      INNER JOIN trackers t ON t.id = n.tracker_id
      LEFT JOIN tracker_urls tu ON tu.id = n.tracker_url_id
      WHERE t.user_id = ? AND n.tracker_id = ?
      ORDER BY n.sent_at DESC
      LIMIT ?
    `).all(userId, trackerId, limit) as NotificationHistoryRow[];
  }
  return db.prepare(`
    SELECT n.*,
           t.name as tracker_name, t.url as tracker_url,
           tu.url as seller_url
    FROM notifications n
    INNER JOIN trackers t ON t.id = n.tracker_id
    LEFT JOIN tracker_urls tu ON tu.id = n.tracker_url_id
    WHERE t.user_id = ?
    ORDER BY n.sent_at DESC
    LIMIT ?
  `).all(userId, limit) as NotificationHistoryRow[];
}

/**
 * Most recent notification for a specific seller on a tracker. Drives the
 * per-seller cooldown logic in the scheduler. The old tracker-level
 * variant was replaced because cooldown is now per-(tracker, seller).
 */
export function getLastNotificationForSeller(
  trackerId: number,
  trackerUrlId: number,
): NotificationRecord | undefined {
  return getDb().prepare(`
    SELECT * FROM notifications
    WHERE tracker_id = ? AND tracker_url_id = ?
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(trackerId, trackerUrlId) as NotificationRecord | undefined;
}

// --- Settings ---

import { encrypt, decrypt, isEncrypted } from '../crypto/settings-crypto.js';

// Only these keys are encrypted at rest. Any other setting key would be
// stored plaintext as before — add to this set if you introduce another
// credential-like setting.
const ENCRYPTED_KEYS = new Set([
  'discord_webhook_url',
  'ntfy_url',
  'ntfy_token',
  'generic_webhook_url',
]);

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
