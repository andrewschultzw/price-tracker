import { describe, it, expect } from 'vitest';
import { computeConfidence } from './confidence.js';
import type { Signals } from './types.js';

/**
 * Minimal Signals factory for these tests. Every numeric field defaults
 * to a "boring" value so each test can override only the dimensions it
 * cares about — keeps each test focused on the rule under examination.
 */
function makeSignals(overrides: Partial<Signals> = {}): Signals {
  return {
    data_days: 90,
    data_points: 100,

    current_price: 50,
    all_time_low: 30,
    all_time_high: 100,
    current_percentile: 0.5,

    vs_30d_low: 1.5,
    vs_90d_low: 1.5,
    vs_all_time_low: 1.5,
    vs_all_time_high: 0.5,

    days_since_all_time_low: 10,
    days_at_current_or_lower: 0,

    times_at_or_below_current: 20,
    avg_dwell_days_at_low: null,

    trend_30d: 'flat',
    consecutive_drops: 0,

    threshold: null,
    pct_below_threshold: null,

    community_low: null,
    vs_community_low: null,

    ...overrides,
  };
}

describe('computeConfidence — level classification', () => {
  it('returns HIGH when current is in lowest decile and rare in absolute count', () => {
    // 100 data points → max(3, 100*0.05) = 5; 4 ≤ 5 satisfies rare count
    const signals = makeSignals({
      current_percentile: 0.05,
      times_at_or_below_current: 4,
      data_points: 100,
    });
    expect(computeConfidence(signals).level).toBe('HIGH');
  });

  it('returns MEDIUM when percentile ≤ 0.25 but not rare in absolute count', () => {
    // 100 data points → max(3, 5) = 5; 50 ≫ 5 disqualifies HIGH
    const signals = makeSignals({
      current_percentile: 0.20,
      times_at_or_below_current: 50,
    });
    expect(computeConfidence(signals).level).toBe('MEDIUM');
  });

  it('returns MEDIUM when percentile ≤ 0.10 but absolute count is too high', () => {
    // Failing only the second HIGH condition pushes us to MEDIUM
    const signals = makeSignals({
      current_percentile: 0.08,
      times_at_or_below_current: 30,
      data_points: 100,
    });
    expect(computeConfidence(signals).level).toBe('MEDIUM');
  });

  it('returns LOW when percentile is above 0.25', () => {
    expect(computeConfidence(makeSignals({ current_percentile: 0.40 })).level).toBe('LOW');
  });

  it('uses rareCountThreshold floor of 3 for tiny datasets', () => {
    // 20 data points → max(3, 1) = 3; 3 satisfies HIGH count condition
    const signals = makeSignals({
      current_percentile: 0.05,
      times_at_or_below_current: 3,
      data_points: 20,
    });
    expect(computeConfidence(signals).level).toBe('HIGH');
  });
});

describe('computeConfidence — reason templates', () => {
  it('rule 1: 12-month low fires when at ATL and data_days >= 365', () => {
    const c = computeConfidence(makeSignals({
      vs_all_time_low: 1.0,
      data_days: 400,
      // suppress later rules so rule 1 is unambiguous
      times_at_or_below_current: 50,
      avg_dwell_days_at_low: null,
      current_percentile: 0.5,
    }));
    expect(c.reasons[0]).toBe('12-month low');
  });

  it('rule 2: all-time low fires when at ATL but data_days < 365', () => {
    const c = computeConfidence(makeSignals({
      vs_all_time_low: 1.0,
      data_days: 90,
      times_at_or_below_current: 50,
      current_percentile: 0.5,
    }));
    expect(c.reasons[0]).toBe('all-time low');
  });

  it('12-month low takes precedence over all-time low when both conditions apply', () => {
    const c = computeConfidence(makeSignals({
      vs_all_time_low: 1.0,
      data_days: 365, // boundary
      times_at_or_below_current: 50,
      current_percentile: 0.5,
    }));
    expect(c.reasons).toContain('12-month low');
    expect(c.reasons).not.toContain('all-time low');
  });

  it('rule 3: 30-day low fires when not at all-time low', () => {
    const c = computeConfidence(makeSignals({
      vs_30d_low: 1.0,
      vs_all_time_low: 1.2,
      times_at_or_below_current: 50,
      current_percentile: 0.5,
    }));
    expect(c.reasons[0]).toBe('30-day low');
  });

  it('rule 3: 30-day low is suppressed when already reporting all-time low', () => {
    const c = computeConfidence(makeSignals({
      vs_all_time_low: 1.0,
      vs_30d_low: 1.0,
      data_days: 90,
      times_at_or_below_current: 50,
      current_percentile: 0.5,
    }));
    expect(c.reasons).toContain('all-time low');
    expect(c.reasons).not.toContain('30-day low');
  });

  it('rule 4 ordinal: 1 → "first time at this price"', () => {
    const c = computeConfidence(makeSignals({
      times_at_or_below_current: 1,
      // disable earlier rules
      vs_all_time_low: 1.2,
      vs_30d_low: 1.2,
      current_percentile: 0.5,
    }));
    expect(c.reasons[0]).toBe('first time at this price');
  });

  it('rule 4 ordinal: 2 → "2nd time at this price"', () => {
    const c = computeConfidence(makeSignals({
      times_at_or_below_current: 2,
      vs_all_time_low: 1.2,
      vs_30d_low: 1.2,
      current_percentile: 0.5,
    }));
    expect(c.reasons[0]).toBe('2nd time at this price');
  });

  it('rule 4 ordinal: 3 → "3rd time at this price"', () => {
    const c = computeConfidence(makeSignals({
      times_at_or_below_current: 3,
      vs_all_time_low: 1.2,
      vs_30d_low: 1.2,
      current_percentile: 0.5,
    }));
    expect(c.reasons[0]).toBe('3rd time at this price');
  });

  it('rule 5: percentile statement fires when percentile ≤ 0.10', () => {
    const c = computeConfidence(makeSignals({
      current_percentile: 0.05,
      // skip rules 1-4
      vs_all_time_low: 1.5,
      vs_30d_low: 1.5,
      times_at_or_below_current: 50,
    }));
    expect(c.reasons[0]).toBe('top 10% lowest in dataset');
  });

  it('rule 6: days_since_all_time_low > 60 → "first time below $X in N+ months"', () => {
    const c = computeConfidence(makeSignals({
      current_price: 24.99,
      days_since_all_time_low: 125, // 4+ months
      vs_all_time_low: 1.05,         // not at ATL
      vs_30d_low: 1.5,
      times_at_or_below_current: 50,
      current_percentile: 0.5,
    }));
    expect(c.reasons[0]).toBe('first time below $24.99 in 4+ months');
  });

  it('rule 7: avg_dwell_days_at_low → "typically holds ~N days"', () => {
    const c = computeConfidence(makeSignals({
      avg_dwell_days_at_low: 5.4,
      // skip earlier rules
      vs_all_time_low: 1.5,
      vs_30d_low: 1.5,
      times_at_or_below_current: 50,
      current_percentile: 0.5,
      days_since_all_time_low: 10,
    }));
    expect(c.reasons[0]).toBe('typically holds ~5 days');
  });
});

describe('computeConfidence — reason capping', () => {
  it('caps reasons at 2 even when many rules fire', () => {
    // Stack vs_all_time_low + 12-month + percentile + dwell — all match
    const c = computeConfidence(makeSignals({
      vs_all_time_low: 1.0,
      data_days: 400,
      vs_30d_low: 1.0,
      times_at_or_below_current: 1,
      current_percentile: 0.05,
      avg_dwell_days_at_low: 5,
      days_since_all_time_low: 0,
    }));
    expect(c.reasons.length).toBeLessThanOrEqual(2);
    // Priority: 12-month low first, then ordinal "first time at this price"
    // (rule 3 is suppressed because we're already at ATL).
    expect(c.reasons[0]).toBe('12-month low');
    expect(c.reasons[1]).toBe('first time at this price');
  });

  it('preserves rule priority order when capping', () => {
    // Rule 3 (30-day low) and rule 7 (dwell) both match but only first 2 of
    // any 3+ matches are kept.
    const c = computeConfidence(makeSignals({
      vs_all_time_low: 1.2,
      vs_30d_low: 1.0,
      times_at_or_below_current: 2,
      current_percentile: 0.05,
      avg_dwell_days_at_low: 5,
    }));
    expect(c.reasons).toEqual(['30-day low', '2nd time at this price']);
  });
});

describe('computeConfidence — LOW alerts still get reasons', () => {
  it('LOW level emits reasons when applicable', () => {
    const c = computeConfidence(makeSignals({
      current_percentile: 0.5, // LOW
      vs_all_time_low: 1.2,
      vs_30d_low: 1.0,         // 30-day low still meaningful
      times_at_or_below_current: 50,
    }));
    expect(c.level).toBe('LOW');
    expect(c.reasons).toContain('30-day low');
  });

  it('LOW level with no triggers returns empty reasons', () => {
    const c = computeConfidence(makeSignals({
      current_percentile: 0.5,
      vs_all_time_low: 1.2,
      vs_30d_low: 1.5,
      times_at_or_below_current: 50,
      avg_dwell_days_at_low: null,
      days_since_all_time_low: 10,
    }));
    expect(c.level).toBe('LOW');
    expect(c.reasons).toEqual([]);
  });
});
