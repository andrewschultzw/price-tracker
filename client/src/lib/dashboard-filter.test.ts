import { describe, it, expect } from 'vitest'
import { parseFilter, parseSort, filterTrackers, filterCounts, sortTrackers } from './dashboard-filter'
import type { Tracker } from '../types'

// Minimal tracker factory — only fields the filter logic reads.
const t = (o: Partial<Tracker>): Tracker => ({
  id: 1,
  name: 'Widget',
  url: 'https://example.com/x',
  normalized_url: null,
  threshold_price: null,
  check_interval_minutes: 60,
  css_selector: null,
  last_price: null,
  last_checked_at: null,
  last_error: null,
  consecutive_failures: 0,
  status: 'active',
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
  ...o,
})

const fixture: Tracker[] = [
  t({ id: 1, name: 'SSD 1TB', status: 'active', threshold_price: 80, last_price: 70 }),        // below target
  t({ id: 2, name: 'GPU', status: 'active', threshold_price: 500, last_price: 600 }),          // active
  t({ id: 3, name: 'Router', status: 'active', consecutive_failures: 5, last_error: 'boom' }),   // errored (isErrored)
  t({ id: 4, name: 'Desk', status: 'paused' }),                                                // paused
  t({ id: 5, name: 'Chair', status: 'purchased', url: 'https://wayfair.com/chair' }),          // purchased
  t({ id: 6, name: 'TV', status: 'blocked', url: 'https://bestbuy.com/tv' }),                  // WAF-blocked
]

describe('parseFilter', () => {
  it('passes through valid filters', () => expect(parseFilter('errors')).toBe('errors'))
  it('falls back to all on null', () => expect(parseFilter(null)).toBe('all'))
  it('falls back to all on junk', () => expect(parseFilter('bogus')).toBe('all'))
})

describe('parseSort', () => {
  it('passes through valid sort modes', () => expect(parseSort('price')).toBe('price'))
  it('falls back to smart on junk', () => expect(parseSort('bogus')).toBe('smart'))
})

describe('filterTrackers', () => {
  it('all hides purchased', () =>
    expect(filterTrackers(fixture, 'all', '').map(x => x.id)).toEqual([1, 2, 3, 4, 6]))
  it('purchased shows only purchased', () =>
    expect(filterTrackers(fixture, 'purchased', '').map(x => x.id)).toEqual([5]))
  it('active excludes paused, errored, purchased', () =>
    expect(filterTrackers(fixture, 'active', '').map(x => x.id)).toEqual([1, 2]))
  it('below-target matches threshold rule', () =>
    expect(filterTrackers(fixture, 'below-target', '').map(x => x.id)).toEqual([1]))
  it('errors uses isErrored', () =>
    expect(filterTrackers(fixture, 'errors', '').map(x => x.id)).toEqual([3]))
  it('paused shows only paused', () =>
    expect(filterTrackers(fixture, 'paused', '').map(x => x.id)).toEqual([4]))
  it('blocked shows only WAF-blocked', () =>
    expect(filterTrackers(fixture, 'blocked', '').map(x => x.id)).toEqual([6]))
  it('errors excludes blocked — a re-check cannot fix a WAF block', () =>
    expect(filterTrackers(fixture, 'errors', '').map(x => x.id)).not.toContain(6))
  it('query matches title case-insensitively', () =>
    expect(filterTrackers(fixture, 'all', 'ssd').map(x => x.id)).toEqual([1]))
  it('query matches hostname', () =>
    expect(filterTrackers(fixture, 'purchased', 'wayfair').map(x => x.id)).toEqual([5]))
  it('malformed tracker URL: name still matches, hostname search does not throw', () => {
    const malformed = t({ id: 7, name: 'Mystery Gadget', url: 'not a url' })
    expect(filterTrackers([malformed], 'all', 'mystery').map(x => x.id)).toEqual([7])
    expect(filterTrackers([malformed], 'all', 'example.com')).toEqual([])
  })
})

describe('filterCounts', () => {
  it('counts every bucket', () =>
    expect(filterCounts(fixture)).toEqual({
      all: 5, active: 2, 'below-target': 1, errors: 1, blocked: 1, paused: 1, purchased: 1,
    }))
})

describe('sortTrackers', () => {
  it('smart returns input order untouched', () =>
    expect(sortTrackers(fixture, 'smart').map(x => x.id)).toEqual([1, 2, 3, 4, 5, 6]))
  it('price sorts ascending, null prices last', () => {
    const ids = sortTrackers(fixture, 'price').map(x => x.id)
    expect(ids.slice(0, 3)).toEqual([1, 2, 3].sort((a, b) => {
      const p = (id: number) => fixture.find(f => f.id === id)!.last_price ?? Infinity
      return p(a) - p(b)
    }))
    expect(ids.indexOf(4)).toBeGreaterThan(ids.indexOf(2)) // null price after real prices
  })
  it('alpha sorts by title', () =>
    expect(sortTrackers(fixture, 'alpha').map(x => x.name)).toEqual(
      [...fixture.map(x => x.name)].sort((a, b) => a.localeCompare(b))))
  it('recent sorts by last_checked_at descending, never-checked last', () => {
    const staleFirst = [
      t({ id: 1, last_checked_at: '2026-01-01T00:00:00Z' }),
      t({ id: 2, last_checked_at: null }),
      t({ id: 3, last_checked_at: '2026-06-01T00:00:00Z' }),
      t({ id: 4, last_checked_at: '2026-03-01T00:00:00Z' }),
    ]
    expect(sortTrackers(staleFirst, 'recent').map(x => x.id)).toEqual([3, 4, 1, 2])
  })
})
