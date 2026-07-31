import { getDb } from './connection.js';
import { normalizeTrackerUrl } from '../lib/normalize-url.js';
import { buildSlug } from '../lib/build-slug.js';
import { randomBytes, createHash } from 'crypto';
import { logger } from '../logger.js';
import {
  isBlockedRetailerHost,
  RETAILER_BLOCKED_ERROR_MESSAGE,
} from '../scraper/blocked-retailers.js';

export interface Tracker {
  id: number;
  name: string;
  url: string;
  normalized_url: string | null;
  threshold_price: number | null;
  check_interval_minutes: number;
  // Fixed per-tracker random offset (minutes) added to check_interval when
  // deciding if a seller is due. Populated at createTracker time; never
  // mutated. Spreads scheduled checks so a batch of same-interval trackers
  // doesn't all fire in the same minute.
  jitter_minutes: number;
  css_selector: string | null;
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  // 'blocked' means the retailer's WAF blanket-blocks our egress IP
  // (Akamai 403 / Cloudflare bot-mitigation) — distinct from 'error'
  // because retries won't help. The scheduler skips blocked sellers.
  // 'purchased' is a tracker-level state set by the purchase-log feature;
  // the scheduler excludes it from scrape candidates (see getDueTrackerUrls).
  status: 'active' | 'paused' | 'error' | 'blocked' | 'purchased';
  created_at: string;
  updated_at: string;
  user_id: number | null;
  // AI Buyer's Assistant fields (migration v8)
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
  ai_verdict_reason_key: string | null;
  ai_verdict_updated_at: number | null;
  ai_summary: string | null;
  ai_summary_updated_at: number | null;
  ai_signals_json: string | null;
  ai_failure_count: number;
  // Doorbuster mode (migration v14). All three are nullable; the feature is
  // only "on" when all three are set. When `now` is between start and end,
  // the scheduler uses doorbuster_interval_minutes instead of
  // check_interval_minutes (+jitter). See isDoorbusterActive().
  doorbuster_start_at: string | null;
  doorbuster_end_at: string | null;
  doorbuster_interval_minutes: number | null;
  // Wishlist (migration v16). Stored as INTEGER 0/1 in SQLite; the route
  // layer coerces to/from boolean at the API boundary. Default 0 = "not on
  // wishlist" so existing trackers stay private until explicitly toggled.
  is_wishlisted: number;
  // Record-low alert mode (migration v20, deal-intelligence phase 1).
  // 'all' fires 30d/90d/all-time record-low alerts; 'record_only' fires only
  // all-time lows; 'off' disables record-low alerts (threshold alerts
  // unaffected). Record-low alerts are the one alert class that fires even
  // when threshold_price is null.
  low_alert_mode: 'all' | 'record_only' | 'off';
  // Autonomous purchasing (migration v19). buy_armed=1 opts the tracker into
  // the buy-on-trigger flow; buy_quantity sets the qty pre-loaded into the
  // Amazon cart. Both stored as INTEGER; buy_armed coerced to/from boolean at
  // the API boundary (same pattern as is_wishlisted).
  buy_armed: number;     // 0/1 — opt-in to the buy-on-trigger flow
  buy_quantity: number;  // qty to pre-load into the Amazon cart
}

/**
 * True when `now` is inside the configured doorbuster window for this tracker.
 * All three of doorbuster_start_at / _end_at / _interval_minutes must be set;
 * otherwise the feature is OFF for this tracker. The route layer guarantees
 * the all-or-nothing invariant on writes; this helper is a final safety net
 * for partially-populated rows (legacy or hand-edited DB state).
 */
export function isDoorbusterActive(tracker: Tracker, now: Date = new Date()): boolean {
  if (!tracker.doorbuster_start_at || !tracker.doorbuster_end_at || !tracker.doorbuster_interval_minutes) {
    return false;
  }
  const start = new Date(tracker.doorbuster_start_at);
  const end = new Date(tracker.doorbuster_end_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  return now >= start && now <= end;
}

/**
 * Compute a jitter offset for a tracker with the given check interval.
 * Formula: uniform random integer in [0, min(floor(interval/6), 30)].
 * Proportional at small intervals (10-min interval → 0-1 min jitter);
 * capped at 30 min for long intervals so "check every 6h" doesn't become
 * "check every 7h". Pure function so it's trivially testable.
 *
 * Kept in sync with the v5 migration backfill in migrations.ts.
 */
export function computeJitterMinutes(intervalMinutes: number): number {
  const cap = Math.min(Math.floor(intervalMinutes / 6), 30);
  if (cap <= 0) return 0;
  return Math.floor(Math.random() * (cap + 1));
}

// Listing condition for a per-seller URL. Non-'new' values cause alert
// messages to append a tag (e.g. "$239 (Warehouse)") so users can tell at
// a glance whether the winning price was a refurb / open-box / warehouse
// listing rather than a fresh-from-the-factory unit.
export type TrackerUrlCondition = 'new' | 'warehouse' | 'refurb' | 'open_box';

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
  pending_confirmation_price: number | null;
  pending_confirmation_at: string | null;
  // 'blocked' means the retailer's WAF blanket-blocks our egress IP.
  // See Tracker.status for the same enum on the parent table.
  status: 'active' | 'paused' | 'error' | 'blocked';
  condition: TrackerUrlCondition;
  // Back-in-stock (migration v21). Positive-signal state machine; 'unknown'
  // never fires transitions.
  availability: 'unknown' | 'in_stock' | 'out_of_stock';
  availability_changed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Returned by the admin/user tracker list API so the client can show per-
// tracker aggregates (seller count, errored seller count, best seller) in
// one round-trip instead of fetching tracker_urls separately.
export interface TrackerWithSellerSummary extends Tracker {
  seller_count: number;
  errored_seller_count: number;
  // Sellers affirmatively out of stock (phase 4). Card shows an OOS chip
  // when EVERY seller is out of stock.
  oos_seller_count: number;
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

// --- Purchases (migration v18) ---

// One row per purchase event. Many-to-one with trackers. `first_price`
// snapshots the earliest observed price at purchase time so savings stay
// stable even if price_history is pruned later. `tracker_url_id` is
// nullable because deleting a seller (ON DELETE SET NULL) shouldn't lose
// the purchase record.
export interface Purchase {
  id: number;
  tracker_id: number;
  tracker_url_id: number | null;
  purchase_price: number;
  quantity: number;
  first_price: number;
  purchased_at: string;
  created_at: string;
}

// Used by the admin /purchased list view — joins the tracker row so the
// UI can show product name + URL without a second round-trip.
export interface PurchaseWithTracker extends Purchase {
  tracker_name: string;
  tracker_url: string;
  seller_label: string | null;
}

// Caller-supplied fields when logging a purchase. The route layer fills
// in `purchase_price` from tracker.last_price if omitted; `purchased_at`
// defaults to now; `quantity` defaults to 1; `tracker_url_id` is optional.
export interface PurchaseInput {
  purchase_price: number;
  quantity?: number;
  purchased_at?: string;
  tracker_url_id?: number | null;
}

// Public-savings rollup. `since` is the earliest purchased_at (or null
// when there are no purchases yet). `monthly` is sorted oldest-first.
export interface SavingsSummary {
  total_saved: number;
  purchase_count: number;
  since: string | null;
  monthly: Array<{ month: string; saved: number }>;
}

// Per-purchase savings, clamped at $0 so paying ABOVE first_price doesn't
// produce negative savings on the rollup. Quantity scales the delta.
export function savingsForPurchase(
  p: Pick<Purchase, 'first_price' | 'purchase_price' | 'quantity'>,
): number {
  return Math.max(0, (p.first_price - p.purchase_price) * p.quantity);
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
      COALESCE(agg.oos_seller_count, 0) as oos_seller_count,
      best.url as best_seller_url
    FROM trackers t
    LEFT JOIN (
      SELECT
        tracker_id,
        COUNT(*) as seller_count,
        SUM(CASE WHEN status = 'error' OR (last_error IS NOT NULL AND consecutive_failures > 0) THEN 1 ELSE 0 END) as errored_seller_count,
        SUM(CASE WHEN availability = 'out_of_stock' THEN 1 ELSE 0 END) as oos_seller_count
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
  const interval = data.check_interval_minutes ?? 360;
  const normalizedUrl = normalizeTrackerUrl(data.url);
  const tracker = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO trackers (name, url, normalized_url, threshold_price, check_interval_minutes, jitter_minutes, css_selector, user_id)
      VALUES (@name, @url, @normalized_url, @threshold_price, @check_interval_minutes, @jitter_minutes, @css_selector, @user_id)
    `).run({
      name: data.name,
      url: data.url,
      normalized_url: normalizedUrl,
      threshold_price: data.threshold_price ?? null,
      check_interval_minutes: interval,
      jitter_minutes: computeJitterMinutes(interval),
      css_selector: data.css_selector ?? null,
      user_id: data.user_id,
    });
    const trackerId = Number(result.lastInsertRowid);
    // Known-blocked retailer host? Mark the seller (and via aggregation,
    // the tracker) as 'blocked' on insert so the UI shows the right state
    // immediately rather than failing through 3 cron ticks first.
    if (isBlockedRetailerHost(data.url)) {
      db.prepare(
        `INSERT INTO tracker_urls (tracker_id, url, position, status, last_error)
         VALUES (?, ?, 0, 'blocked', ?)`,
      ).run(trackerId, data.url, RETAILER_BLOCKED_ERROR_MESSAGE);
    } else {
      db.prepare(`INSERT INTO tracker_urls (tracker_id, url, position) VALUES (?, ?, 0)`).run(trackerId, data.url);
    }
    return getTrackerById(trackerId, data.user_id)!;
  })();

  // Roll the (possibly 'blocked') seller status up to the tracker row.
  // No-op when the seller is 'active' (the trackers row's defaults match
  // the aggregate output); needed when the seller landed as 'blocked'.
  refreshTrackerAggregates(tracker.id);

  // Best-effort: also stamp a public-product slug for this normalized URL.
  // First-tracker-wins on the display name (INSERT OR IGNORE inside the helper).
  // Wrapped in try/catch so a slug failure never breaks tracker creation.
  if (normalizedUrl) {
    try {
      createSlugForUrl(normalizedUrl, data.name);
    } catch (err) {
      logger.warn({ err, normalizedUrl }, 'Failed to create public_product_slug at tracker creation');
    }
  }
  return tracker;
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
  // Doorbuster mode — see migration v14 + isDoorbusterActive(). Pass `null`
  // to clear (the dynamic SET below treats null as "set to NULL", undefined
  // as "leave alone"). The three fields are atomic at the route layer.
  doorbuster_start_at: string | null;
  doorbuster_end_at: string | null;
  doorbuster_interval_minutes: number | null;
  // Wishlist toggle (migration v16). Stored as 0/1; boolean coerced to int
  // by callers (Number(boolean) === 0|1 works for both directions). Primary
  // mutation path is the dedicated PATCH at /api/wishlist/items/:id.
  is_wishlisted: number;
  // Autonomous purchasing toggle (migration v19). Stored as 0/1; boolean
  // coerced to int by callers. buy_quantity is a plain integer (min 1).
  buy_armed: number;
  buy_quantity: number;
  // Record-low alert mode (migration v20); zod-validated at the route layer.
  low_alert_mode: string;
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
  // The CASE expression switches between the doorbuster cadence and the
  // normal (interval + jitter) cadence based on whether `now` falls inside
  // the configured doorbuster window. All three doorbuster fields must be
  // set for the accelerated path to apply; otherwise we fall through to the
  // existing scheduling behavior unchanged.
  return getDb().prepare(`
    SELECT * FROM trackers
    WHERE status = 'active'
    AND (
      last_checked_at IS NULL
      OR datetime(
           last_checked_at,
           '+' || CASE
             WHEN doorbuster_interval_minutes IS NOT NULL
               AND doorbuster_start_at IS NOT NULL
               AND doorbuster_end_at IS NOT NULL
               AND datetime('now') BETWEEN datetime(doorbuster_start_at) AND datetime(doorbuster_end_at)
             THEN doorbuster_interval_minutes
             ELSE (check_interval_minutes + jitter_minutes)
           END || ' minutes'
         ) <= datetime('now')
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
  // Per-seller cadence inherits from the parent tracker. When the parent's
  // doorbuster window is active and all three doorbuster fields are set,
  // every seller under it accelerates to the doorbuster interval. Outside
  // the window we fall through to the existing (interval + jitter)
  // behavior, byte-for-byte unchanged.
  return getDb().prepare(`
    SELECT tu.*,
           t.check_interval_minutes as tracker_check_interval_minutes,
           t.user_id as tracker_user_id
    FROM tracker_urls tu
    INNER JOIN trackers t ON t.id = tu.tracker_id
    WHERE t.status NOT IN ('paused', 'purchased') AND tu.status NOT IN ('paused', 'blocked')
    AND (
      tu.last_checked_at IS NULL
      OR datetime(
           tu.last_checked_at,
           '+' || CASE
             WHEN t.doorbuster_interval_minutes IS NOT NULL
               AND t.doorbuster_start_at IS NOT NULL
               AND t.doorbuster_end_at IS NOT NULL
               AND datetime('now') BETWEEN datetime(t.doorbuster_start_at) AND datetime(t.doorbuster_end_at)
             THEN t.doorbuster_interval_minutes
             ELSE (t.check_interval_minutes + t.jitter_minutes)
           END || ' minutes'
         ) <= datetime('now')
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
 * Return the last `limit` non-null prices recorded for a single seller,
 * most-recent first. Used by the plausibility guard to compute a
 * trailing median for the suspiciousness check. Excludes rows from
 * other sellers on the same tracker — different sellers have different
 * pricing baselines and shouldn't pollute each other's median.
 */
export function getRecentSuccessfulPricesForSeller(
  sellerId: number,
  limit: number,
): number[] {
  const rows = getDb()
    .prepare(
      // `id DESC` is a tiebreaker: scraped_at is second-precision and a
      // manual "Check Now" colliding with a scheduled tick can produce
      // ties. Without the tiebreaker the alert path's `recentPrices.slice(1)`
      // baseline computation could non-deterministically discard the wrong row.
      'SELECT price FROM price_history WHERE tracker_url_id = ? AND price > 0 ORDER BY scraped_at DESC, id DESC LIMIT ?',
    )
    .all(sellerId, limit) as { price: number }[];
  return rows.map(r => r.price);
}

/**
 * Return every seller currently flagged as awaiting a confirmation
 * scrape. Called at scheduler start to re-enqueue confirmations whose
 * in-process setTimeout was lost on restart.
 */
export function getSellersWithPendingConfirmation(): TrackerUrl[] {
  return getDb()
    .prepare(
      'SELECT * FROM tracker_urls WHERE pending_confirmation_at IS NOT NULL',
    )
    .all() as TrackerUrl[];
}

/**
 * Add a new seller URL to an existing tracker. Assigned the next-highest
 * position number so ordering is stable and the primary (position=0) never
 * shifts. Caller must verify tracker ownership before calling.
 *
 * `condition` defaults to 'new'. Pass 'warehouse' / 'refurb' / 'open_box'
 * for refurbished, Amazon Warehouse, or open-box listings respectively —
 * alerts append a label to the winning price when condition !== 'new'.
 */
export function addTrackerUrl(
  trackerId: number,
  url: string,
  condition: TrackerUrlCondition = 'new',
): TrackerUrl {
  const db = getDb();
  const maxPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) as mp FROM tracker_urls WHERE tracker_id = ?',
  ).get(trackerId) as { mp: number };
  const nextPos = maxPos.mp + 1;
  // Mirror createTracker(): if this URL points at a known-blocked retailer
  // host, mark the seller as 'blocked' on insert so the UI is correct
  // immediately and the scheduler doesn't try (and fail) on it. Caller
  // (route layer) should refreshTrackerAggregates() after this so the
  // parent tracker's status rolls up.
  const blocked = isBlockedRetailerHost(url);
  const result = db.prepare(
    `INSERT INTO tracker_urls (tracker_id, url, position, condition, status, last_error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    trackerId,
    url,
    nextPos,
    condition,
    blocked ? 'blocked' : 'active',
    blocked ? RETAILER_BLOCKED_ERROR_MESSAGE : null,
  );
  return getTrackerUrlById(Number(result.lastInsertRowid))!;
}

/**
 * Update the listing condition on a seller URL. Joined against `trackers`
 * so the same query also enforces the (urlId, trackerId, userId) ownership
 * triple — a user can only update conditions on URLs that belong to one of
 * their own trackers. Returns true on success, false if no row matched.
 */
export function updateTrackerUrlCondition(
  urlId: number,
  trackerId: number,
  userId: number,
  condition: TrackerUrlCondition,
): boolean {
  const result = getDb().prepare(`
    UPDATE tracker_urls
    SET condition = ?, updated_at = datetime('now')
    WHERE id = ?
      AND tracker_id = ?
      AND tracker_id IN (SELECT id FROM trackers WHERE user_id = ?)
  `).run(condition, urlId, trackerId, userId);
  return result.changes > 0;
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
  pending_confirmation_price: number | null;
  pending_confirmation_at: string | null;
  availability: string;
  availability_changed_at: string | null;
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
 * Update just the normalized_url column. Called by the scheduler when
 * a primary-seller scrape resolves a different final URL than what's
 * stored (e.g., a.co short link redirects to amazon.com/dp/...).
 */
export function updateTrackerNormalizedUrl(trackerId: number, normalizedUrl: string | null): void {
  getDb().prepare('UPDATE trackers SET normalized_url = ? WHERE id = ?').run(normalizedUrl, trackerId);
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
  let aggStatus: 'active' | 'paused' | 'error' | 'blocked' | 'purchased';
  // Single-status roll-ups are easy. Mixed states (some active + some
  // blocked) prefer 'active' so the tracker stays live and shows the
  // working seller's price — one of N sellers being WAF-blocked
  // shouldn't hide the others.
  if (statuses.size === 1 && statuses.has('error')) aggStatus = 'error';
  else if (statuses.size === 1 && statuses.has('paused')) aggStatus = 'paused';
  else if (statuses.size === 1 && statuses.has('blocked')) aggStatus = 'blocked';
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

/**
 * Fuzzy search for the authenticated user's trackers by name. Used by
 * the NL-query OpenClaw skill: "the LG monitor" -> needs to resolve to
 * a tracker_id. Case-insensitive substring match, ranked by name length
 * (shorter names that contain the query rank higher — they're more
 * likely the exact thing the user meant).
 *
 * Returns the smallest useful set of fields for disambiguation: id,
 * name, last_price, ai_verdict_tier. Capped at `limit` (default 5).
 */
export function searchTrackersByName(userId: number, q: string, limit: number = 5): Array<{
  id: number;
  name: string;
  last_price: number | null;
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
}> {
  const trimmed = q.trim();
  if (!trimmed) return [];
  const pattern = '%' + trimmed.toLowerCase() + '%';
  return getDb().prepare(`
    SELECT id, name, last_price, ai_verdict_tier
    FROM trackers
    WHERE user_id = ?
      AND status = 'active'
      AND lower(name) LIKE ?
    ORDER BY length(name) ASC, name ASC
    LIMIT ?
  `).all(userId, pattern, limit) as Array<{
    id: number;
    name: string;
    last_price: number | null;
    ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  }>;
}

// --- Notifications ---

export function addNotification(
  trackerId: number,
  price: number,
  // notifications.threshold_price is NOT NULL (pre-v20 schema). Record-low
  // alerts can fire on trackers with no threshold; they store 0 here and
  // alert_type carries the real meaning (spec phase 1).
  thresholdPrice: number,
  channel: string | null = null,
  trackerUrlId: number | null = null,
  alertType: string = 'threshold',
): NotificationRecord {
  const stmt = getDb().prepare(`
    INSERT INTO notifications (tracker_id, tracker_url_id, price, threshold_price, channel, alert_type)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(trackerId, trackerUrlId, price, thresholdPrice, channel, alertType);
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
 * Count of the user's unread notifications (read_at IS NULL). Backs the
 * bell/drawer badge — a COUNT here beats shipping 200 history rows to the
 * client just to derive a number.
 */
export function getUnreadNotificationCount(userId: number): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS c
    FROM notifications n
    INNER JOIN trackers t ON t.id = n.tracker_id
    WHERE t.user_id = ? AND n.read_at IS NULL
  `).get(userId) as { c: number };
  return row.c;
}

/**
 * Mark every unread notification belonging to the user as read. Fired when
 * the /notifications page loads. Returns how many rows flipped.
 */
export function markNotificationsRead(userId: number): number {
  return getDb().prepare(`
    UPDATE notifications SET read_at = datetime('now')
    WHERE read_at IS NULL
      AND tracker_id IN (SELECT id FROM trackers WHERE user_id = ?)
  `).run(userId).changes;
}

/**
 * Most recent notification for a specific (seller, channel) pair. Drives
 * the per-channel cooldown gate in the scheduler — Discord firing does
 * not silence ntfy etc.
 */
export function getLastNotificationForSellerChannel(
  trackerId: number,
  trackerUrlId: number,
  channel: string,
): NotificationRecord | undefined {
  return getDb().prepare(`
    SELECT * FROM notifications
    WHERE tracker_id = ? AND tracker_url_id = ? AND channel = ?
    ORDER BY sent_at DESC
    LIMIT 1
  `).get(trackerId, trackerUrlId, channel) as NotificationRecord | undefined;
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
  'email_recipient',
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

export interface OverlapResult {
  count: number;
  names: string[];
  communityLow: number | null;
}

/**
 * Compute the overlap for a single tracker owned by `userId`.
 * - count: number of OTHER users' trackers sharing the same normalized_url
 *   (dedupes across a user who tracks the same product twice)
 * - names: display names of those OTHER users who have
 *   share_display_name = 'true'
 * - communityLow: MIN(last_price) across ALL users' trackers with this
 *   normalized_url (self INCLUDED), null if no prices yet
 *
 * Returns null when the tracker isn't owned by `userId` so the route
 * layer can 404 without leaking other users' tracker IDs.
 */
export function getOverlapForTracker(trackerId: number, userId: number): OverlapResult | null {
  const db = getDb();
  const tracker = db.prepare('SELECT normalized_url FROM trackers WHERE id = ? AND user_id = ?')
    .get(trackerId, userId) as { normalized_url: string | null } | undefined;
  if (!tracker) return null;
  if (!tracker.normalized_url) {
    return { count: 0, names: [], communityLow: null };
  }

  const peers = db.prepare(`
    SELECT t.user_id, u.display_name
    FROM trackers t
    JOIN users u ON u.id = t.user_id
    WHERE t.normalized_url = ? AND t.user_id != ?
  `).all(tracker.normalized_url, userId) as { user_id: number; display_name: string }[];

  // Dedupe peers by user_id — a user tracking the same product twice
  // shouldn't inflate the count.
  const seen = new Set<number>();
  const uniquePeers: { user_id: number; display_name: string }[] = [];
  for (const p of peers) {
    if (seen.has(p.user_id)) continue;
    seen.add(p.user_id);
    uniquePeers.push(p);
  }

  // Respect each peer's share_display_name setting. Missing or 'false' = hidden.
  const shareRows = uniquePeers.length === 0 ? [] : db.prepare(
    `SELECT user_id, value FROM settings WHERE key = 'share_display_name' AND user_id IN (${uniquePeers.map(() => '?').join(',')})`,
  ).all(...uniquePeers.map(p => p.user_id)) as { user_id: number; value: string }[];
  const optedIn = new Set(shareRows.filter(r => r.value === 'true').map(r => r.user_id));
  const names = uniquePeers.filter(p => optedIn.has(p.user_id)).map(p => p.display_name);

  const low = db.prepare(`
    SELECT MIN(last_price) AS low
    FROM trackers
    WHERE normalized_url = ? AND last_price IS NOT NULL
  `).get(tracker.normalized_url) as { low: number | null };

  return { count: uniquePeers.length, names, communityLow: low.low ?? null };
}

/**
 * Compute overlap counts for every tracker owned by `userId`. Single
 * query so the dashboard doesn't fire one HTTP request per tracker.
 */
export function getOverlapCountsForUser(userId: number): Record<number, number> {
  const rows = getDb().prepare(`
    SELECT t.id AS tracker_id,
           (SELECT COUNT(DISTINCT peer.user_id)
            FROM trackers peer
            WHERE peer.normalized_url = t.normalized_url
              AND peer.user_id != t.user_id) AS count
    FROM trackers t
    WHERE t.user_id = ? AND t.normalized_url IS NOT NULL
  `).all(userId) as { tracker_id: number; count: number }[];
  const out: Record<number, number> = {};
  for (const r of rows) out[r.tracker_id] = r.count;
  return out;
}

// --- AI Buyer's Assistant ---

// AI Buyer's Assistant write helpers — only generators.ts (Task 9) calls these.

export function updateTrackerAIVerdict(
  trackerId: number,
  args: { tier: VerdictTier; reason: string; reasonKey: ReasonKey; signalsJson: string }
): void {
  getDb().prepare(`
    UPDATE trackers SET
      ai_verdict_tier = ?,
      ai_verdict_reason = ?,
      ai_verdict_reason_key = ?,
      ai_verdict_updated_at = ?,
      ai_signals_json = ?,
      ai_failure_count = 0
    WHERE id = ?
  `).run(args.tier, args.reason, args.reasonKey, Date.now(), args.signalsJson, trackerId);
}

export function updateTrackerAISummary(trackerId: number, summary: string): void {
  getDb().prepare(`
    UPDATE trackers SET
      ai_summary = ?,
      ai_summary_updated_at = ?
    WHERE id = ?
  `).run(summary, Date.now(), trackerId);
}

export function incrementAIFailureCount(trackerId: number): void {
  getDb().prepare(`
    UPDATE trackers SET ai_failure_count = ai_failure_count + 1 WHERE id = ?
  `).run(trackerId);
}

export function getTrackersWithStaleSummary(stalerThanMs: number, limit: number): Tracker[] {
  return getDb().prepare(`
    SELECT * FROM trackers
    WHERE status = 'active'
      AND (ai_summary_updated_at IS NULL OR ai_summary_updated_at < ?)
    ORDER BY COALESCE(ai_summary_updated_at, 0) ASC
    LIMIT ?
  `).all(Date.now() - stalerThanMs, limit) as Tracker[];
}

/**
 * Trackers whose AI verdict is stale or missing. Used by the nightly
 * backfill cron to ensure trackers with stable prices (no change events
 * to trigger fire-and-forget verdict generation) still get a verdict
 * computed periodically.
 *
 * Returns rows where:
 *   - status = 'active' AND last_price IS NOT NULL (eligible for verdict)
 *   - ai_verdict_updated_at IS NULL OR ai_verdict_updated_at < (now - stalenessMs)
 *
 * Sorted oldest-first (NULLs first, then ascending) so newest-stale rows
 * get processed in subsequent sweeps if `limit` is hit. The
 * `(col IS NULL) DESC, col ASC` form avoids depending on SQLite's
 * `NULLS FIRST` keyword, which only landed in 3.30+.
 */
export function getTrackersWithStaleOrMissingVerdict(stalenessMs: number, limit: number): Array<{ id: number }> {
  const cutoff = Date.now() - stalenessMs;
  return getDb().prepare(`
    SELECT id FROM trackers
    WHERE status = 'active'
      AND last_price IS NOT NULL
      AND (ai_verdict_updated_at IS NULL OR ai_verdict_updated_at < ?)
    ORDER BY (ai_verdict_updated_at IS NULL) DESC, ai_verdict_updated_at ASC
    LIMIT ?
  `).all(cutoff, limit) as Array<{ id: number }>;
}

/**
 * Returns price observations for a tracker since `sinceMs` (unix ms),
 * shaped as { price, recorded_at } where recorded_at is unix ms.
 *
 * NOTE: the underlying column is `scraped_at` (TEXT ISO datetime), not
 * a unix-ms integer. We convert at the boundary so the AI signals
 * code (PriceObservation type) can work in unix ms throughout.
 */
export function getRecentSuccessfulPricesForTracker(
  trackerId: number,
  sinceMs: number,
): Array<{ price: number; recorded_at: number }> {
  const sinceIso = new Date(sinceMs).toISOString();
  const rows = getDb().prepare(`
    SELECT price, scraped_at FROM price_history
    WHERE tracker_id = ? AND scraped_at >= ?
    ORDER BY scraped_at ASC
  `).all(trackerId, sinceIso) as Array<{ price: number; scraped_at: string }>;
  return rows.map(r => ({ price: r.price, recorded_at: new Date(r.scraped_at).getTime() }));
}

// --- User API tokens (browser extension) ---

export interface UserApiTokenRow {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CreatedUserApiToken {
  id: number;
  name: string;
  token: string;     // plaintext — returned ONLY here, never stored
  prefix: string;
  created_at: number;
}

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

export function createUserApiToken(userId: number, name: string): CreatedUserApiToken {
  const plaintext = 'pt_' + randomBytes(32).toString('base64url');
  const token_hash = hashToken(plaintext);
  const prefix = plaintext.slice(0, 8);
  const created_at = Date.now();
  const id = Number(getDb().prepare(
    `INSERT INTO user_api_tokens (user_id, name, token_hash, prefix, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId, name, token_hash, prefix, created_at).lastInsertRowid);
  return { id, name, token: plaintext, prefix, created_at };
}

export function listUserApiTokensForUser(userId: number): UserApiTokenRow[] {
  return getDb().prepare(
    `SELECT id, user_id, name, prefix, created_at, last_used_at, revoked_at
     FROM user_api_tokens WHERE user_id = ? ORDER BY created_at DESC`,
  ).all(userId) as UserApiTokenRow[];
}

interface ActiveTokenLookup {
  id: number;
  user_id: number;
}

export function findActiveTokenByHash(token_hash: string): ActiveTokenLookup | null {
  const row = getDb().prepare(
    `SELECT id, user_id FROM user_api_tokens
     WHERE token_hash = ? AND revoked_at IS NULL`,
  ).get(token_hash) as ActiveTokenLookup | undefined;
  return row ?? null;
}

export function revokeUserApiToken(tokenId: number, userId: number): boolean {
  const result = getDb().prepare(
    `UPDATE user_api_tokens SET revoked_at = ?
     WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
  ).run(Date.now(), tokenId, userId);
  return result.changes > 0;
}

export function touchTokenLastUsed(tokenId: number): void {
  getDb().prepare(`UPDATE user_api_tokens SET last_used_at = ? WHERE id = ?`)
    .run(Date.now(), tokenId);
}

// === Projects ===

export type { Project, ProjectTracker, BasketMember, BasketState, IneligibleReason } from '../projects/types.js';
import type { Project, BasketMember } from '../projects/types.js';
import type { VerdictTier, ReasonKey } from '../ai/types.js';

export function listProjectsForUser(userId: number, status?: 'active' | 'archived'): Project[] {
  if (status) {
    return getDb().prepare(
      `SELECT * FROM projects WHERE user_id = ? AND status = ? ORDER BY created_at DESC`
    ).all(userId, status) as Project[];
  }
  return getDb().prepare(
    `SELECT * FROM projects WHERE user_id = ? ORDER BY created_at DESC`
  ).all(userId) as Project[];
}

export function getProjectById(id: number, userId?: number): Project | undefined {
  const row = userId !== undefined
    ? getDb().prepare(`SELECT * FROM projects WHERE id = ? AND user_id = ?`).get(id, userId)
    : getDb().prepare(`SELECT * FROM projects WHERE id = ?`).get(id);
  return row as Project | undefined;
}

export function createProject(args: { user_id: number; name: string; target_total: number }): number {
  const result = getDb().prepare(
    `INSERT INTO projects (user_id, name, target_total) VALUES (?, ?, ?)`
  ).run(args.user_id, args.name, args.target_total);
  return Number(result.lastInsertRowid);
}

export function updateProject(
  id: number,
  args: { name?: string; target_total?: number; status?: 'active' | 'archived' }
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (args.name !== undefined) { sets.push('name = ?'); values.push(args.name); }
  if (args.target_total !== undefined) { sets.push('target_total = ?'); values.push(args.target_total); }
  if (args.status !== undefined) { sets.push('status = ?'); values.push(args.status); }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  values.push(id);
  getDb().prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteProject(id: number): void {
  getDb().prepare(`DELETE FROM projects WHERE id = ?`).run(id);
}

export function addProjectTracker(args: {
  project_id: number;
  tracker_id: number;
  per_item_ceiling?: number | null;
  position?: number;
}): void {
  const position = args.position ?? 0;
  const ceiling = args.per_item_ceiling ?? null;
  getDb().prepare(
    `INSERT INTO project_trackers (project_id, tracker_id, per_item_ceiling, position) VALUES (?, ?, ?, ?)`
  ).run(args.project_id, args.tracker_id, ceiling, position);
}

export function removeProjectTracker(projectId: number, trackerId: number): void {
  getDb().prepare(
    `DELETE FROM project_trackers WHERE project_id = ? AND tracker_id = ?`
  ).run(projectId, trackerId);
}

export function updateProjectTracker(
  projectId: number,
  trackerId: number,
  args: { per_item_ceiling?: number | null; position?: number }
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (args.per_item_ceiling !== undefined) { sets.push('per_item_ceiling = ?'); values.push(args.per_item_ceiling); }
  if (args.position !== undefined) { sets.push('position = ?'); values.push(args.position); }
  if (sets.length === 0) return;
  values.push(projectId, trackerId);
  getDb().prepare(
    `UPDATE project_trackers SET ${sets.join(', ')} WHERE project_id = ? AND tracker_id = ?`
  ).run(...values);
}

/** Returns the IDs of active projects containing this tracker. Called per-scrape. */
export function getActiveProjectIdsForTracker(trackerId: number): number[] {
  const rows = getDb().prepare(
    `SELECT pt.project_id FROM project_trackers pt
     INNER JOIN projects p ON p.id = pt.project_id
     WHERE pt.tracker_id = ? AND p.status = 'active'`
  ).all(trackerId) as { project_id: number }[];
  return rows.map(r => r.project_id);
}

/**
 * Loads basket members for a project — joins project_trackers + trackers
 * and surfaces the AI verdict fields populated by the AI Buyer's Assistant.
 * Sorted by position, then tracker name as a stable tiebreaker.
 */
export function getBasketMembersForProject(projectId: number): BasketMember[] {
  const rows = getDb().prepare(
    `SELECT
       t.id AS tracker_id,
       t.name AS tracker_name,
       t.last_price,
       t.status AS tracker_status,
       pt.per_item_ceiling,
       pt.position,
       t.ai_verdict_tier,
       t.ai_verdict_reason
     FROM project_trackers pt
     INNER JOIN trackers t ON t.id = pt.tracker_id
     WHERE pt.project_id = ?
     ORDER BY pt.position ASC, t.name ASC`
  ).all(projectId) as BasketMember[];
  return rows;
}

// === Project notifications (cooldown source-of-truth + history) ===

export interface ProjectNotificationRecord {
  id: number;
  project_id: number;
  channel: string;
  basket_total: number;
  target_total: number;
  ai_commentary: string | null;
  sent_at: string;
}

export function getLastProjectNotificationForChannel(
  projectId: number,
  channel: string,
): ProjectNotificationRecord | undefined {
  return getDb().prepare(
    `SELECT * FROM project_notifications
     WHERE project_id = ? AND channel = ?
     ORDER BY sent_at DESC LIMIT 1`
  ).get(projectId, channel) as ProjectNotificationRecord | undefined;
}

export function getRecentProjectNotifications(projectId: number, limit: number): ProjectNotificationRecord[] {
  return getDb().prepare(
    `SELECT * FROM project_notifications
     WHERE project_id = ?
     ORDER BY sent_at DESC LIMIT ?`
  ).all(projectId, limit) as ProjectNotificationRecord[];
}

export function addProjectNotification(args: {
  project_id: number;
  channel: string;
  basket_total: number;
  target_total: number;
  ai_commentary: string | null;
}): void {
  getDb().prepare(
    `INSERT INTO project_notifications (project_id, channel, basket_total, target_total, ai_commentary)
     VALUES (?, ?, ?, ?, ?)`
  ).run(args.project_id, args.channel, args.basket_total, args.target_total, args.ai_commentary);
}

// === Web Push subscriptions ===

export interface WebPushSubscriptionRecord {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  device_label: string | null;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
}

/**
 * UPSERT semantics: re-subscribing on the same browser+device returns the
 * same endpoint, so we ON CONFLICT update the keys + device_label rather
 * than creating a duplicate row. user_id is NOT updated on conflict —
 * the original owner keeps the row (defense-in-depth against cross-user
 * endpoint claims).
 */
export function upsertWebPushSubscription(args: {
  user_id: number;
  endpoint: string;
  p256dh_key: string;
  auth_key: string;
  device_label: string | null;
  user_agent: string | null;
}): number {
  getDb().prepare(
    `INSERT INTO web_push_subscriptions
       (user_id, endpoint, p256dh_key, auth_key, device_label, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh_key = excluded.p256dh_key,
       auth_key = excluded.auth_key,
       device_label = excluded.device_label,
       user_agent = excluded.user_agent`
  ).run(args.user_id, args.endpoint, args.p256dh_key, args.auth_key, args.device_label, args.user_agent);
  // For UPSERTs, lastInsertRowid is 0 on UPDATE — re-fetch by endpoint.
  const row = getDb().prepare(`SELECT id FROM web_push_subscriptions WHERE endpoint = ?`)
    .get(args.endpoint) as { id: number };
  return row.id;
}

export function getActiveWebPushSubscriptionsForUser(userId: number): WebPushSubscriptionRecord[] {
  return getDb().prepare(
    `SELECT * FROM web_push_subscriptions WHERE user_id = ? ORDER BY created_at ASC`
  ).all(userId) as WebPushSubscriptionRecord[];
}

export function getWebPushSubscriptionById(id: number): WebPushSubscriptionRecord | undefined {
  return getDb().prepare(
    `SELECT * FROM web_push_subscriptions WHERE id = ?`
  ).get(id) as WebPushSubscriptionRecord | undefined;
}

export function deleteWebPushSubscription(id: number): void {
  getDb().prepare(`DELETE FROM web_push_subscriptions WHERE id = ?`).run(id);
}

/** Used by the firer to clean up stale endpoints when web-push returns 410/404. */
export function deleteWebPushSubscriptionByEndpoint(endpoint: string): void {
  getDb().prepare(`DELETE FROM web_push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

export function updateWebPushLastUsedAt(id: number): void {
  getDb().prepare(
    `UPDATE web_push_subscriptions SET last_used_at = datetime('now') WHERE id = ?`
  ).run(id);
}

// === Public product slugs (anonymous /p/<slug> pages) ===

export interface PublicProductSlug {
  slug: string;
  normalized_url: string;
  display_name: string;
  created_at: number;
}

/**
 * INSERT-OR-IGNORE a slug row for a normalized URL. First caller for a given
 * `normalized_url` "wins" the display name — subsequent calls return the
 * existing row unchanged. Returns null when normalized_url is empty (callers
 * are expected to skip slug creation in that case).
 *
 * Pure DB helper — no side effects beyond the INSERT. Safe to call from
 * within a tracker-creation transaction OR from migration backfill.
 */
export function createSlugForUrl(
  normalized_url: string | null | undefined,
  display_name: string,
): PublicProductSlug | null {
  if (!normalized_url) return null;
  const db = getDb();
  const slug = buildSlug(display_name, normalized_url);
  db.prepare(
    `INSERT OR IGNORE INTO public_product_slugs (slug, normalized_url, display_name, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(slug, normalized_url, display_name, Date.now());
  // Re-fetch by normalized_url so we always return the canonical row (in
  // case the slug we just built lost a race to a previous insert with a
  // different display name).
  return getDb().prepare(
    `SELECT slug, normalized_url, display_name, created_at
     FROM public_product_slugs WHERE normalized_url = ?`,
  ).get(normalized_url) as PublicProductSlug | null;
}

export function getProductBySlug(slug: string): PublicProductSlug | null {
  const row = getDb().prepare(
    `SELECT slug, normalized_url, display_name, created_at
     FROM public_product_slugs WHERE slug = ?`,
  ).get(slug) as PublicProductSlug | undefined;
  return row ?? null;
}

export function getSlugByNormalizedUrl(normalized_url: string): string | null {
  const row = getDb().prepare(
    `SELECT slug FROM public_product_slugs WHERE normalized_url = ?`,
  ).get(normalized_url) as { slug: string } | undefined;
  return row?.slug ?? null;
}

/**
 * Every slug row, ordered oldest-first. Powers the sitemap.xml handler.
 * Kept narrow on purpose — no display name, no URL — sitemap only needs
 * the slug + creation time.
 */
export function listAllSlugs(): Array<{ slug: string; created_at: number }> {
  return getDb().prepare(
    `SELECT slug, created_at FROM public_product_slugs ORDER BY created_at ASC`,
  ).all() as Array<{ slug: string; created_at: number }>;
}

// === Public product aggregates (cross-user, daily-MIN) ===

/**
 * Daily-MIN price history for a normalized URL across ALL trackers (every
 * user). Aggregated by date so a user can't infer per-scrape timing of any
 * other user. Empty array when the normalized_url has no recorded prices.
 */
export function getDailyMinHistoryForNormalizedUrl(
  normalized_url: string,
  startMs?: number,
): Array<{ date: string; price: number }> {
  const db = getDb();
  if (startMs !== undefined) {
    const startIso = new Date(startMs).toISOString();
    return db.prepare(`
      SELECT DATE(ph.scraped_at) AS date, MIN(ph.price) AS price
      FROM price_history ph
      INNER JOIN trackers t ON t.id = ph.tracker_id
      WHERE t.normalized_url = ? AND ph.scraped_at >= ?
      GROUP BY DATE(ph.scraped_at)
      ORDER BY DATE(ph.scraped_at) ASC
    `).all(normalized_url, startIso) as Array<{ date: string; price: number }>;
  }
  return db.prepare(`
    SELECT DATE(ph.scraped_at) AS date, MIN(ph.price) AS price
    FROM price_history ph
    INNER JOIN trackers t ON t.id = ph.tracker_id
    WHERE t.normalized_url = ?
    GROUP BY DATE(ph.scraped_at)
    ORDER BY DATE(ph.scraped_at) ASC
  `).all(normalized_url) as Array<{ date: string; price: number }>;
}

/**
 * The user's own tracker matching a normalized URL, if any. Used by the
 * share-target dedup check (phase 2): sharing an already-tracked product
 * jumps to its detail page instead of the add form.
 */
export function getTrackerIdByNormalizedUrl(normalizedUrl: string, userId: number): number | null {
  const row = getDb().prepare(
    'SELECT id FROM trackers WHERE normalized_url = ? AND user_id = ? LIMIT 1',
  ).get(normalizedUrl, userId) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Latest record-low tier per tracker within the last 48h, for the dashboard
 * "All-time low / 90-day low" chips (deal-intelligence phase 1). One query
 * for the whole list view; a chip disappears on its own as the notification
 * ages out of the window.
 */
export function getRecentLowTiers(userId?: number): Map<number, string> {
  const rows = getDb().prepare(`
    SELECT n.tracker_id, n.alert_type, MAX(n.sent_at)
    FROM notifications n
    INNER JOIN trackers t ON t.id = n.tracker_id
    WHERE n.alert_type LIKE 'low_%'
      AND n.sent_at >= datetime('now', '-48 hours')
      ${userId !== undefined ? 'AND t.user_id = @userId' : ''}
    GROUP BY n.tracker_id
  `).all(userId !== undefined ? { userId } : {}) as Array<{ tracker_id: number; alert_type: string }>;
  return new Map(rows.map(r => [r.tracker_id, r.alert_type]));
}

/**
 * Daily-minimum price history for ONE tracker, restricted to 'new'-condition
 * sellers (deal-intelligence phase 1: a warehouse/refurb listing must not set
 * a "record low" for the product). Legacy rows with no tracker_url_id predate
 * the multi-seller/condition era and are treated as 'new'.
 */
export function getDailyMinHistoryForTracker(
  trackerId: number,
): Array<{ date: string; price: number }> {
  return getDb().prepare(`
    SELECT DATE(ph.scraped_at) AS date, MIN(ph.price) AS price
    FROM price_history ph
    LEFT JOIN tracker_urls tu ON tu.id = ph.tracker_url_id
    WHERE ph.tracker_id = ?
      AND ph.price > 0
      AND (ph.tracker_url_id IS NULL OR tu.condition = 'new')
    GROUP BY DATE(ph.scraped_at)
    ORDER BY DATE(ph.scraped_at) ASC
  `).all(trackerId) as Array<{ date: string; price: number }>;
}

export interface PublicProductStats {
  /** MIN(last_price) across all trackers sharing this normalized_url, or null. */
  lowest_current_price: number | null;
  /** MIN(price) across all price_history rows for this normalized_url, or null. */
  lowest_ever_price: number | null;
  /** Total price_history rows recorded for this normalized_url. */
  sample_count: number;
  /** ISO date (YYYY-MM-DD) of the first observation, or null if no history. */
  first_observed: string | null;
}

export function getStatsForNormalizedUrl(normalized_url: string): PublicProductStats {
  const db = getDb();
  const current = db.prepare(`
    SELECT MIN(last_price) AS low FROM trackers
    WHERE normalized_url = ? AND last_price IS NOT NULL
  `).get(normalized_url) as { low: number | null };

  const history = db.prepare(`
    SELECT
      MIN(ph.price) AS lowest_ever,
      COUNT(*) AS sample_count,
      MIN(DATE(ph.scraped_at)) AS first_observed
    FROM price_history ph
    INNER JOIN trackers t ON t.id = ph.tracker_id
    WHERE t.normalized_url = ?
  `).get(normalized_url) as { lowest_ever: number | null; sample_count: number; first_observed: string | null };

  return {
    lowest_current_price: current.low ?? null,
    lowest_ever_price: history.lowest_ever ?? null,
    sample_count: history.sample_count ?? 0,
    first_observed: history.first_observed ?? null,
  };
}

// === Community deal feed ===

/**
 * One entry in the public anonymous community deal feed at /deals. Sourced
 * from `notifications` (a notification fired = "the user's threshold was
 * beaten") joined to `public_product_slugs` for stable links to /p/<slug>.
 *
 * Privacy: NO user_id, NO tracker_id, NO usernames — only the product +
 * the price/threshold pair that fired and a coarse hours-ago timestamp.
 */
export interface DealFeedEntry {
  slug: string;
  display_name: string;
  current_price: number;
  threshold_price: number;
  drop_pct: number;
  hours_ago: number;
  normalized_url: string;
}

/**
 * Build the community deal feed: most-recent threshold-beating notification
 * per product, across users opted in via the `share_in_deal_feed` setting,
 * over the last 7 days, sorted by drop-pct desc.
 *
 * Implementation note: a simple `GROUP BY pps.slug HAVING n.id = MAX(n.id)`
 * on the joined rows is unreliable in SQLite when other (non-aggregated)
 * columns from `n` appear in the SELECT — the engine is allowed to pick any
 * row of the group for those bare columns. We instead pre-filter to the set
 * of "max id per tracker" notifications BEFORE the joins, which guarantees
 * one row per tracker (and therefore per product, given the tracker→
 * normalized_url→slug fan-in).
 */
export function getCommunityDealFeed(limit: number = 50): DealFeedEntry[] {
  return getDb().prepare(`
    SELECT pps.slug,
           pps.display_name,
           pps.normalized_url,
           n.price AS current_price,
           n.threshold_price,
           (n.threshold_price - n.price) * 1.0 / n.threshold_price AS drop_pct,
           CAST((julianday('now') - julianday(n.sent_at)) * 24 AS INTEGER) AS hours_ago
      FROM notifications n
      JOIN trackers t ON t.id = n.tracker_id
      JOIN public_product_slugs pps ON pps.normalized_url = t.normalized_url
      JOIN settings s ON s.user_id = t.user_id
                     AND s.key = 'share_in_deal_feed'
                     AND s.value = 'true'
     WHERE n.id IN (SELECT MAX(id) FROM notifications GROUP BY tracker_id)
       AND n.sent_at >= datetime('now', '-7 days')
       AND t.normalized_url IS NOT NULL
       AND n.threshold_price > 0
     GROUP BY pps.slug
     HAVING n.id = MAX(n.id)
     ORDER BY drop_pct DESC, n.sent_at DESC
     LIMIT ?
  `).all(limit) as DealFeedEntry[];
}

// === Wishlist / gift mode (migration v16) ===

/**
 * Generate or return the user's existing wishlist share token. Idempotent —
 * a user that already has a token gets the same one back; first-time callers
 * get a freshly-generated `wl_<32>` value.
 *
 * Token format: `wl_` + 32 base64url chars (24 random bytes → 32 chars).
 * 192 bits of entropy makes brute-force enumeration infeasible.
 */
export function generateOrGetWishlistShareToken(userId: number): string {
  const existing = getDb().prepare(
    'SELECT wishlist_share_token FROM users WHERE id = ?',
  ).get(userId) as { wishlist_share_token: string | null } | undefined;
  if (existing?.wishlist_share_token) return existing.wishlist_share_token;
  const token = 'wl_' + randomBytes(24).toString('base64url');
  getDb().prepare(
    'UPDATE users SET wishlist_share_token = ? WHERE id = ?',
  ).run(token, userId);
  return token;
}

/**
 * Replace the user's existing share token with a freshly-generated one.
 * Anyone holding the old link will hit a 404 on next request — by design.
 */
export function rotateWishlistShareToken(userId: number): string {
  const token = 'wl_' + randomBytes(24).toString('base64url');
  getDb().prepare(
    'UPDATE users SET wishlist_share_token = ? WHERE id = ?',
  ).run(token, userId);
  return token;
}

/**
 * Look up a user by their wishlist share token. Returns null on miss
 * (unknown / rotated / never-generated) so the route layer can 404 cleanly.
 */
export function getUserByWishlistToken(
  token: string,
): { id: number; display_name: string } | null {
  const row = getDb().prepare(
    'SELECT id, display_name FROM users WHERE wishlist_share_token = ?',
  ).get(token) as { id: number; display_name: string } | undefined;
  return row ?? null;
}

/**
 * Toggle the per-tracker is_wishlisted flag. Ownership-scoped — a user can
 * only flip their own trackers. Returns true on success, false on miss
 * (unknown id OR cross-user request — the route returns 404 either way).
 */
export function setTrackerWishlistFlag(
  trackerId: number,
  userId: number,
  isWishlisted: boolean,
): boolean {
  const result = getDb().prepare(
    'UPDATE trackers SET is_wishlisted = ? WHERE id = ? AND user_id = ?',
  ).run(isWishlisted ? 1 : 0, trackerId, userId);
  return result.changes > 0;
}

/**
 * Owner-side wishlist view. Returns the trackers this user has flagged as
 * wishlisted, ordered by name. Deliberately DOES NOT join wishlist_claims —
 * the owner stays surprise-blind. The dedicated public endpoint exposes
 * claim status to gift-givers; this helper is for the owner UI only.
 */
export function getOwnerWishlist(userId: number): Tracker[] {
  return getDb().prepare(
    `SELECT * FROM trackers WHERE user_id = ? AND is_wishlisted = 1 ORDER BY name`,
  ).all(userId) as Tracker[];
}

/**
 * One row of the public wishlist GET response. Carries only the fields safe
 * to expose to anonymous gift-givers: name, URL (so they can buy from the
 * retailer), current low price, AI verdict pill, and claim status. NO
 * threshold_price (that's the owner's private "buy under $X" target —
 * leaking it could be embarrassing).
 */
export interface PublicWishlistItem {
  tracker_id: number;
  name: string;
  url: string;
  last_price: number | null;
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
  is_claimed: boolean;
}

/**
 * Resolve a public-facing wishlist by share token. Returns the owner's
 * display name (gated by the share_display_name setting at the route level)
 * and a list of items with claim status. Null when the token doesn't match
 * a user — route layer 404s without leaking existence.
 */
export function getPublicWishlistByToken(
  token: string,
): { display_name: string; share_display_name_on: boolean; items: PublicWishlistItem[] } | null {
  const owner = getUserByWishlistToken(token);
  if (!owner) return null;
  const rows = getDb().prepare(`
    SELECT t.id AS tracker_id, t.name, t.url, t.last_price,
           t.ai_verdict_tier, t.ai_verdict_reason,
           CASE WHEN c.id IS NOT NULL THEN 1 ELSE 0 END AS is_claimed
    FROM trackers t
    LEFT JOIN wishlist_claims c ON c.tracker_id = t.id
    WHERE t.user_id = ? AND t.is_wishlisted = 1
    ORDER BY t.name
  `).all(owner.id) as Array<Omit<PublicWishlistItem, 'is_claimed'> & { is_claimed: number }>;
  // share_display_name is a per-user setting (the same one that gates
  // overlap-name visibility). Reuse it here so users have one consistent
  // "show my name in public surfaces" toggle.
  const shareSetting = getSetting('share_display_name', owner.id);
  return {
    display_name: owner.display_name,
    share_display_name_on: shareSetting === 'true',
    items: rows.map(r => ({ ...r, is_claimed: r.is_claimed === 1 })),
  };
}

/**
 * Claim a wishlist item. Returns the new claim_token on success or
 * { error: 'already_claimed' } if any row already exists. The simple
 * "any-claim wins" rule is intentional — there's no "second claim from a
 * different person" semantics; first-come gets it, others see "already
 * claimed by someone."
 */
export function createWishlistClaim(
  trackerId: number,
): { claim_token: string } | { error: 'already_claimed' } {
  const existing = getDb().prepare(
    'SELECT id FROM wishlist_claims WHERE tracker_id = ?',
  ).get(trackerId);
  if (existing) return { error: 'already_claimed' };
  const claim_token = 'wc_' + randomBytes(24).toString('base64url');
  getDb().prepare(
    'INSERT INTO wishlist_claims (tracker_id, claim_token, claimed_at) VALUES (?, ?, ?)',
  ).run(trackerId, claim_token, Date.now());
  return { claim_token };
}

/**
 * Release a claim. Requires the matching claim_token (the one returned at
 * claim creation, saved in the claimer's localStorage). Returns false if no
 * row matched the (tracker_id, claim_token) pair so the route layer 404s
 * without leaking whether the wrong token vs. wrong tracker caused the miss.
 */
export function deleteWishlistClaim(
  trackerId: number,
  claimToken: string,
): boolean {
  const result = getDb().prepare(
    'DELETE FROM wishlist_claims WHERE tracker_id = ? AND claim_token = ?',
  ).run(trackerId, claimToken);
  return result.changes > 0;
}

/**
 * True iff this tracker is currently flagged as wishlisted AND owned by
 * `userId`. The public claim endpoint uses this to verify a (token, tracker)
 * pair before creating a claim row — prevents claiming someone else's
 * non-wishlisted tracker by guessing IDs.
 */
export function isTrackerInUsersWishlist(
  trackerId: number,
  userId: number,
): boolean {
  const row = getDb().prepare(
    'SELECT is_wishlisted FROM trackers WHERE id = ? AND user_id = ?',
  ).get(trackerId, userId) as { is_wishlisted: number } | undefined;
  return !!row && row.is_wishlisted === 1;
}

// --- Purchases (migration v18) ---

/**
 * Log a purchase against a tracker. Snapshots first_price from the earliest
 * price_history row (the price we first saw this product at). If no history
 * exists, falls back to tracker.last_price; last resort, uses purchase_price
 * itself so first_price is never NULL.
 *
 * When opts.keep_watching is false, the tracker's status moves to
 * 'purchased' — the scheduler then excludes it from scrape candidates (see
 * getDueTrackerUrls). keep_watching=true leaves the tracker active so the
 * user can buy the same item again at a better price later.
 */
export function createPurchase(
  tracker_id: number,
  input: PurchaseInput,
  opts: { keep_watching: boolean },
): Purchase {
  const db = getDb();
  const tracker = getTrackerById(tracker_id);
  if (!tracker) throw new Error(`tracker not found: ${tracker_id}`);

  // Earliest observed price — the column on price_history is `scraped_at`.
  const earliest = db.prepare(
    `SELECT price FROM price_history WHERE tracker_id = ? ORDER BY scraped_at ASC, id ASC LIMIT 1`,
  ).get(tracker_id) as { price: number } | undefined;

  let first_price: number;
  if (earliest) {
    first_price = earliest.price;
  } else if (tracker.last_price != null) {
    first_price = tracker.last_price;
  } else {
    first_price = input.purchase_price;
  }

  const purchased_at = input.purchased_at ?? new Date().toISOString();
  const quantity = input.quantity ?? 1;
  const tracker_url_id = input.tracker_url_id ?? null;

  const row = db.prepare(
    `INSERT INTO purchases (tracker_id, tracker_url_id, purchase_price, quantity, first_price, purchased_at)
     VALUES (?, ?, ?, ?, ?, ?)
     RETURNING *`,
  ).get(
    tracker_id,
    tracker_url_id,
    input.purchase_price,
    quantity,
    first_price,
    purchased_at,
  ) as Purchase;

  const newStatus = opts.keep_watching ? 'active' : 'purchased';
  db.prepare(`UPDATE trackers SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newStatus, tracker_id);

  const saved = savingsForPurchase(row);
  logger.info(
    { tracker_id, purchase_id: row.id, saved, keep_watching: opts.keep_watching },
    'purchase_logged',
  );

  return row;
}

export function getPurchase(id: number): Purchase | undefined {
  return getDb()
    .prepare(`SELECT * FROM purchases WHERE id = ?`)
    .get(id) as Purchase | undefined;
}

/**
 * Paged list of purchases for a user, joined with the parent tracker for
 * display. `seller_label` is currently the seller URL — we don't yet store
 * a human-readable retailer name per seller. Sorted most-recent-first.
 */
export function listPurchases(args: {
  user_id: number;
  limit?: number;
  offset?: number;
}): { purchases: PurchaseWithTracker[]; total: number } {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const db = getDb();

  const rows = db.prepare(
    `SELECT p.*, t.name AS tracker_name, t.url AS tracker_url, tu.url AS seller_label
     FROM purchases p
     JOIN trackers t ON t.id = p.tracker_id
     LEFT JOIN tracker_urls tu ON tu.id = p.tracker_url_id
     WHERE t.user_id = ?
     ORDER BY p.purchased_at DESC, p.id DESC
     LIMIT ? OFFSET ?`,
  ).all(args.user_id, limit, offset) as PurchaseWithTracker[];

  const { total } = db.prepare(
    `SELECT COUNT(*) AS total
       FROM purchases p
       JOIN trackers t ON t.id = p.tracker_id
      WHERE t.user_id = ?`,
  ).get(args.user_id) as { total: number };

  return { purchases: rows, total };
}

/**
 * Patch a subset of purchase fields. Missing keys are left alone. Returns
 * the updated row. No-op patches just return the current row.
 */
export function updatePurchase(
  id: number,
  patch: Partial<Pick<Purchase, 'purchase_price' | 'quantity' | 'purchased_at' | 'tracker_url_id'>>,
): Purchase {
  const db = getDb();
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.purchase_price !== undefined) { sets.push('purchase_price = ?'); values.push(patch.purchase_price); }
  if (patch.quantity       !== undefined) { sets.push('quantity = ?');       values.push(patch.quantity); }
  if (patch.purchased_at   !== undefined) { sets.push('purchased_at = ?');   values.push(patch.purchased_at); }
  if (patch.tracker_url_id !== undefined) { sets.push('tracker_url_id = ?'); values.push(patch.tracker_url_id); }
  if (sets.length === 0) return getPurchase(id)!;
  values.push(id);
  return db.prepare(
    `UPDATE purchases SET ${sets.join(', ')} WHERE id = ? RETURNING *`,
  ).get(...values) as Purchase;
}

/**
 * Delete a purchase by id. If this was the last purchase on its tracker
 * AND the tracker is currently 'purchased', revert it to 'active' so the
 * scheduler picks it back up — otherwise a user who logs and then undoes
 * a purchase ends up with a permanently paused tracker.
 */
export function deletePurchase(id: number): void {
  const db = getDb();
  const p = getPurchase(id);
  if (!p) return;
  db.prepare(`DELETE FROM purchases WHERE id = ?`).run(id);
  const remaining = db.prepare(
    `SELECT COUNT(*) AS n FROM purchases WHERE tracker_id = ?`,
  ).get(p.tracker_id) as { n: number };
  if (remaining.n === 0) {
    db.prepare(
      `UPDATE trackers SET status = 'active', updated_at = datetime('now')
       WHERE id = ? AND status = 'purchased'`,
    ).run(p.tracker_id);
  }
}

/**
 * Site-wide savings rollup. Sums savingsForPurchase() across all rows.
 * Monthly buckets use the YYYY-MM prefix of purchased_at; the array is
 * sorted oldest-first so a chart can render left-to-right. Total is
 * rounded to two decimals so the public footer doesn't show $123.4500001.
 * No user-scoping — this is the public aggregate.
 */
export function getSavingsSummary(): SavingsSummary {
  const db = getDb();
  const rows = db.prepare(
    `SELECT first_price, purchase_price, quantity, purchased_at FROM purchases`,
  ).all() as Array<Pick<Purchase, 'first_price' | 'purchase_price' | 'quantity' | 'purchased_at'>>;

  let total_saved = 0;
  let earliest: string | null = null;
  const byMonth = new Map<string, number>();

  for (const r of rows) {
    const saved = savingsForPurchase(r);
    total_saved += saved;
    const month = r.purchased_at.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + saved);
    if (earliest === null || r.purchased_at < earliest) earliest = r.purchased_at;
  }

  const monthly = [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, saved]) => ({ month, saved: Math.round(saved * 100) / 100 }));

  return {
    total_saved: Math.round(total_saved * 100) / 100,
    purchase_count: rows.length,
    since: earliest,
    monthly,
  };
}


