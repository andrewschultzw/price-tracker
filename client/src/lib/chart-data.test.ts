import { describe, it, expect } from 'vitest'
import type { PriceRecord } from '../types'
import { buildChartData } from './chart-data'

function rec(overrides: Partial<PriceRecord> & { id: number; price: number; scraped_at: string }): PriceRecord {
  return {
    tracker_id: 1,
    currency: 'USD',
    ...overrides,
  }
}

describe('buildChartData', () => {
  describe('empty / single seller', () => {
    it('returns empty shape for no records', () => {
      const result = buildChartData([])
      expect(result.rows).toEqual([])
      expect(result.sellers).toEqual([])
      expect(result.isSingleSeller).toBe(true)
    })

    it('marks single-seller when all records share one seller_url', () => {
      const records = [
        rec({ id: 1, price: 53, scraped_at: '2026-04-08 10:00:00', seller_url: 'https://amazon.com/dp/X' }),
        rec({ id: 2, price: 52, scraped_at: '2026-04-09 10:00:00', seller_url: 'https://amazon.com/dp/X' }),
      ]
      const result = buildChartData(records)
      expect(result.isSingleSeller).toBe(true)
      expect(result.sellers).toHaveLength(1)
      expect(result.sellers[0].label).toBe('amazon.com')
      expect(result.rows).toHaveLength(2)
    })

    it('marks single-seller when records have null seller_url (legacy rows)', () => {
      const records = [
        rec({ id: 1, price: 53, scraped_at: '2026-04-08 10:00:00', seller_url: null }),
      ]
      const result = buildChartData(records)
      expect(result.isSingleSeller).toBe(true)
      expect(result.sellers).toHaveLength(0)
      // Legacy path: the raw `price` key is populated for fallback rendering
      expect(result.rows[0].price).toBe(53)
    })
  })

  describe('multi-seller pivot', () => {
    const records: PriceRecord[] = [
      rec({ id: 1, price: 53.99, scraped_at: '2026-04-08 10:00:00', seller_url: 'https://www.amazon.com/dp/X' }),
      rec({ id: 2, price: 55.00, scraped_at: '2026-04-08 10:05:00', seller_url: 'https://www.newegg.com/p/Y' }),
      rec({ id: 3, price: 52.50, scraped_at: '2026-04-08 11:00:00', seller_url: 'https://www.amazon.com/dp/X' }),
      rec({ id: 4, price: 54.25, scraped_at: '2026-04-08 11:05:00', seller_url: 'https://www.newegg.com/p/Y' }),
    ]

    it('detects multi-seller and builds both sellers meta', () => {
      const result = buildChartData(records)
      expect(result.isSingleSeller).toBe(false)
      expect(result.sellers).toHaveLength(2)
      expect(result.sellers.map(s => s.label)).toEqual(['amazon.com', 'newegg.com'])
    })

    it('strips www. from seller labels', () => {
      const result = buildChartData(records)
      for (const s of result.sellers) {
        expect(s.label.startsWith('www.')).toBe(false)
      }
    })

    it('assigns distinct colors from the palette', () => {
      const result = buildChartData(records)
      const colors = result.sellers.map(s => s.color)
      expect(new Set(colors).size).toBe(colors.length)
    })

    it('first-seen seller gets the brand primary color', () => {
      const result = buildChartData(records)
      expect(result.sellers[0].color).toBe('#6366f1')
    })

    it('pivots each scrape into its own wide row with nulls for missing sellers', () => {
      const result = buildChartData(records)
      expect(result.rows).toHaveLength(4)

      const amazonKey = result.sellers.find(s => s.label === 'amazon.com')!.key
      const neweggKey = result.sellers.find(s => s.label === 'newegg.com')!.key

      // First row (amazon at 10:00) should have amazon populated, newegg null
      expect(result.rows[0][amazonKey]).toBe(53.99)
      expect(result.rows[0][neweggKey]).toBeNull()

      // Second row (newegg at 10:05) should have newegg populated, amazon null
      expect(result.rows[1][amazonKey]).toBeNull()
      expect(result.rows[1][neweggKey]).toBe(55.0)
    })

    it('sorts rows chronologically regardless of input order', () => {
      const unsorted = [
        rec({ id: 4, price: 54, scraped_at: '2026-04-08 11:05:00', seller_url: 'https://newegg.com/p' }),
        rec({ id: 1, price: 53, scraped_at: '2026-04-08 10:00:00', seller_url: 'https://amazon.com/dp' }),
        rec({ id: 3, price: 52, scraped_at: '2026-04-08 11:00:00', seller_url: 'https://amazon.com/dp' }),
        rec({ id: 2, price: 55, scraped_at: '2026-04-08 10:05:00', seller_url: 'https://newegg.com/p' }),
      ]
      const result = buildChartData(unsorted)
      const timestamps = result.rows.map(r => r.scraped_at)
      expect(timestamps).toEqual([
        '2026-04-08 10:00:00',
        '2026-04-08 10:05:00',
        '2026-04-08 11:00:00',
        '2026-04-08 11:05:00',
      ])
    })

    it('merges two sellers scraping at the exact same timestamp into one row', () => {
      // Rare but possible: cron ticks on a round minute and two sellers
      // finish within the same second. Their prices should land on the
      // same wide row so recharts draws them at the same X coordinate.
      const records = [
        rec({ id: 1, price: 53.99, scraped_at: '2026-04-08 10:00:00', seller_url: 'https://amazon.com/dp' }),
        rec({ id: 2, price: 55.00, scraped_at: '2026-04-08 10:00:00', seller_url: 'https://newegg.com/p' }),
      ]
      const result = buildChartData(records)
      expect(result.rows).toHaveLength(1)

      const row = result.rows[0]
      const amazonKey = result.sellers.find(s => s.label === 'amazon.com')!.key
      const neweggKey = result.sellers.find(s => s.label === 'newegg.com')!.key
      expect(row[amazonKey]).toBe(53.99)
      expect(row[neweggKey]).toBe(55.0)
    })
  })

  describe('color palette wrap-around', () => {
    it('wraps around after 8 sellers without crashing or duplicating within the first 8', () => {
      // Create 10 distinct sellers to exceed the 8-color palette
      const records = Array.from({ length: 10 }, (_, i) =>
        rec({
          id: i + 1,
          price: 10 + i,
          scraped_at: `2026-04-08 10:0${i}:00`,
          seller_url: `https://seller${i}.example.com/p`,
        }),
      )
      const result = buildChartData(records)
      expect(result.sellers).toHaveLength(10)
      // First 8 colors should all be distinct
      const first8 = result.sellers.slice(0, 8).map(s => s.color)
      expect(new Set(first8).size).toBe(8)
      // 9th wraps to the first color
      expect(result.sellers[8].color).toBe(result.sellers[0].color)
      expect(result.sellers[9].color).toBe(result.sellers[1].color)
    })
  })
})
