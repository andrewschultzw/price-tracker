// server/src/ai/confidence.ts
//
// Pure deterministic layer on top of computeSignals. Categorizes a price
// alert as HIGH / MEDIUM / LOW based on percentile + absolute-count rarity,
// and produces up to 2 short reason strings drawn from the same Signals
// dataset. Zero IO, no DB, no current-time calls — all inputs come from
// the Signals object the caller already computed.
//
// Rendering of these values into channel-specific prefixes / emoji /
// "About this deal" lines lives in each channel's notification module.
// See docs/superpowers/specs/2026-05-06-confidence-scored-alerts-design.md

import type { Signals } from './types.js';

export type ConfidenceLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface Confidence {
  level: ConfidenceLevel;
  reasons: string[]; // up to 2
}

const MAX_REASONS = 2;

function classifyLevel(signals: Signals): ConfidenceLevel {
  const rareCountThreshold = Math.max(3, signals.data_points * 0.05);
  const isHigh =
    signals.current_percentile <= 0.10 &&
    signals.times_at_or_below_current <= rareCountThreshold;
  if (isHigh) return 'HIGH';
  if (signals.current_percentile <= 0.25) return 'MEDIUM';
  return 'LOW';
}

function ordinalForTimes(times: number): string {
  if (times === 1) return 'first time at this price';
  if (times === 2) return '2nd time at this price';
  return '3rd time at this price';
}

/**
 * Reason generators in priority order. The first MAX_REASONS that fire
 * are kept. Rules 1 and 2 are mutually exclusive by design — rule 1
 * (12-month low) preempts rule 2 (all-time low) when data_days >= 365.
 */
function buildReasons(signals: Signals): string[] {
  const reasons: string[] = [];

  // Rule 1: 12-month low (preempts rule 2)
  if (signals.vs_all_time_low === 1.0 && signals.data_days >= 365) {
    reasons.push('12-month low');
  } else if (signals.vs_all_time_low === 1.0) {
    // Rule 2: all-time low (only when not 12-month low)
    reasons.push('all-time low');
  }

  // Rule 3: 30-day low
  // Skip when we've already added an all-time/12-month low — those imply
  // the 30-day low and we'd just be repeating the same signal.
  if (reasons.length < MAX_REASONS && signals.vs_30d_low === 1.0 && signals.vs_all_time_low !== 1.0) {
    reasons.push('30-day low');
  }

  // Rule 4: rare in dataset (1st/2nd/3rd time)
  if (
    reasons.length < MAX_REASONS &&
    signals.times_at_or_below_current >= 1 &&
    signals.times_at_or_below_current <= 3
  ) {
    reasons.push(ordinalForTimes(signals.times_at_or_below_current));
  }

  // Rule 5: percentile statement
  if (reasons.length < MAX_REASONS && signals.current_percentile <= 0.10) {
    reasons.push('top 10% lowest in dataset');
  }

  // Rule 6: days since ATL (only meaningful when we're NOT currently at ATL)
  if (
    reasons.length < MAX_REASONS &&
    signals.days_since_all_time_low > 60 &&
    signals.vs_all_time_low !== 1.0
  ) {
    const months = Math.round(signals.days_since_all_time_low / 30);
    reasons.push(`first time below $${signals.current_price.toFixed(2)} in ${months}+ months`);
  }

  // Rule 7: average dwell at low
  if (reasons.length < MAX_REASONS && signals.avg_dwell_days_at_low !== null) {
    const dwell = Math.round(signals.avg_dwell_days_at_low);
    reasons.push(`typically holds ~${dwell} days`);
  }

  return reasons.slice(0, MAX_REASONS);
}

/**
 * Pure function — given a Signals object, return the confidence level
 * (HIGH / MEDIUM / LOW) and up to 2 supporting reason strings.
 */
export function computeConfidence(signals: Signals): Confidence {
  return {
    level: classifyLevel(signals),
    reasons: buildReasons(signals),
  };
}
