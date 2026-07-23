/**
 * Pure price-history statistics for deal intelligence (Phase 1, spec
 * docs/superpowers/specs/2026-07-23-deal-intelligence-roadmap.md).
 *
 * Everything here operates on daily-minimum price rows — one {date, price}
 * per calendar day, MIN across a tracker's 'new'-condition sellers — the same
 * downsampling the public product pages use. Intraday scrape cadence must not
 * weight the stats, and a warehouse/refurb listing must not set a "record".
 *
 * All functions are pure (no DB, no clock reads) so they are trivially
 * unit-testable; callers pass `nowMs` explicitly.
 */

export type LowTier = 'low_30d' | 'low_90d' | 'low_all_time';
export type LowAlertMode = 'all' | 'record_only' | 'off';
export type ThresholdStaleness = 'stale_low' | 'stale_high' | null;

export interface DailyMin {
  /** Calendar date, 'YYYY-MM-DD' (UTC, as SQLite DATE() emits). */
  date: string;
  price: number;
}

export interface WindowStats {
  min: number | null;
  max: number | null;
  median: number | null;
  /** Distinct daily points inside the window. */
  points: number;
}

export interface PriceStats {
  w30: WindowStats;
  w90: WindowStats;
  w365: WindowStats;
  all: WindowStats;
  /** Days elapsed between the earliest daily point and nowMs (0 when empty). */
  spanDays: number;
  /** 10th percentile of 90-day daily mins (all-time fallback), for threshold suggestion. */
  p10: number | null;
}

/** Coverage gates (spec §Phase 1, decision 3). */
const GATES = {
  low_30d: { minSpanDays: 21 },
  low_90d: { minSpanDays: 60 },
  low_all_time: { minSpanDays: 90, minPoints: 25, belowFactor: 0.99 },
} as const;

const DAY_MS = 86_400_000;

function windowStats(prices: number[]): WindowStats {
  if (prices.length === 0) return { min: null, max: null, median: null, points: 0 };
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min: sorted[0], max: sorted[sorted.length - 1], median, points: sorted.length };
}

/** Nearest-rank percentile (p in 0..100) of a non-empty array; null when empty. */
function percentileValue(prices: number[], p: number): number | null {
  if (prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function dateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * Compute windowed stats over prior daily-min history. `dailyMins` must NOT
 * include the scrape being evaluated (callers snapshot history before
 * inserting the new price row).
 */
export function computePriceStats(dailyMins: DailyMin[], nowMs: number): PriceStats {
  const valid = dailyMins.filter(d => d.price > 0 && Number.isFinite(dateToMs(d.date)));
  const inWindow = (days: number) =>
    valid.filter(d => nowMs - dateToMs(d.date) <= days * DAY_MS).map(d => d.price);

  const all = windowStats(valid.map(d => d.price));
  const w90Prices = inWindow(90);
  const spanDays =
    valid.length === 0
      ? 0
      : Math.floor((nowMs - Math.min(...valid.map(d => dateToMs(d.date)))) / DAY_MS);

  return {
    w30: windowStats(inWindow(30)),
    w90: windowStats(w90Prices),
    w365: windowStats(inWindow(365)),
    all,
    spanDays,
    // Suggestion basis: 90d when we have >=60d of tracking, else all-time
    // (young trackers shouldn't get a suggestion from 3 points — the caller
    // additionally gates on spanDays if it wants to hide it entirely).
    p10:
      spanDays >= 60 && w90Prices.length > 0
        ? percentileValue(w90Prices, 10)
        : percentileValue(valid.map(d => d.price), 10),
  };
}

/**
 * Decide whether `candidatePrice` sets a record low, and at which tier.
 * Highest qualifying tier wins; coverage gates keep young trackers quiet
 * (every first scrape is trivially an "all-time low"). The all-time tier
 * additionally requires >=1% below the previous record (penny-noise guard);
 * the 30/90-day tiers require strictly below the window min.
 */
export function evaluateLowTier(
  candidatePrice: number,
  stats: PriceStats,
  mode: LowAlertMode,
): LowTier | null {
  if (mode === 'off' || candidatePrice <= 0) return null;

  const g = GATES.low_all_time;
  if (
    stats.spanDays >= g.minSpanDays &&
    stats.all.points >= g.minPoints &&
    stats.all.min !== null &&
    candidatePrice <= stats.all.min * g.belowFactor
  ) {
    return 'low_all_time';
  }
  if (mode === 'record_only') return null;

  if (
    stats.spanDays >= GATES.low_90d.minSpanDays &&
    stats.w90.min !== null &&
    candidatePrice < stats.w90.min
  ) {
    return 'low_90d';
  }
  if (
    stats.spanDays >= GATES.low_30d.minSpanDays &&
    stats.w30.min !== null &&
    candidatePrice < stats.w30.min
  ) {
    return 'low_30d';
  }
  return null;
}

/**
 * Suggested threshold: the 10th percentile of daily mins (90d basis with
 * all-time fallback, see computePriceStats.p10), rounded DOWN to the cent.
 * Null until the tracker has >=21 days of span — a suggestion from a week of
 * data is noise dressed as advice.
 */
export function suggestThreshold(stats: PriceStats): number | null {
  if (stats.spanDays < 21 || stats.p10 === null) return null;
  return Math.floor(stats.p10 * 100) / 100;
}

/**
 * Threshold staleness (spec §Phase 1, decision 7):
 *  - stale_low:  unreachable — below 95% of the all-time min with >=60d tracked
 *  - stale_high: fires trivially — at/above the 30-day median
 */
export function thresholdStaleness(
  threshold: number | null | undefined,
  stats: PriceStats,
): ThresholdStaleness {
  if (threshold == null || threshold <= 0) return null;
  if (stats.spanDays >= 60 && stats.all.min !== null && threshold < stats.all.min * 0.95) {
    return 'stale_low';
  }
  if (stats.w30.median !== null && threshold >= stats.w30.median) {
    return 'stale_high';
  }
  return null;
}

/**
 * Percentile rank of `value` among the last 90 days of daily mins: the share
 * of days strictly more expensive than `value`, inverted — "5" means cheaper
 * than 95% of tracked days. Null when there is no 90-day history.
 */
export function percentileRank90d(
  dailyMins: DailyMin[],
  nowMs: number,
  value: number,
): number | null {
  const prices = dailyMins
    .filter(d => d.price > 0 && nowMs - dateToMs(d.date) <= 90 * DAY_MS)
    .map(d => d.price);
  if (prices.length === 0) return null;
  const below = prices.filter(p => p < value).length;
  return Math.round((below / prices.length) * 100);
}

const TIER_LABEL: Record<LowTier, string> = {
  low_30d: 'Lowest price in 30 days',
  low_90d: 'Lowest price in 90 days',
  low_all_time: 'Lowest price ever seen',
};

export function lowTierLabel(tier: LowTier): string {
  return TIER_LABEL[tier];
}

/**
 * Human context line appended to alert bodies, e.g.
 * "Lowest price ever seen (prev. $429.00 · 289 days tracked)".
 */
export function formatLowContext(tier: LowTier, stats: PriceStats): string {
  const prev =
    tier === 'low_all_time' ? stats.all.min :
    tier === 'low_90d' ? stats.w90.min :
    stats.w30.min;
  const prevPart = prev !== null ? `prev. $${prev.toFixed(2)} · ` : '';
  return `${TIER_LABEL[tier]} (${prevPart}${stats.spanDays} days tracked)`;
}
