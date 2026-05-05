// server/src/projects/types.ts

export interface Project {
  id: number;
  user_id: number;
  name: string;
  target_total: number;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface ProjectTracker {
  project_id: number;
  tracker_id: number;
  per_item_ceiling: number | null;
  position: number;
  created_at: string;
}

export interface BasketMember {
  tracker_id: number;
  tracker_name: string;
  last_price: number | null;
  tracker_status: 'active' | 'paused' | 'error';
  per_item_ceiling: number | null;
  position: number;
  // Surfaced for the project detail view (set by AI Buyer's Assistant).
  ai_verdict_tier: 'BUY' | 'WAIT' | 'HOLD' | null;
  ai_verdict_reason: string | null;
}

export type IneligibleReason =
  | 'no_items'
  | 'item_missing_price'
  | 'item_errored'
  | 'over_target';

export interface BasketState {
  total: number | null;
  target_total: number;
  item_count: number;
  items_with_price: number;
  items_below_ceiling: number;
  eligible: boolean;
  ineligible_reason: IneligibleReason | null;
}
