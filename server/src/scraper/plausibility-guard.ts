/**
 * Defense-in-depth check for the alert path. Returns true when the
 * candidate price looks implausibly far below the seller's recent norm.
 *
 * Behavior is parameterized so the function is pure and testable in
 * isolation — no DB access, no logger calls. The scheduler is responsible
 * for calling getRecentSuccessfulPricesForSeller(), passing the threshold
 * from config.plausibilityGuardDropThreshold, and acting on the result.
 *
 * Decision rules (thresholdDropFraction = 0.5 by default):
 *   - 0 entries (brand-new tracker): never suspicious. The very first
 *     drop has no baseline to flag.
 *   - 1–4 entries (cold start): flag suspicious when
 *       price < recentPrices[0] * thresholdDropFraction
 *     (most recent successful price acts as the baseline).
 *   - ≥5 entries (warm): flag suspicious when
 *       price < median(recentPrices) * thresholdDropFraction
 *     The median is robust to a single anomalous data point — one bad
 *     scrape doesn't poison the baseline for subsequent comparisons.
 *   - thresholdDropFraction = 0: disabled, never suspicious. Allows
 *     ops to turn the guard off entirely via env var without code
 *     changes.
 *
 * The "<" comparison is strict: a price exactly at the threshold is
 * NOT suspicious. This makes round-number thresholds unambiguous in
 * tests and matches the spec's stated 50% rule.
 *
 * See docs/superpowers/specs/2026-04-27-plausibility-guard-design.md.
 */
const COLD_START_CUTOFF = 5;

export function isPlausibilityGuardSuspicious(
  price: number,
  recentPrices: number[],
  thresholdDropFraction: number,
): boolean {
  if (thresholdDropFraction <= 0) return false;
  if (recentPrices.length === 0) return false;

  const baseline =
    recentPrices.length >= COLD_START_CUTOFF
      ? median(recentPrices)
      : recentPrices[0];

  return price < baseline * thresholdDropFraction;
}

/**
 * Compute the baseline value the suspiciousness check compares against —
 * median for warm history (≥5 entries), most-recent price for cold start
 * (1–4 entries), null for empty history. Exposed so callers can include
 * the actual baseline value in log/observability output without
 * recomputing it independently (which would risk drift from the rules
 * encoded in `isPlausibilityGuardSuspicious`).
 */
export function computePlausibilityBaseline(recentPrices: number[]): number | null {
  if (recentPrices.length === 0) return null;
  if (recentPrices.length >= COLD_START_CUTOFF) return median(recentPrices);
  return recentPrices[0];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
