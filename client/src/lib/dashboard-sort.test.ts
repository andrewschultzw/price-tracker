import { describe, it, expect } from 'vitest'
import type { Tracker } from '../types'
import { buildDashboardLayout, CATEGORY_COLLAPSE_THRESHOLD } from './dashboard-sort'

function makeTracker({ id, url, ...rest }: Partial<Tracker> & { id: number; url: string }): Tracker {
  return {
    id,
    url,
    name: `Tracker ${id}`,
    threshold_price: null,
    check_interval_minutes: 60,
    css_selector: null,
    last_price: null,
    last_checked_at: null,
    last_error: null,
    consecutive_failures: 0,
    status: 'active',
    created_at: '2026-04-01 00:00:00',
    updated_at: '2026-04-08 12:00:00',
    ...rest,
  } as Tracker
}

describe('buildDashboardLayout', () => {
  describe('bucket ordering', () => {
    it('places errored before below-target before active before paused', () => {
      const trackers: Tracker[] = [
        makeTracker({ id: 1, url: 'https://a.example.com/1', status: 'active' }),
        makeTracker({ id: 2, url: 'https://b.example.com/1', status: 'paused' }),
        makeTracker({ id: 3, url: 'https://c.example.com/1', status: 'error' }),
        makeTracker({
          id: 4, url: 'https://d.example.com/1',
          status: 'active', threshold_price: 100, last_price: 50,
        }),
      ]

      const { items } = buildDashboardLayout(trackers)
      const ids = items.filter(i => i.kind === 'tracker').map(i => (i as { tracker: Tracker }).tracker.id)
      expect(ids).toEqual([3, 4, 1, 2]) // errored, below-target, active, paused
    })

    it('treats a tracker with last_error set as errored even if status is still active', () => {
      // This is the scheduler's transient-failure case — status hasn't flipped yet
      // but the most recent scrape failed, so the user needs to see it at the top.
      const trackers: Tracker[] = [
        makeTracker({ id: 1, url: 'https://a.example.com/1', status: 'active' }),
        makeTracker({
          id: 2, url: 'https://b.example.com/1',
          status: 'active', last_error: 'ECONNRESET', consecutive_failures: 1,
        }),
      ]
      const { items, totalErrored } = buildDashboardLayout(trackers)
      const ids = items.map(i => (i as { tracker: Tracker }).tracker.id)
      expect(ids).toEqual([2, 1])
      expect(totalErrored).toBe(1)
    })

    it('places below-target only for active trackers (not errored or paused)', () => {
      const trackers: Tracker[] = [
        makeTracker({
          id: 1, url: 'https://a.example.com/1',
          status: 'paused', threshold_price: 100, last_price: 50,
        }),
        makeTracker({
          id: 2, url: 'https://b.example.com/1',
          status: 'active', threshold_price: 100, last_price: 50,
        }),
      ]
      const { items } = buildDashboardLayout(trackers)
      // id 2 is the only true below-target; id 1 is paused
      expect(items[0].kind === 'tracker' && items[0].tracker.id).toBe(2)
      expect(items[1].kind === 'tracker' && items[1].tracker.id).toBe(1)
    })
  })

  describe('category collapse', () => {
    it(`collapses a domain with more than ${CATEGORY_COLLAPSE_THRESHOLD} trackers`, () => {
      const trackers: Tracker[] = Array.from({ length: CATEGORY_COLLAPSE_THRESHOLD + 1 }, (_, i) =>
        makeTracker({ id: i + 1, url: `https://www.amazon.com/dp/X${i}` }),
      )
      const { items } = buildDashboardLayout(trackers)
      expect(items).toHaveLength(1)
      expect(items[0].kind).toBe('category')
      if (items[0].kind === 'category') {
        expect(items[0].hostname).toBe('amazon.com')
        expect(items[0].trackers).toHaveLength(CATEGORY_COLLAPSE_THRESHOLD + 1)
      }
    })

    it(`does NOT collapse a domain with exactly ${CATEGORY_COLLAPSE_THRESHOLD} trackers`, () => {
      const trackers: Tracker[] = Array.from({ length: CATEGORY_COLLAPSE_THRESHOLD }, (_, i) =>
        makeTracker({ id: i + 1, url: `https://www.amazon.com/dp/X${i}` }),
      )
      const { items } = buildDashboardLayout(trackers)
      expect(items).toHaveLength(CATEGORY_COLLAPSE_THRESHOLD)
      for (const item of items) expect(item.kind).toBe('tracker')
    })

    it('groups short-links and regional variants into one category', () => {
      // a.co, amzn.to, amazon.co.uk all canonicalize to amazon.com
      const urls = [
        'https://www.amazon.com/dp/1', 'https://www.amazon.com/dp/2',
        'https://www.amazon.com/dp/3', 'https://www.amazon.com/dp/4',
        'https://a.co/d/5', 'https://a.co/d/6',
        'https://amzn.to/7', 'https://amzn.to/8',
        'https://www.amazon.co.uk/dp/9', 'https://www.amazon.de/dp/10',
        'https://smile.amazon.com/dp/11',
      ]
      const trackers = urls.map((url, i) => makeTracker({ id: i + 1, url }))
      const { items } = buildDashboardLayout(trackers)
      expect(items).toHaveLength(1)
      if (items[0].kind === 'category') {
        expect(items[0].hostname).toBe('amazon.com')
        expect(items[0].trackers).toHaveLength(11)
      }
    })

    it('places a category with errors in the errored bucket', () => {
      const amazon: Tracker[] = Array.from({ length: CATEGORY_COLLAPSE_THRESHOLD + 1 }, (_, i) =>
        makeTracker({ id: i + 1, url: `https://www.amazon.com/dp/X${i}` }),
      )
      // Force one tracker in the group to be errored
      amazon[0] = { ...amazon[0], status: 'error' }

      const lonelyGoodTracker = makeTracker({
        id: 999, url: 'https://www.example.com/thing', status: 'active',
      })

      const { items } = buildDashboardLayout([...amazon, lonelyGoodTracker])
      // Category bubbles to the top of the errored bucket
      expect(items[0].kind).toBe('category')
      // Then the lonely good active tracker
      const lastItem = items[items.length - 1]
      expect(lastItem.kind === 'tracker' && lastItem.tracker.id).toBe(999)
    })

    it('places a category with no errors but some below-target in the below-target bucket', () => {
      const amazon: Tracker[] = Array.from({ length: CATEGORY_COLLAPSE_THRESHOLD + 1 }, (_, i) =>
        makeTracker({ id: i + 1, url: `https://www.amazon.com/dp/X${i}` }),
      )
      amazon[0] = { ...amazon[0], threshold_price: 100, last_price: 50 }
      const errored = makeTracker({
        id: 999, url: 'https://www.example.com/thing', status: 'error',
      })

      const { items } = buildDashboardLayout([...amazon, errored])
      // errored tracker first (bucket 1), then amazon category (bucket 2)
      expect(items[0].kind === 'tracker' && items[0].tracker.id).toBe(999)
      expect(items[1].kind).toBe('category')
    })
  })

  describe('summary counts', () => {
    it('counts errored items from both individuals and categories', () => {
      const amazon: Tracker[] = Array.from({ length: CATEGORY_COLLAPSE_THRESHOLD + 1 }, (_, i) =>
        makeTracker({ id: i + 1, url: `https://www.amazon.com/dp/X${i}` }),
      )
      // Two errored trackers inside the collapsed category
      amazon[0] = { ...amazon[0], status: 'error' }
      amazon[1] = { ...amazon[1], last_error: 'boom', consecutive_failures: 1 }

      const erroredIndividual = makeTracker({
        id: 999, url: 'https://www.example.com/thing', status: 'error',
      })

      const { totalErrored, totalActive } = buildDashboardLayout([...amazon, erroredIndividual])
      expect(totalErrored).toBe(3) // two in category + one individual
      // totalActive counts status==='active' only. Of the 11 amazon items:
      //   - index[0] was flipped to status='error' (not active)
      //   - index[1] kept status='active' but has last_error set (still active for this count)
      //   - the other 9 are active.
      // The extra individual is status='error'. Result: 10.
      expect(totalActive).toBe(CATEGORY_COLLAPSE_THRESHOLD)
    })

    it('handles an empty tracker list', () => {
      const { items, totalErrored, totalActive } = buildDashboardLayout([])
      expect(items).toEqual([])
      expect(totalErrored).toBe(0)
      expect(totalActive).toBe(0)
    })
  })
})
