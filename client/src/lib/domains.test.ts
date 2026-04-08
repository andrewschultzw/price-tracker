import { describe, it, expect } from 'vitest'
import { canonicalDomain } from './domains'

describe('canonicalDomain', () => {
  describe('Amazon family', () => {
    it.each([
      'https://www.amazon.com/dp/B08X1W4V1J',
      'https://a.co/d/abc123',
      'https://amzn.to/3xYz789',
      'https://smile.amazon.com/dp/B08X1W4V1J',
      'https://www.amazon.co.uk/dp/B08X1W4V1J',
      'https://www.amazon.de/dp/B08X1W4V1J',
    ])('%s → amazon.com', url => {
      expect(canonicalDomain(url)).toBe('amazon.com')
    })

    it('maps subdomains of amazon.com via suffix match', () => {
      expect(canonicalDomain('https://music.amazon.com/albums/abc')).toBe('amazon.com')
    })
  })

  describe('other known retailers', () => {
    it.each([
      ['https://www.newegg.com/p/123', 'newegg.com'],
      ['https://newegg.ca/p/123', 'newegg.com'],
      ['https://www.bestbuy.com/site/123', 'bestbuy.com'],
      ['https://www.walmart.com/ip/123', 'walmart.com'],
      ['https://www.target.com/p/123', 'target.com'],
      ['https://www.ebay.com/itm/123', 'ebay.com'],
      ['https://www.ebay.co.uk/itm/123', 'ebay.com'],
      ['https://www.bhphotovideo.com/c/product/123', 'bhphotovideo.com'],
      ['https://bh.com/c/product/123', 'bhphotovideo.com'],
      ['https://www.homedepot.com/p/123', 'homedepot.com'],
    ])('%s → %s', (url, expected) => {
      expect(canonicalDomain(url)).toBe(expected)
    })
  })

  describe('unknown hostnames', () => {
    it('strips leading www. but otherwise returns the hostname as-is', () => {
      expect(canonicalDomain('https://www.example.com/product')).toBe('example.com')
      expect(canonicalDomain('https://shop.example.com/product')).toBe('shop.example.com')
    })

    it('returns empty string for invalid URLs', () => {
      expect(canonicalDomain('not-a-url')).toBe('')
      expect(canonicalDomain('')).toBe('')
    })

    it('lowercases the hostname', () => {
      expect(canonicalDomain('https://EXAMPLE.COM/product')).toBe('example.com')
    })
  })

  describe('suffix match precedence', () => {
    it('prefers exact match over suffix match', () => {
      // Exact "newegg.com" match wins — no suffix lookup needed
      expect(canonicalDomain('https://newegg.com/p/123')).toBe('newegg.com')
    })

    it('suffix match handles arbitrary subdomain prefixes', () => {
      expect(canonicalDomain('https://deeply.nested.amazon.co.uk/dp/X')).toBe('amazon.com')
    })
  })
})
