import { describe, it, expect } from 'vitest';
import { extractFromJsonLd } from './jsonld.js';

function wrap(ld: object | object[]): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head></html>`;
}

describe('extractFromJsonLd', () => {
  it('extracts price from a direct Offer', () => {
    const html = wrap({ '@type': 'Offer', price: '19.99' });
    expect(extractFromJsonLd(html)).toBe(19.99);
  });

  it('extracts price from a Product with nested offers', () => {
    const html = wrap({
      '@type': 'Product',
      name: 'Widget',
      offers: { '@type': 'Offer', price: 49.5 },
    });
    expect(extractFromJsonLd(html)).toBe(49.5);
  });

  it('extracts lowPrice from AggregateOffer', () => {
    const html = wrap({ '@type': 'AggregateOffer', lowPrice: '100', highPrice: '200' });
    expect(extractFromJsonLd(html)).toBe(100);
  });

  it('walks @graph arrays', () => {
    const html = wrap({
      '@graph': [
        { '@type': 'Organization', name: 'Test Co' },
        { '@type': 'Product', offers: { '@type': 'Offer', price: '74.99' } },
      ],
    });
    expect(extractFromJsonLd(html)).toBe(74.99);
  });

  it('recurses into deeply nested structures', () => {
    const html = wrap({
      mainEntity: {
        productGroup: {
          offers: { '@type': 'Offer', price: '5.00' },
        },
      },
    });
    expect(extractFromJsonLd(html)).toBe(5);
  });

  it('ignores invalid JSON blocks and moves on', () => {
    const html = `
      <script type="application/ld+json">{ not valid json </script>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Offer', price: '42.00' })}</script>
    `;
    expect(extractFromJsonLd(html)).toBe(42);
  });

  it('returns null when no JSON-LD script tags are present', () => {
    expect(extractFromJsonLd('<html><body>no scripts here</body></html>')).toBeNull();
  });

  it('returns null when JSON-LD exists but contains no price', () => {
    const html = wrap({ '@type': 'Article', headline: 'Not a product' });
    expect(extractFromJsonLd(html)).toBeNull();
  });

  it('rejects zero and negative prices', () => {
    expect(extractFromJsonLd(wrap({ '@type': 'Offer', price: '0' }))).toBeNull();
    expect(extractFromJsonLd(wrap({ '@type': 'Offer', price: '-10' }))).toBeNull();
  });

  it('handles a top-level array of objects', () => {
    const html = wrap([
      { '@type': 'Organization' },
      { '@type': 'Offer', price: '25' },
    ]);
    expect(extractFromJsonLd(html)).toBe(25);
  });
});
