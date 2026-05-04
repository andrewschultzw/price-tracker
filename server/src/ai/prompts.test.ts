import { describe, it, expect } from 'vitest';
import { buildVerdictPrompt, buildSummaryPrompt, buildAlertCopyPrompt } from './prompts.js';
import type { Signals } from './types.js';

const sampleSignals: Signals = {
  data_days: 90, data_points: 90, current_price: 279, all_time_low: 279, all_time_high: 389,
  current_percentile: 0.05,
  vs_30d_low: 1.0, vs_90d_low: 1.0, vs_all_time_low: 1.0, vs_all_time_high: 0.72,
  days_since_all_time_low: 0, days_at_current_or_lower: 1,
  times_at_or_below_current: 3, avg_dwell_days_at_low: 4,
  trend_30d: 'flat', consecutive_drops: 1,
  threshold: 300, pct_below_threshold: 7,
  community_low: 275, vs_community_low: 1.014,
};

describe('buildVerdictPrompt', () => {
  it('marks the system block as cache-controlled ephemeral', () => {
    const p = buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low');
    expect(p.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('serializes signals in the user block as JSON', () => {
    const p = buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low');
    expect(p.user).toContain('"current_percentile": 0.05');
    expect(p.user).toContain('"reasonKey": "at_all_time_low"');
    expect(p.user).toContain('"tier": "BUY"');
  });

  it('system block contains hallucination guard wording', () => {
    const p = buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low');
    const sys = p.system[0].text;
    expect(sys).toMatch(/only use values present in the signals/i);
    expect(sys).toMatch(/do not invent/i);
  });

  it('system block declares the length limit', () => {
    const p = buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low');
    expect(p.system[0].text).toMatch(/150 char/i);
    expect(p.maxOutputChars).toBe(150);
  });

  it('promptName is "verdict"', () => {
    expect(buildVerdictPrompt(sampleSignals, 'BUY', 'at_all_time_low').promptName).toBe('verdict');
  });
});

describe('buildSummaryPrompt', () => {
  it('promptName is "summary" and limit is 400 chars', () => {
    const p = buildSummaryPrompt(sampleSignals, []);
    expect(p.promptName).toBe('summary');
    expect(p.maxOutputChars).toBe(400);
  });

  it('includes recent observations in user block', () => {
    const obs = [
      { price: 279, recorded_at: 1715000000000 },
      { price: 289, recorded_at: 1714000000000 },
    ];
    const p = buildSummaryPrompt(sampleSignals, obs);
    expect(p.user).toContain('279');
    expect(p.user).toContain('289');
  });
});

describe('buildAlertCopyPrompt', () => {
  it('promptName is "alert" and limit is 120 chars', () => {
    const p = buildAlertCopyPrompt({
      trackerName: 'Samsung 990 Pro 4TB',
      oldPrice: 349.99, newPrice: 279,
      signals: sampleSignals, reasonKey: 'at_all_time_low',
    });
    expect(p.promptName).toBe('alert');
    expect(p.maxOutputChars).toBe(120);
  });

  it('includes price-change context in user block', () => {
    const p = buildAlertCopyPrompt({
      trackerName: 'Samsung 990 Pro 4TB',
      oldPrice: 349.99, newPrice: 279,
      signals: sampleSignals, reasonKey: 'at_all_time_low',
    });
    expect(p.user).toContain('Samsung 990 Pro 4TB');
    expect(p.user).toContain('349.99');
    expect(p.user).toContain('279');
  });
});
