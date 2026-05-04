import { describe, it, expect } from 'vitest';
import { computeSignals } from './signals.js';
import type { PriceObservation } from './types.js';

const MS_PER_DAY = 86_400_000;
const NOW = 1_715_000_000_000; // fixed reference for deterministic tests

function buildHistory(prices: number[], startDaysAgo: number, stepDays = 1): PriceObservation[] {
  return prices.map((price, i) => ({
    price,
    recorded_at: NOW - (startDaysAgo - i * stepDays) * MS_PER_DAY,
  }));
}

describe('computeSignals — sparse data', () => {
  it('returns null when history is empty', () => {
    expect(computeSignals([], 10, null, NOW)).toBeNull();
  });

  it('returns null when only one observation', () => {
    expect(computeSignals(buildHistory([10], 0), 10, null, NOW)).toBeNull();
  });
});

describe('computeSignals — basic stats', () => {
  it('computes data_days as span between first and last observation', () => {
    const h = buildHistory([10, 12, 11, 9, 10], 60, 15);
    const s = computeSignals(h, 10, null, NOW)!;
    expect(s.data_days).toBe(60);
  });

  it('records data_points equal to history length', () => {
    const h = buildHistory([10, 11, 12], 30, 10);
    expect(computeSignals(h, 12, null, NOW)!.data_points).toBe(3);
  });

  it('finds all_time_low and all_time_high across history', () => {
    const h = buildHistory([15, 20, 10, 25, 18], 60, 12);
    const s = computeSignals(h, 18, null, NOW)!;
    expect(s.all_time_low).toBe(10);
    expect(s.all_time_high).toBe(25);
  });
});

describe('computeSignals — current_percentile', () => {
  it('is 0 when current price is at the all-time low', () => {
    const h = buildHistory([20, 15, 10, 12, 18], 60, 12);
    expect(computeSignals(h, 10, null, NOW)!.current_percentile).toBe(0);
  });

  it('is 1 when current price is at the all-time high', () => {
    const h = buildHistory([10, 15, 20, 12, 18], 60, 12);
    expect(computeSignals(h, 20, null, NOW)!.current_percentile).toBe(1);
  });

  it('is approximately 0.5 when current is the median', () => {
    const h = buildHistory([10, 15, 20, 25, 30], 60, 12);
    const p = computeSignals(h, 20, null, NOW)!.current_percentile;
    expect(p).toBeGreaterThan(0.4);
    expect(p).toBeLessThan(0.6);
  });
});

describe('computeSignals — window comparisons', () => {
  it('vs_all_time_low is 1.0 when current matches the low', () => {
    const h = buildHistory([20, 15, 10, 25, 18], 60, 12);
    expect(computeSignals(h, 10, null, NOW)!.vs_all_time_low).toBe(1.0);
  });

  it('vs_all_time_low is current/low (>1)', () => {
    const h = buildHistory([20, 15, 10, 25, 18], 60, 12);
    expect(computeSignals(h, 12, null, NOW)!.vs_all_time_low).toBeCloseTo(1.2);
  });

  it('vs_all_time_high is small when current is near the MSRP-style high', () => {
    const h = buildHistory([100, 90, 85, 95, 99], 60, 12);
    expect(computeSignals(h, 99, null, NOW)!.vs_all_time_high).toBeCloseTo(0.99);
  });

  it('vs_30d_low only considers obs within 30d', () => {
    const h: PriceObservation[] = [
      { price: 5, recorded_at: NOW - 60 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 10 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 25, null, NOW)!.vs_30d_low).toBeCloseTo(1.25);
  });
});

describe('computeSignals — recency', () => {
  it('days_since_all_time_low is correct when low was N days ago', () => {
    const h: PriceObservation[] = [
      { price: 20, recorded_at: NOW - 60 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 25 * MS_PER_DAY },
      { price: 15, recorded_at: NOW - 5 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 15, null, NOW)!.days_since_all_time_low).toBe(25);
  });

  it('days_at_current_or_lower spans the consecutive at-or-below run from latest', () => {
    const h: PriceObservation[] = [
      { price: 20, recorded_at: NOW - 60 * MS_PER_DAY },
      { price: 12, recorded_at: NOW - 20 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 5 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 1 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 10, null, NOW)!.days_at_current_or_lower).toBe(4);
  });
});

describe('computeSignals — dwell', () => {
  it('counts times_at_or_below_current across full history', () => {
    const h = buildHistory([20, 10, 15, 9, 25, 10], 100, 20);
    expect(computeSignals(h, 10, null, NOW)!.times_at_or_below_current).toBe(3);
  });

  it('avg_dwell_days_at_low is null when no historical low runs rebounded', () => {
    const h = buildHistory([10, 10, 10], 30, 10);
    expect(computeSignals(h, 10, null, NOW)!.avg_dwell_days_at_low).toBeNull();
  });

  it('computes avg_dwell as mean span of low runs that rebounded', () => {
    const h: PriceObservation[] = [
      { price: 10, recorded_at: NOW - 50 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 48 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 40 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 30 * MS_PER_DAY },
      { price: 25, recorded_at: NOW - 20 * MS_PER_DAY },
    ];
    const s = computeSignals(h, 10, null, NOW)!;
    expect(s.avg_dwell_days_at_low).toBeCloseTo(1, 1);
  });
});

describe('computeSignals — direction', () => {
  it('trend_30d is "rising" when prices in window go up overall', () => {
    const h: PriceObservation[] = [
      { price: 10, recorded_at: NOW - 28 * MS_PER_DAY },
      { price: 15, recorded_at: NOW - 14 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 1 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 20, null, NOW)!.trend_30d).toBe('rising');
  });

  it('trend_30d is "falling" when prices in window go down', () => {
    const h: PriceObservation[] = [
      { price: 30, recorded_at: NOW - 28 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 14 * MS_PER_DAY },
      { price: 10, recorded_at: NOW - 1 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 10, null, NOW)!.trend_30d).toBe('falling');
  });

  it('trend_30d is "flat" when prices are essentially level', () => {
    const h: PriceObservation[] = [
      { price: 20, recorded_at: NOW - 28 * MS_PER_DAY },
      { price: 21, recorded_at: NOW - 14 * MS_PER_DAY },
      { price: 20, recorded_at: NOW - 1 * MS_PER_DAY },
    ];
    expect(computeSignals(h, 20, null, NOW)!.trend_30d).toBe('flat');
  });

  it('consecutive_drops counts strictly decreasing tail', () => {
    const h = buildHistory([10, 15, 20, 18, 14, 11], 50, 10);
    expect(computeSignals(h, 11, null, NOW)!.consecutive_drops).toBe(3);
  });
});

describe('computeSignals — user-relative + community', () => {
  it('pct_below_threshold is positive when current is under threshold', () => {
    const h = buildHistory([20, 15, 10], 30, 10);
    expect(computeSignals(h, 10, 12, NOW)!.pct_below_threshold).toBeCloseTo(16.66, 1);
  });

  it('pct_below_threshold is null when threshold is null', () => {
    const h = buildHistory([20, 15, 10], 30, 10);
    expect(computeSignals(h, 10, null, NOW)!.pct_below_threshold).toBeNull();
  });

  it('vs_community_low is current/communityLow when both present', () => {
    const h = buildHistory([20, 15, 10], 30, 10);
    expect(computeSignals(h, 10, null, NOW, 8)!.vs_community_low).toBeCloseTo(1.25);
  });

  it('vs_community_low is null when communityLow is null', () => {
    const h = buildHistory([20, 15, 10], 30, 10);
    expect(computeSignals(h, 10, null, NOW, null)!.vs_community_low).toBeNull();
  });
});
