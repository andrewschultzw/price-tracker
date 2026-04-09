import { describe, it, expect } from 'vitest';
import { extractFromCssPatterns } from './css-patterns.js';

describe('extractFromCssPatterns', () => {
  describe('Amazon offscreen span (the critical path)', () => {
    it('extracts the full price from class="a-offscreen"', () => {
      const html = '<span class="a-offscreen">$53.99</span>';
      expect(extractFromCssPatterns(html)).toBe(53.99);
    });

    it('handles Amazon split-price markup correctly (regression test)', () => {
      // Real Amazon markup has the dollars and cents split across spans
      // for visual rendering, but the offscreen span holds the full price.
      // Before the fix, this returned 53 (wrong) because the naive
      // class matcher picked up a-price-whole first.
      const html = `
        <span class="a-price">
          <span class="a-offscreen">$53.99</span>
          <span aria-hidden="true">
            <span class="a-price-symbol">$</span>
            <span class="a-price-whole">53<span class="a-price-decimal">.</span></span>
            <span class="a-price-fraction">99</span>
          </span>
        </span>
      `;
      expect(extractFromCssPatterns(html)).toBe(53.99);
    });

    it('handles Amazon thousands separator', () => {
      const html = '<span class="a-offscreen">$1,234.56</span>';
      expect(extractFromCssPatterns(html)).toBe(1234.56);
    });

    it('picks the first a-offscreen occurrence (the main price)', () => {
      // Amazon pages have many a-offscreen spans (related products,
      // shipping options, etc). The first one is the hero price.
      const html = `
        <span class="a-offscreen">$53.99</span>
        <span class="a-offscreen">$10.00</span>
      `;
      expect(extractFromCssPatterns(html)).toBe(53.99);
    });

    it('ignores a-offscreen when it contains no price', () => {
      const html = '<span class="a-offscreen">Shipping to</span>';
      // Should fall through to the generic selector loop and return null
      // unless another pattern matches.
      expect(extractFromCssPatterns(html)).toBeNull();
    });
  });

  describe('data-price attribute', () => {
    it('extracts from data-price', () => {
      const html = '<div data-price="29.95">Buy Now</div>';
      expect(extractFromCssPatterns(html)).toBe(29.95);
    });

    it('ignores invalid data-price values', () => {
      const html = '<div data-price="NaN">Bad</div>';
      expect(extractFromCssPatterns(html)).toBeNull();
    });
  });

  describe('generic class selectors', () => {
    it('matches .price-current', () => {
      const html = '<div class="price-current">$42.00</div>';
      expect(extractFromCssPatterns(html)).toBe(42);
    });

    it('word-boundary match prevents substring collisions', () => {
      // Before the fix, matching ".price" would also match
      // "price-characteristic" because the pattern was substring-based.
      // The \b word boundary now requires a real class match.
      const html = '<div class="price-characteristic-foo">$99</div>';
      expect(extractFromCssPatterns(html)).toBeNull();
    });

    it('matches even when the target class is one of many', () => {
      const html = '<div class="foo price-current bar">$25.50</div>';
      expect(extractFromCssPatterns(html)).toBe(25.5);
    });
  });

  describe('id selectors', () => {
    it('matches #priceblock_ourprice (Amazon legacy)', () => {
      const html = '<span id="priceblock_ourprice">$88.00</span>';
      expect(extractFromCssPatterns(html)).toBe(88);
    });
  });

  describe('no match', () => {
    it('returns null on plain HTML with no price', () => {
      expect(extractFromCssPatterns('<html><body>Hello</body></html>')).toBeNull();
    });

    it('returns null on empty string', () => {
      expect(extractFromCssPatterns('')).toBeNull();
    });
  });
});
