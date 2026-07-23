// Server-side tracker.status union. 'purchased' was added with the
// purchased-tracking feature — extends scheduling so purchased trackers
// stop being scraped while keeping their history intact.
export type TrackerStatus = 'active' | 'paused' | 'error' | 'blocked' | 'purchased';

export interface Tracker {
  id: number;
  name: string;
  url: string;
  normalized_url: string | null;
  threshold_price: number | null;
  check_interval_minutes: number;
  css_selector: string | null;
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  status: TrackerStatus;
  created_at: string;
  updated_at: string;
  // Aggregates populated by the admin + user tracker list endpoints.
  // Optional because single-tracker endpoints (GET /trackers/:id) may not
  // include them.
  seller_count?: number;
  errored_seller_count?: number;
  // Sellers affirmatively out of stock (server migration v21, phase 4).
  oos_seller_count?: number;
  best_seller_url?: string | null;
  // AI Buyer's Assistant fields (server migration v8). All optional in the
  // type because legacy responses + endpoints that don't populate them may
  // omit them. Snake_case mirrors the server pass-through convention.
  ai_verdict_tier?: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason?: string | null;
  ai_verdict_reason_key?: string | null;
  ai_verdict_updated_at?: number | null;
  ai_summary?: string | null;
  ai_summary_updated_at?: number | null;
  ai_signals_json?: string | null;
  ai_failure_count?: number;
  // Doorbuster mode (server migration v14). All three nullable; "active"
  // only when all three are populated AND `now` is between start and end.
  // ISO 8601 timestamps; interval is in minutes.
  doorbuster_start_at?: string | null;
  doorbuster_end_at?: string | null;
  doorbuster_interval_minutes?: number | null;
  // Wishlist toggle (server migration v16). The server stores 0/1 in SQLite;
  // the JSON response coerces to boolean at the route boundary on writes via
  // PUT /trackers/:id, but list/detail responses pass the raw 0/1 through —
  // hence the boolean | number union here. Treat truthy values as "on."
  is_wishlisted?: boolean | number;
  // Autonomous purchasing / buy-arm fields (server migration v19).
  // buy_armed: 1 when an active purchase intent exists, 0 otherwise.
  // buy_quantity: how many units to buy when the arm fires.
  buy_armed?: number;
  buy_quantity?: number;
  // Record-low alert mode (server migration v20, deal-intelligence phase 1).
  low_alert_mode?: 'all' | 'record_only' | 'off';
  // Computed by the list endpoint only: the record-low tier of an alert that
  // fired within the last 48h, for the dashboard chip. Null/absent otherwise.
  recent_low_tier?: 'low_30d' | 'low_90d' | 'low_all_time' | null;
}

// GET /api/trackers/:id/stats response (deal-intelligence phase 1).
export interface WindowStats {
  min: number | null;
  max: number | null;
  median: number | null;
  points: number;
}

export interface TrackerPriceStats {
  span_days: number;
  windows: { w30: WindowStats; w90: WindowStats; w365: WindowStats; all: WindowStats };
  suggested_threshold: number | null;
  threshold_staleness: 'stale_low' | 'stale_high' | null;
  current_percentile_90d: number | null;
  low_alert_mode: 'all' | 'record_only' | 'off';
}

// Listing condition for a per-seller URL. Mirrors the server enum.
// Non-'new' values surface as a badge in the UI and a tag in alert text.
export type TrackerUrlCondition = 'new' | 'warehouse' | 'refurb' | 'open_box';

// Per-seller row (one row per URL under a tracker).
export interface TrackerUrl {
  id: number;
  tracker_id: number;
  url: string;
  position: number;
  last_price: number | null;
  last_checked_at: string | null;
  last_error: string | null;
  consecutive_failures: number;
  status: 'active' | 'paused' | 'error' | 'blocked';
  condition: TrackerUrlCondition;
  created_at: string;
  updated_at: string;
  availability?: 'unknown' | 'in_stock' | 'out_of_stock';
  availability_changed_at?: string | null;
}

export interface PriceRecord {
  id: number;
  tracker_id: number;
  // Nullable for legacy pre-multi-seller rows; populated for all new scrapes.
  tracker_url_id?: number | null;
  // The URL of the seller that produced this price. Nullable for pre-migration
  // rows. Used by the PriceChart to color-code per-seller lines.
  seller_url?: string | null;
  price: number;
  currency: string;
  scraped_at: string;
}

export interface ScrapeResult {
  // Absent when the page is affirmatively out of stock (outOfStock: true).
  price?: number;
  currency?: string;
  strategy?: string;
  // Product name from structured data (share-flow autofill). Optional for
  // back-compat with cached responses; null on the css-selector fast path.
  title?: string | null;
  // Back-in-stock (phase 4): the page loaded and reported itself out of
  // stock — a healthy result with no purchasable price.
  outOfStock?: boolean;
}

export interface User {
  id: number;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  is_active: number;
  created_at: string;
  updated_at: string;
  // Only present when returned from the admin users endpoint.
  tracker_count?: number;
}

export interface InviteCode {
  id: number;
  code: string;
  created_by: number;
  used_by: number | null;
  expires_at: string | null;
  created_at: string;
}

export interface SetupStatus {
  needsSetup: boolean;
  hasSetupToken: boolean;
}

export interface Overlap {
  count: number;
  names: string[];
  communityLow: number | null;
}

// === Bundle Tracker (server migration v9) ===

export type IneligibleReason =
  | 'no_items'
  | 'item_missing_price'
  | 'item_errored'
  | 'over_target';

export interface Project {
  id: number;
  user_id: number;
  name: string;
  target_total: number;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface BasketMember {
  tracker_id: number;
  tracker_name: string;
  last_price: number | null;
  tracker_status: 'active' | 'paused' | 'error' | 'blocked';
  per_item_ceiling: number | null;
  position: number;
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
}

export interface ProjectNotificationRecord {
  id: number;
  project_id: number;
  channel: string;
  basket_total: number;
  target_total: number;
  ai_commentary: string | null;
  sent_at: string;
}

export interface ProjectDetail {
  project: Project;
  members: BasketMember[];
  recent_notifications: ProjectNotificationRecord[];
}

/** Composite project verdict (deterministic, client-side derivation). */
export type CompositeVerdictTier = 'BUY' | 'WAIT' | 'HOLD';

// === Web Push (PWA notifications) ===

export interface WebPushDevice {
  id: number;
  device_label: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface SubscribePayload {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  device_label?: string;
}

// === Purchased tracking + savings rollup ===

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

// API response shape for GET /api/purchases. The server aliases
// `tracker_urls.url AS seller_label`, so `seller_label` is the raw
// URL string — derive a human label client-side via `new URL(...).hostname`.
export interface PurchaseWithTracker extends Purchase {
  tracker_name: string;
  tracker_url: string;
  seller_label: string | null;
}

export interface SavingsSummary {
  total_saved: number;
  purchase_count: number;
  since: string | null;
  monthly: Array<{ month: string; saved: number }>;
}

/**
 * Computed savings for a single purchase. Mirrors the server's
 * `savingsForPurchase` helper. Clamps negatives to $0 so a buyer who
 * paid more than the first observed price doesn't show as "negative
 * savings" — the UI treats this as "no savings recorded".
 */
export function savedAmount(p: Pick<Purchase, 'first_price' | 'purchase_price' | 'quantity'>): number {
  return Math.max(0, (p.first_price - p.purchase_price) * p.quantity);
}
