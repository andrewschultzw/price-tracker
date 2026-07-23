import { describe, expect, it } from 'vitest';
import { extractAvailability } from './availability.js';

const ld = (obj: unknown): string =>
  `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

describe('extractAvailability', () => {
  it('maps schema.org InStock in all URL spellings', () => {
    for (const v of ['https://schema.org/InStock', 'http://schema.org/InStock', 'InStock', 'instock']) {
      expect(extractAvailability(ld({ '@type': 'Offer', availability: v }))).toBe('in_stock');
    }
  });

  it('maps OutOfStock / SoldOut / Discontinued', () => {
    for (const v of ['https://schema.org/OutOfStock', 'SoldOut', 'Discontinued']) {
      expect(extractAvailability(ld({ '@type': 'Offer', availability: v }))).toBe('out_of_stock');
    }
  });

  it('finds signals nested in Product.offers and @graph', () => {
    const html = ld({
      '@graph': [{ '@type': 'Product', offers: { '@type': 'Offer', availability: 'https://schema.org/OutOfStock' } }],
    });
    expect(extractAvailability(html)).toBe('out_of_stock');
  });

  it('any in-stock variant wins over sold-out variants', () => {
    const html = ld({
      '@type': 'Product',
      offers: [
        { availability: 'https://schema.org/OutOfStock' },
        { availability: 'https://schema.org/InStock' },
      ],
    });
    expect(extractAvailability(html)).toBe('in_stock');
  });

  it('no signal and unknown values return null (never inferred)', () => {
    expect(extractAvailability('<html><body>plain page</body></html>')).toBeNull();
    expect(extractAvailability(ld({ availability: 'https://schema.org/BackOrder' }))).toBeNull();
    expect(extractAvailability(ld({ availability: 42 }))).toBeNull();
  });

  it('tolerates invalid JSON-LD blocks', () => {
    const html = `<script type="application/ld+json">{broken</script>` +
      ld({ availability: 'InStock' });
    expect(extractAvailability(html)).toBe('in_stock');
  });
});
