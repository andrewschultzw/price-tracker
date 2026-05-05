import { describe, it, expect } from 'vitest';
import { signalsToVerdict } from './verdict.js';
import type { Signals } from './types.js';

const baseSignals: Signals = {
  data_days: 60, data_points: 60,
  current_price: 100, all_time_low: 90, all_time_high: 120, current_percentile: 0.5,
  vs_30d_low: 1.1, vs_90d_low: 1.1, vs_all_time_low: 1.1, vs_all_time_high: 0.83,
  days_since_all_time_low: 30, days_at_current_or_lower: 0,
  times_at_or_below_current: 5, avg_dwell_days_at_low: 3,
  trend_30d: 'flat', consecutive_drops: 0,
  threshold: null, pct_below_threshold: null,
  community_low: null, vs_community_low: null,
};

const s = (overrides: Partial<Signals> = {}): Signals => ({ ...baseSignals, ...overrides });

describe('signalsToVerdict', () => {
  it('HOLD/gathering_data when data_days < 14', () => {
    expect(signalsToVerdict(s({ data_days: 13 }))).toEqual({ tier: 'HOLD', reasonKey: 'gathering_data' });
  });

  it('BUY/at_all_time_low when within 2% of ATL', () => {
    expect(signalsToVerdict(s({ vs_all_time_low: 1.01 }))).toEqual({ tier: 'BUY', reasonKey: 'at_all_time_low' });
    expect(signalsToVerdict(s({ vs_all_time_low: 1.02 }))).toEqual({ tier: 'BUY', reasonKey: 'at_all_time_low' });
  });

  it('BUY/in_bottom_decile when percentile <= 0.10 and data_days >= 30', () => {
    expect(signalsToVerdict(s({ vs_all_time_low: 1.05, current_percentile: 0.05, data_days: 30 })))
      .toEqual({ tier: 'BUY', reasonKey: 'in_bottom_decile' });
  });

  it('does NOT use bottom-decile rule when data_days < 30', () => {
    const v = signalsToVerdict(s({ vs_all_time_low: 1.05, current_percentile: 0.05, data_days: 20 }));
    expect(v.reasonKey).not.toBe('in_bottom_decile');
  });

  it('BUY/below_threshold_at_window_low when pct_below_threshold>=5 and at 30d low', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.10, current_percentile: 0.30,
      pct_below_threshold: 7, vs_30d_low: 1.0,
    }))).toEqual({ tier: 'BUY', reasonKey: 'below_threshold_at_window_low' });
  });

  it('WAIT/fake_msrp_or_near_high when near all-time high and high percentile', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.30, vs_all_time_high: 1.02, current_percentile: 0.85,
    }))).toEqual({ tier: 'WAIT', reasonKey: 'fake_msrp_or_near_high' });
  });

  it('WAIT/rising_trend when trend rising and high percentile', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.20, current_percentile: 0.75, trend_30d: 'rising',
    }))).toEqual({ tier: 'WAIT', reasonKey: 'rising_trend' });
  });

  it('BUY/at_30d_low when at 30d window low (soft BUY)', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.20, vs_30d_low: 1.01, current_percentile: 0.40,
    }))).toEqual({ tier: 'BUY', reasonKey: 'at_30d_low' });
  });

  it('HOLD/no_notable_signal when nothing matches', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.20, vs_30d_low: 1.10, current_percentile: 0.50,
    }))).toEqual({ tier: 'HOLD', reasonKey: 'no_notable_signal' });
  });

  it('strong BUY beats WAIT — at_all_time_low wins over rising_trend', () => {
    expect(signalsToVerdict(s({
      vs_all_time_low: 1.01, trend_30d: 'rising', current_percentile: 0.85,
    }))).toEqual({ tier: 'BUY', reasonKey: 'at_all_time_low' });
  });

  it('boundary: vs_all_time_low exactly 1.02 still BUYs', () => {
    expect(signalsToVerdict(s({ vs_all_time_low: 1.02 })).tier).toBe('BUY');
  });

  it('boundary: vs_all_time_low 1.021 falls through ATL rule', () => {
    expect(signalsToVerdict(s({ vs_all_time_low: 1.021 })).reasonKey).not.toBe('at_all_time_low');
  });

  it('boundary: data_days exactly 14 leaves gathering_data', () => {
    const v = signalsToVerdict(s({ data_days: 14 }));
    expect(v.reasonKey).not.toBe('gathering_data');
  });
});
