import type { PriceRecord } from '../types'

/**
 * Chart data reshaping for multi-seller trackers.
 *
 * The price_history table is a long-format timeline: one row per scrape,
 * each tagged with the seller that produced it. Recharts wants wide format
 * for multi-line plotting: one row per timestamp with a column per seller.
 *
 * The pivot logic here produces that wide format, plus metadata about
 * the sellers present so the chart can render colored lines with labels.
 * Keeping it as a pure function means it's easy to test without mounting
 * the recharts component.
 *
 * Handling of sparse data: sellers rarely scrape at the exact same
 * timestamp, so most rows have only one populated seller column and all
 * the others are null. Recharts' Line component with `connectNulls={true}`
 * draws through the nulls, producing a continuous per-seller line that
 * matches the user's mental model of "here's what Amazon cost over time".
 */

export interface SellerMeta {
  /** Stable key used as the object property on each wide-format row. */
  key: string
  /** Hostname of the seller, stripped of www., used as the legend label. */
  label: string
  /** Full URL of the seller, for tooltips. */
  url: string
  /** Hex color assigned to this seller's line. */
  color: string
}

export interface WideRow {
  scraped_at: string
  // One key per seller; value is the price at that timestamp or null if
  // that seller didn't scrape at this moment.
  [sellerKey: string]: string | number | null
}

export interface ChartData {
  rows: WideRow[]
  sellers: SellerMeta[]
  /** True if all rows came from the same seller (or no seller info at all).
   * When true, the chart can fall back to its single-line rendering. */
  isSingleSeller: boolean
}

// Palette picked for dark-theme readability and distinctiveness. Order
// matches the typical "hero → supporting" narrative — the primary seller
// (first one added) gets the indigo brand color, others get contrasting
// hues. Up to 8 sellers before we wrap around, which is plenty in practice.
const SELLER_COLORS = [
  '#6366f1', // indigo (matches brand primary)
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#ef4444', // red
  '#84cc16', // lime
]

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * Build a stable seller key that's safe to use as an object property
 * and stays consistent across renders. Based on the url itself (not a
 * counter) so the same seller gets the same key across reloads.
 */
function sellerKeyFor(url: string): string {
  // Replace non-alphanum with underscores so recharts dataKey strings
  // never collide with reserved chars. Prefix with `s_` to guarantee
  // a valid JS identifier even if the URL started with a digit.
  return 's_' + url.replace(/[^a-z0-9]/gi, '_')
}

/**
 * Reshape a long-format price history into wide format for recharts. Pure
 * function, fully tested.
 */
export function buildChartData(records: PriceRecord[]): ChartData {
  if (records.length === 0) {
    return { rows: [], sellers: [], isSingleSeller: true }
  }

  // Unique sellers in first-seen order so the legend shows them in a
  // stable sequence (primary / first-added first).
  const sellerByKey = new Map<string, SellerMeta>()
  for (const r of records) {
    const url = r.seller_url
    if (!url) continue
    const key = sellerKeyFor(url)
    if (!sellerByKey.has(key)) {
      sellerByKey.set(key, {
        key,
        label: hostnameOf(url),
        url,
        color: SELLER_COLORS[sellerByKey.size % SELLER_COLORS.length],
      })
    }
  }
  const sellers = Array.from(sellerByKey.values())

  // Single-seller fast path: no legend needed, chart renders with one
  // line exactly like it did before multi-seller existed.
  const isSingleSeller = sellers.length <= 1

  // Pivot. One wide row per scrape timestamp. Using scraped_at as the row
  // identity means two sellers scraping at the exact same second merge
  // into one row, which is correct — a rare case but worth handling.
  const rowsByTimestamp = new Map<string, WideRow>()
  for (const r of records) {
    const existing = rowsByTimestamp.get(r.scraped_at)
    const row: WideRow = existing ?? { scraped_at: r.scraped_at }
    // Initialize any missing seller columns to null so recharts knows
    // those sellers didn't contribute to this row (rather than treating
    // them as zero).
    for (const s of sellers) {
      if (!(s.key in row)) row[s.key] = null
    }
    if (r.seller_url) {
      const key = sellerKeyFor(r.seller_url)
      row[key] = r.price
    } else if (sellers.length === 0) {
      // Legacy pre-multi-seller rows without seller_url — stash under a
      // generic key so the fallback single-line rendering still works.
      row.price = r.price
    }
    rowsByTimestamp.set(r.scraped_at, row)
  }

  // Sort chronologically. Maps preserve insertion order so we only need
  // to sort if the input wasn't already sorted, but sorting defensively
  // costs nothing and keeps the API contract strict.
  const rows = Array.from(rowsByTimestamp.values()).sort((a, b) =>
    String(a.scraped_at).localeCompare(String(b.scraped_at)),
  )

  return { rows, sellers, isSingleSeller }
}
