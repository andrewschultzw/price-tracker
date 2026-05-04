import type { Signals, Verdict } from './types.js';

export function signalsToVerdict(s: Signals): Verdict {
  if (s.data_days < 14) {
    return { tier: 'HOLD', reasonKey: 'gathering_data' };
  }

  // Strong BUY signals
  if (s.vs_all_time_low <= 1.02) {
    return { tier: 'BUY', reasonKey: 'at_all_time_low' };
  }
  if (s.current_percentile <= 0.10 && s.data_days >= 30) {
    return { tier: 'BUY', reasonKey: 'in_bottom_decile' };
  }
  if (s.pct_below_threshold !== null && s.pct_below_threshold >= 5 && s.vs_30d_low <= 1.00) {
    return { tier: 'BUY', reasonKey: 'below_threshold_at_window_low' };
  }

  // WAIT signals
  if (s.vs_all_time_high <= 1.05 && s.current_percentile >= 0.80) {
    return { tier: 'WAIT', reasonKey: 'fake_msrp_or_near_high' };
  }
  if (s.trend_30d === 'rising' && s.current_percentile >= 0.70) {
    return { tier: 'WAIT', reasonKey: 'rising_trend' };
  }

  // Soft BUY
  if (s.vs_30d_low <= 1.02) {
    return { tier: 'BUY', reasonKey: 'at_30d_low' };
  }

  return { tier: 'HOLD', reasonKey: 'no_notable_signal' };
}
