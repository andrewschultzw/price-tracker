import { describe, it, expect } from 'vitest';
import { extractFromCssPatterns } from './css-patterns.js';

describe('extractFromCssPatterns', () => {
  describe('Amazon-direct seller preference (highest priority)', () => {
    // Amazon's retail marketplace seller ID (stable, well-known).
    const AMAZON_RETAIL_SELLER_ID = 'ATVPDKIKX0DER'
    const THIRD_PARTY_SELLER_ID = 'A3G95P41TUE85V'

    function makeForm(seller: string, price: string, itemIdx = 0): string {
      // Approximate the shape of one Amazon buy-option form: a
      // customerVisiblePrice hidden input followed by a merchantID
      // hidden input within a few hundred chars.
      return `
        <form>
          <input type="hidden" name="items[${itemIdx}.base][customerVisiblePrice][currencyCode]" value="USD">
          <input type="hidden" name="items[${itemIdx}.base][customerVisiblePrice][displayString]" value="${price}" id="items[${itemIdx}.base][customerVisiblePrice][displayString]">
          <span>some padding content</span>
          <input type="hidden" id="merchantID" name="merchantID" value="${seller}">
        </form>
      `
    }

    it('picks the Amazon-direct price when multiple sellers exist (the Husq Chainsaw regression)', () => {
      // Replicates the real-world case: a third-party seller wins the
      // anonymous buy box at $53.99 but Amazon.com also sells the item
      // at $72.00. The user expects $72.00.
      const html = `
        ${makeForm(THIRD_PARTY_SELLER_ID, '$53.99')}
        <span class="a-offscreen">$53.99</span>
        ${makeForm(AMAZON_RETAIL_SELLER_ID, '$72.00')}
        ${makeForm(THIRD_PARTY_SELLER_ID, '$53.99')}
        <span id="apex-pricetopay-accessibility-label"> $53.99 </span>
      `
      expect(extractFromCssPatterns(html)).toBe(72)
    })

    it('returns the Amazon-direct price even when it is cheapest', () => {
      // Sanity check: the rule is "prefer Amazon-direct", not "prefer
      // the higher price".
      const html = `
        ${makeForm(AMAZON_RETAIL_SELLER_ID, '$19.99')}
        ${makeForm(THIRD_PARTY_SELLER_ID, '$29.99')}
      `
      expect(extractFromCssPatterns(html)).toBe(19.99)
    })

    it('falls through to accessibility label when no Amazon-direct offer exists', () => {
      // Product only sold by third parties — no ATVPDKIKX0DER on the
      // page. The accessibility label is the correct fallback.
      const html = `
        ${makeForm(THIRD_PARTY_SELLER_ID, '$53.99')}
        <span id="apex-pricetopay-accessibility-label"> $53.99 </span>
      `
      expect(extractFromCssPatterns(html)).toBe(53.99)
    })

    it('falls through when merchantID is absent near the price', () => {
      // Defensive: no merchantID input paired with the price. Not a
      // real Amazon shape, but the extractor should not crash or hang.
      const html = `
        <input type="hidden" name="items[0.base][customerVisiblePrice][displayString]" value="$40.00">
        <span class="a-offscreen">$40.00</span>
      `
      expect(extractFromCssPatterns(html)).toBe(40)
    })

    it('handles the merchantID being beyond the lookahead window', () => {
      // If the merchantID is more than ~3000 chars after the price,
      // the extractor won't pair them — that's the safety margin.
      // A huge chunk of unrelated HTML between them breaks the pairing.
      const filler = 'x'.repeat(3500)
      const html = `
        <input type="hidden" name="items[0.base][customerVisiblePrice][displayString]" value="$72.00">
        ${filler}
        <input type="hidden" id="merchantID" name="merchantID" value="ATVPDKIKX0DER">
        <span class="a-offscreen">$53.99</span>
      `
      // Pairing fails → falls through to a-offscreen (the generic path)
      expect(extractFromCssPatterns(html)).toBe(53.99)
    })

    it('picks the first Amazon-direct offer when multiple Amazon forms exist', () => {
      // Unusual but possible: Amazon sometimes renders the same
      // Amazon-direct offer twice (different accordion states). Both
      // should have the same price; we take the first.
      const html = `
        ${makeForm(AMAZON_RETAIL_SELLER_ID, '$72.00')}
        ${makeForm(AMAZON_RETAIL_SELLER_ID, '$72.00')}
      `
      expect(extractFromCssPatterns(html)).toBe(72)
    })
  })

  describe('Amazon price-to-pay accessibility label (second priority)', () => {
    it('extracts the canonical main price from apex-pricetopay-accessibility-label', () => {
      // This is the authoritative "price you pay" label Amazon uses for
      // screen readers. It's a singleton and always points at the main
      // buy box price, unlike .a-offscreen which can belong to any of
      // several prices on the page.
      const html = '<span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> $72.00 </span>'
      expect(extractFromCssPatterns(html)).toBe(72)
    })

    it('handles the real-world data-attribute-laden span', () => {
      const html = `
        <span id="apex-pricetopay-accessibility-label"
              data-pricetopay-savings-label="{priceToPay} with {savings} percent savings"
              class="aok-offscreen">
          $72.00
        </span>
      `
      expect(extractFromCssPatterns(html)).toBe(72)
    })

    it('wins over a-offscreen spans that appear earlier in the document', () => {
      // This is the tracker #20 (Husq Chainsaw Case) regression. Before
      // the fix, the first a-offscreen ($53.99 from "Other Sellers")
      // would win over the real main price ($72.00). The accessibility
      // label must beat any a-offscreen wherever it appears.
      const html = `
        <span class="a-offscreen">$53.99</span>
        <span class="a-offscreen">$53.99</span>
        <span class="a-offscreen">$53.99</span>
        ...lots of other sellers tooltip stuff...
        <span id="apex-pricetopay-accessibility-label" class="aok-offscreen"> $72.00 </span>
      `
      expect(extractFromCssPatterns(html)).toBe(72)
    })

    it('falls back to a-offscreen when the accessibility label is missing', () => {
      // Older Amazon layouts and non-product pages don't have the
      // accessibility label. The generic offscreen fallback still works
      // for single-price pages.
      const html = '<span class="a-offscreen">$19.99</span>'
      expect(extractFromCssPatterns(html)).toBe(19.99)
    })

    it('handles thousands separators and cents in the accessibility label', () => {
      const html = '<span id="apex-pricetopay-accessibility-label">$1,234.56</span>'
      expect(extractFromCssPatterns(html)).toBe(1234.56)
    })
  })

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
