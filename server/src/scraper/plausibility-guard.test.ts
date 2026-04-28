import { describe, it, expect } from 'vitest';
import { isPlausibilityGuardSuspicious } from './plausibility-guard.js';

describe('isPlausibilityGuardSuspicious', () => {
  // The helper takes prices most-recent-first as the queries module
  // returns them. Threshold is the second arg so callers pass
  // config.plausibilityGuardDropThreshold directly.

  describe('disabled by config', () => {
    it('threshold of 0 → never suspicious, regardless of history', () => {
      expect(isPlausibilityGuardSuspicious(1, [100, 100, 100, 100, 100, 100], 0)).toBe(false);
    });
  });

  describe('empty history (brand-new tracker)', () => {
    it('returns false — no baseline to compare', () => {
      expect(isPlausibilityGuardSuspicious(10, [], 0.5)).toBe(false);
    });
  });

  describe('cold start (1–4 entries) — last-price comparison', () => {
    it('flags 64% drop (Amazon $28 → $10 case)', () => {
      expect(isPlausibilityGuardSuspicious(10, [28], 0.5)).toBe(true);
    });

    it('flags 98% drop (Amazon $601 → $10 case)', () => {
      expect(isPlausibilityGuardSuspicious(10, [601, 580, 590, 600], 0.5)).toBe(true);
    });

    it('does NOT flag 30% drop', () => {
      expect(isPlausibilityGuardSuspicious(70, [100, 100, 100, 100], 0.5)).toBe(false);
    });

    it('does NOT flag exactly at threshold (50%)', () => {
      // < threshold (strict). At-threshold is not suspicious.
      expect(isPlausibilityGuardSuspicious(50, [100], 0.5)).toBe(false);
    });

    it('flags just below threshold', () => {
      expect(isPlausibilityGuardSuspicious(49.99, [100], 0.5)).toBe(true);
    });
  });

  describe('warm path (≥5 entries) — median comparison', () => {
    it('flags drop below median * threshold', () => {
      // Median of [600, 600, 600, 580, 620] is 600; 600 * 0.5 = 300.
      expect(isPlausibilityGuardSuspicious(250, [600, 600, 600, 580, 620], 0.5)).toBe(true);
    });

    it('does NOT flag legit moderate drop above median*threshold', () => {
      expect(isPlausibilityGuardSuspicious(310, [600, 600, 600, 580, 620], 0.5)).toBe(false);
    });

    it('median is robust to a single outlier in history', () => {
      // History contains one bad scrape ($10) but median of 9 good values
      // around $600 stays at $600. New scrape of $250 still flagged.
      const history = [600, 600, 10, 580, 600, 620, 600, 590, 610];
      expect(isPlausibilityGuardSuspicious(250, history, 0.5)).toBe(true);
    });

    it('uses median (50th percentile), not mean', () => {
      // Mean would be skewed by the outlier; median is not.
      // [10, 600, 600, 600, 600] median = 600. New $250 → suspicious.
      expect(isPlausibilityGuardSuspicious(250, [10, 600, 600, 600, 600], 0.5)).toBe(true);
    });
  });

  describe('threshold tunability', () => {
    it('threshold of 0.25 catches only severe drops (75%+)', () => {
      expect(isPlausibilityGuardSuspicious(30, [100, 100, 100, 100, 100], 0.25)).toBe(false);
      expect(isPlausibilityGuardSuspicious(20, [100, 100, 100, 100, 100], 0.25)).toBe(true);
    });

    it('threshold of 0.75 catches mild drops (25%+)', () => {
      expect(isPlausibilityGuardSuspicious(70, [100, 100, 100, 100, 100], 0.75)).toBe(true);
      expect(isPlausibilityGuardSuspicious(80, [100, 100, 100, 100, 100], 0.75)).toBe(false);
    });
  });
});
