import { describe, it, expect } from 'vitest'
import { getTier, pickSaying, getTierDefinitions } from './savings-tiers'

describe('getTier', () => {
  describe('boundaries are half-open [min, max)', () => {
    it.each([
      [1, 1],
      [5, 1],
      [9.99, 1],
      [10, 2],
      [10.01, 2],
      [24.99, 2],
      [25, 3],
      [49.99, 3],
      [50, 4],
      [99.99, 4],
      [100, 5],
      [249.99, 5],
      [250, 6],
      [500, 6],
      [9999, 6],
    ])('$%s → tier %s', (savings, expected) => {
      expect(getTier(savings)).toBe(expected)
    })
  })

  describe('rejects invalid or trivial savings', () => {
    it.each([
      ['zero', 0],
      ['negative', -5],
      ['under one dollar', 0.5],
      ['NaN', NaN],
      ['Infinity', Infinity],
      ['-Infinity', -Infinity],
    ])('%s → null', (_desc, savings) => {
      expect(getTier(savings)).toBeNull()
    })
  })
})

describe('pickSaying', () => {
  it('returns a saying from the tier', () => {
    const result = pickSaying(1, () => 0)  // deterministic: first saying
    expect(result).toBe('Every dollar counts.')
  })

  it('with rng=0.999 picks the last saying (no off-by-one)', () => {
    const result = pickSaying(1, () => 0.999)
    expect(result).toBe("That's a snack, at least.")
  })

  it('tier 6 last saying', () => {
    const result = pickSaying(6, () => 0.999)
    expect(result).toBe('You just out-bargained the entire internet.')
  })

  it('throws on unknown tier', () => {
    expect(() => pickSaying(99 as unknown as 1)).toThrow(/Unknown tier/)
  })

  it('defaults to Math.random when no rng provided', () => {
    // Just verify it runs without error and returns a string
    const result = pickSaying(3)
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThan(0)
  })
})

describe('getTierDefinitions', () => {
  it('returns all 6 tiers in order', () => {
    const defs = getTierDefinitions()
    expect(defs.map(d => d.tier)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('every tier has 5 sayings (current design contract)', () => {
    const defs = getTierDefinitions()
    for (const d of defs) {
      expect(d.sayings.length).toBe(5)
    }
  })

  it('tier boundaries form a continuous range with no gaps or overlaps', () => {
    const defs = getTierDefinitions()
    for (let i = 1; i < defs.length; i++) {
      expect(defs[i].min).toBe(defs[i - 1].max)
    }
    expect(defs[0].min).toBe(1)
    expect(defs[defs.length - 1].max).toBe(Infinity)
  })
})
