// Manual mirror of server/src/db/queries.ts Tracker type. Keep in sync
// with the server's createSchema (POST /api/trackers body).
export interface TrackerCreatePayload {
  name: string;
  url: string;
  threshold_price?: number | null;
  check_interval_minutes?: number;
  css_selector?: string | null;
}

export interface Tracker {
  id: number;
  name: string;
  url: string;
  normalized_url: string | null;
  threshold_price: number | null;
  check_interval_minutes: number;
  last_price: number | null;
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
}
