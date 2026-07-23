import { describe, expect, it } from 'vitest';
import {
  computePriceStats,
  evaluateLowTier,
  formatLowContext,
  suggestThreshold,
  thresholdStaleness,
  type DailyMin,
} from './price-stats.js';

const NOW = Date.parse('2026-07-23T12:00:00Z');
const DAY_MS = 86_400_000;

/** Build daily mins going back from NOW: prices[0] is `startDaysAgo` days ago. */
function series(prices: (number | null)[], startDaysAgo: number): DailyMin[] {
  const out: DailyMin[] = [];
  prices.forEach((p, i) => {
    if (p === null) return; // gap day
    const ms = NOW - (startDaysAgo - i) * DAY_MS;
    out.push({ date: new Date(ms).toISOString().slice(0, 10), price: p });
  });
  return out;
}

/** N days of a flat price ending yesterday. */
function flat(price: number, days: number): DailyMin[] {
  return series(Array(days).fill(price), days);
}

describe('computePriceStats', () => {
  it('returns empty stats for no history', () => {
    const s = computePriceStats([], NOW);
    expect(s.all).toEqual({ min: null, max: null, median: null, points: 0 });
    expect(s.spanDays).toBe(0);
    expect(s.p10).toBeNull();
  });

  it('windows correctly and computes span from the earliest point', () => {
    // 100 days of $50, but the last 20 days dropped to $40.
    const s = computePriceStats(
      [...series(Array(80).fill(50), 100), ...series(Array(20).fill(40), 20)],
      NOW,
    );
    expect(s.all.min).toBe(40);
    expect(s.all.max).toBe(50);
    expect(s.w30.min).toBe(40);
    expect(s.w30.max).toBe(50); // days 21-30 are still $50
    expect(s.spanDays).toBe(100);
    expect(s.all.points).toBe(100);
  });

  it('ignores non-positive prices', () => {
    const s = computePriceStats(
      [...flat(50, 30), { date: '2026-07-20', price: 0 }],
      NOW,
    );
    expect(s.all.min).toBe(50);
  });

  it('median is exact for odd and averaged for even counts', () => {
    expect(computePriceStats(series([1, 2, 9], 3), NOW).all.median).toBe(2);
    expect(computePriceStats(series([1, 2, 8, 9], 4), NOW).all.median).toBe(5);
  });
});

describe('evaluateLowTier', () => {
  // 100 days at $50 = eligible for every gate (span 100, points 100).
  const mature = computePriceStats(flat(50, 100), NOW);

  it('fires all_time when >=1% below the record', () => {
    expect(evaluateLowTier(49.49, mature, 'all')).toBe('low_all_time');
  });

  it('does NOT fire all_time within the 1% penny-noise band, falls to 90d tier', () => {
    // 49.60 is below the $50 min but not <= 49.50 — falls through to low_90d.
    expect(evaluateLowTier(49.6, mature, 'all')).toBe('low_90d');
  });

  it('respects mode record_only (no 30/90 tiers)', () => {
    expect(evaluateLowTier(49.6, mature, 'record_only')).toBeNull();
    expect(evaluateLowTier(49.0, mature, 'record_only')).toBe('low_all_time');
  });

  it('respects mode off', () => {
    expect(evaluateLowTier(1, mature, 'off')).toBeNull();
  });

  it('gates young trackers: 10-day-old history never fires', () => {
    const young = computePriceStats(flat(50, 10), NOW);
    expect(evaluateLowTier(30, young, 'all')).toBeNull();
  });

  it('30d tier at >=21d span, 90d tier at >=60d span', () => {
    const d25 = computePriceStats(flat(50, 25), NOW);
    expect(evaluateLowTier(49, d25, 'all')).toBe('low_30d');
    const d70 = computePriceStats(flat(50, 70), NOW);
    expect(evaluateLowTier(49, d70, 'all')).toBe('low_90d');
  });

  it('all_time needs >=25 points even when span is long (sparse history)', () => {
    // 10 scattered points across 120 days: span passes, points gate fails.
    const sparse = computePriceStats(
      [...series([50, 50, 50, 50, 50], 120), ...series([50, 50, 50, 50, 50], 20)],
      NOW,
    );
    expect(evaluateLowTier(40, sparse, 'all')).not.toBe('low_all_time');
    expect(evaluateLowTier(40, sparse, 'all')).toBe('low_90d'); // span 111d >= 60
  });

  it('equal-to-window-min does not fire (strictly below for 30/90)', () => {
    expect(evaluateLowTier(50, mature, 'all')).toBeNull();
  });

  it('zero/negative candidate never fires', () => {
    expect(evaluateLowTier(0, mature, 'all')).toBeNull();
    expect(evaluateLowTier(-5, mature, 'all')).toBeNull();
  });
});

describe('suggestThreshold', () => {
  it('null under 21 days of span', () => {
    expect(suggestThreshold(computePriceStats(flat(50, 10), NOW))).toBeNull();
  });

  it('10th percentile of 90d dailies, rounded down to cents', () => {
    // 90 days: 81 days at $50, 9 days at $44.999 → p10 = 44.999 → 44.99
    const s = computePriceStats(
      [...series(Array(81).fill(50), 90), ...series(Array(9).fill(44.999), 9)],
      NOW,
    );
    expect(suggestThreshold(s)).toBe(44.99);
  });
});

describe('thresholdStaleness', () => {
  const mature = computePriceStats(flat(50, 100), NOW);

  it('stale_low when unreachably below all-time min', () => {
    expect(thresholdStaleness(40, mature)).toBe('stale_low'); // < 47.50
  });

  it('stale_high when at/above the 30d median', () => {
    expect(thresholdStaleness(50, mature)).toBe('stale_high');
    expect(thresholdStaleness(60, mature)).toBe('stale_high');
  });

  it('healthy threshold between the bands is null', () => {
    expect(thresholdStaleness(48, mature)).toBeNull();
  });

  it('null threshold / no data are null', () => {
    expect(thresholdStaleness(null, mature)).toBeNull();
    expect(thresholdStaleness(48, computePriceStats([], NOW))).toBeNull();
  });

  it('stale_low needs >=60d span (young tracker thresholds are not judged)', () => {
    const young = computePriceStats(flat(50, 30), NOW);
    expect(thresholdStaleness(40, young)).toBeNull();
  });
});

describe('formatLowContext', () => {
  it('includes tier label, previous record and span', () => {
    const s = computePriceStats(flat(429, 289), NOW);
    expect(formatLowContext('low_all_time', s)).toBe(
      'Lowest price ever seen (prev. $429.00 · 289 days tracked)',
    );
  });
});
