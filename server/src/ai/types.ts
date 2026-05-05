// server/src/ai/types.ts

export type VerdictTier = 'BUY' | 'WAIT' | 'HOLD';

export type ReasonKey =
  | 'gathering_data'
  | 'at_all_time_low'
  | 'in_bottom_decile'
  | 'below_threshold_at_window_low'
  | 'fake_msrp_or_near_high'
  | 'rising_trend'
  | 'at_30d_low'
  | 'no_notable_signal';

export interface Verdict {
  tier: VerdictTier;
  reasonKey: ReasonKey;
}

export interface PriceObservation {
  price: number;
  recorded_at: number; // unix ms
}

export interface Signals {
  // data sufficiency
  data_days: number;
  data_points: number;

  // price position
  current_price: number;
  all_time_low: number;
  all_time_high: number;
  current_percentile: number;

  // window comparisons (ratios; 1.0 = at the window low)
  vs_30d_low: number;
  vs_90d_low: number;
  vs_all_time_low: number;
  vs_all_time_high: number;

  // recency
  days_since_all_time_low: number; // always present because all_time_low is guaranteed to exist in the history
  days_at_current_or_lower: number;

  // dwell
  times_at_or_below_current: number;
  avg_dwell_days_at_low: number | null;

  // direction
  trend_30d: 'falling' | 'flat' | 'rising';
  consecutive_drops: number;

  // user-relative
  threshold: number | null;
  pct_below_threshold: number | null;

  // cohort (existing community-low feature)
  community_low: number | null;
  vs_community_low: number | null;
}

export type AIGenerationCategory =
  | 'timeout'
  | 'rate_limit'
  | 'api_error'
  | 'validation_error'
  | 'kill_switch';

export class AIGenerationError extends Error {
  constructor(
    public category: AIGenerationCategory,
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = 'AIGenerationError';
  }
}
