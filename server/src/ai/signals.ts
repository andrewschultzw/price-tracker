// server/src/ai/signals.ts
import type { PriceObservation, Signals } from './types.js';

const MS_PER_DAY = 86_400_000;

function lowInWindow(
  history: PriceObservation[],
  windowMs: number,
  now: number,
): number | null {
  const cutoff = now - windowMs;
  const inWindow = history.filter(o => o.recorded_at >= cutoff).map(o => o.price);
  return inWindow.length === 0 ? null : Math.min(...inWindow);
}

function trendIn30d(
  history: PriceObservation[],
  now: number,
): 'falling' | 'flat' | 'rising' {
  const window = history.filter(o => o.recorded_at >= now - 30 * MS_PER_DAY);
  if (window.length < 2) return 'flat';
  const first = window[0].price;
  const last = window[window.length - 1].price;
  const change = (last - first) / first;
  if (change > 0.05) return 'rising';
  if (change < -0.05) return 'falling';
  return 'flat';
}

export function computeSignals(
  history: PriceObservation[],
  currentPrice: number,
  threshold: number | null,
  now: number = Date.now(),
  communityLow: number | null = null,
): Signals | null {
  if (history.length < 2) return null;

  // Sort chronologically
  const sorted = [...history].sort((a, b) => a.recorded_at - b.recorded_at);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  // Basic stats
  const data_days = Math.round((last.recorded_at - first.recorded_at) / MS_PER_DAY);
  const data_points = sorted.length;

  const prices = sorted.map(o => o.price);
  const all_time_low = Math.min(...prices);
  const all_time_high = Math.max(...prices);

  // Current percentile: fraction of historical prices strictly below currentPrice
  const below = prices.filter(p => p < currentPrice).length;
  const current_percentile = prices.length > 1 ? below / (prices.length - 1) : 0;

  // Window comparisons
  const low30 = lowInWindow(sorted, 30 * MS_PER_DAY, now) ?? all_time_low;
  const low90 = lowInWindow(sorted, 90 * MS_PER_DAY, now) ?? all_time_low;

  const vs_30d_low = currentPrice / low30;
  const vs_90d_low = currentPrice / low90;
  const vs_all_time_low = currentPrice / all_time_low;
  const vs_all_time_high = currentPrice / all_time_high;

  // Recency: days since all-time low
  const atlObs = sorted.find(o => o.price === all_time_low)!;
  const days_since_all_time_low = Math.round((now - atlObs.recorded_at) / MS_PER_DAY);

  // Recency: consecutive at-or-below run from the latest observation backwards
  let runStart = sorted.length - 1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].price <= currentPrice) runStart = i;
    else break;
  }
  const days_at_current_or_lower = Math.round(
    (sorted[sorted.length - 1].recorded_at - sorted[runStart].recorded_at) / MS_PER_DAY,
  );

  // Dwell
  const times_at_or_below_current = prices.filter(p => p <= currentPrice).length;

  // Average dwell at all-time low for runs that have rebounded
  const dwellSpans: number[] = [];
  let runStartIdx: number | null = null;
  for (let i = 0; i < sorted.length; i++) {
    const isLow = sorted[i].price === all_time_low;
    if (isLow && runStartIdx === null) runStartIdx = i;
    if (!isLow && runStartIdx !== null) {
      const spanDays =
        (sorted[i - 1].recorded_at - sorted[runStartIdx].recorded_at) / MS_PER_DAY;
      dwellSpans.push(spanDays);
      runStartIdx = null;
    }
  }
  const avg_dwell_days_at_low =
    dwellSpans.length === 0
      ? null
      : dwellSpans.reduce((a, b) => a + b, 0) / dwellSpans.length;

  // Direction
  const trend_30d = trendIn30d(sorted, now);

  let consecutive_drops = 0;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i].price < sorted[i - 1].price) consecutive_drops++;
    else break;
  }

  // User-relative
  const pct_below_threshold =
    threshold === null
      ? null
      : Math.max(0, ((threshold - currentPrice) / threshold) * 100);

  // Community cohort
  const vs_community_low = communityLow === null ? null : currentPrice / communityLow;

  return {
    data_days,
    data_points,
    current_price: currentPrice,
    all_time_low,
    all_time_high,
    current_percentile,
    vs_30d_low,
    vs_90d_low,
    vs_all_time_low,
    vs_all_time_high,
    days_since_all_time_low,
    days_at_current_or_lower,
    times_at_or_below_current,
    avg_dwell_days_at_low,
    trend_30d,
    consecutive_drops,
    threshold,
    pct_below_threshold,
    community_low: communityLow,
    vs_community_low,
  };
}
