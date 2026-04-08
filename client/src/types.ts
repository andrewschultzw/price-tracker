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
  // Aggregates populated by the admin + user tracker list endpoints.
  // Optional because single-tracker endpoints (GET /trackers/:id) may not
  // include them.
  seller_count?: number;
  errored_seller_count?: number;
  best_seller_url?: string | null;
}

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

export interface ScrapeResult {
  price: number;
  currency: string;
  strategy: string;
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
