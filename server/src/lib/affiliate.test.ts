import { describe, it, expect } from 'vitest';
import {
  addAmazonTag,
  isAmazonStorefrontUrl,
  canonicalizeAmazonUrl,
  extractAmazonAsin,
} from './affiliate.js';

describe('isAmazonStorefrontUrl', () => {
  it('matches amazon.com and common subdomains', () => {
    expect(isAmazonStorefrontUrl('https://www.amazon.com/dp/B01')).toBe(true);
    expect(isAmazonStorefrontUrl('https://amazon.com/dp/B01')).toBe(true);
    expect(isAmazonStorefrontUrl('https://smile.amazon.com/dp/B01')).toBe(true);
  });

  it('matches regional Amazon TLDs', () => {
    expect(isAmazonStorefrontUrl('https://amazon.co.uk/dp/B01')).toBe(true);
    expect(isAmazonStorefrontUrl('https://www.amazon.de/dp/B01')).toBe(true);
    expect(isAmazonStorefrontUrl('https://amazon.co.jp/dp/B01')).toBe(true);
  });

  it('does NOT match short-link redirectors', () => {
    // amzn.to / a.co are 30x redirectors — query params don't survive
    // the redirect, so tagging the short URL would do nothing.
    expect(isAmazonStorefrontUrl('https://a.co/d/xyz')).toBe(false);
    expect(isAmazonStorefrontUrl('https://amzn.to/3xyz')).toBe(false);
  });

  it('does NOT match phishy lookalike hosts', () => {
    expect(isAmazonStorefrontUrl('https://amazon.com.evil.example/p')).toBe(false);
    expect(isAmazonStorefrontUrl('https://fakeamazon.com/p')).toBe(false);
  });

  it('does NOT match other retailers', () => {
    expect(isAmazonStorefrontUrl('https://newegg.com/p/x')).toBe(false);
    expect(isAmazonStorefrontUrl('https://bestbuy.com/site/x')).toBe(false);
  });

  it('returns false for malformed input', () => {
    expect(isAmazonStorefrontUrl('not a url')).toBe(false);
    expect(isAmazonStorefrontUrl('')).toBe(false);
  });
});

describe('addAmazonTag', () => {
  const TAG = 'mytag-20';

  it('appends tag to a tagless Amazon URL', () => {
    expect(addAmazonTag('https://www.amazon.com/dp/B01', TAG))
      .toBe('https://www.amazon.com/dp/B01?tag=mytag-20');
  });

  it('replaces an existing tag — does not double up or keep someone else\'s', () => {
    expect(addAmazonTag('https://www.amazon.com/dp/B01?tag=otherperson-20', TAG))
      .toBe('https://www.amazon.com/dp/B01?tag=mytag-20');
  });

  it('preserves other query params', () => {
    const result = addAmazonTag('https://www.amazon.com/dp/B01?th=1&psc=1', TAG);
    // The order URL.searchParams emits is param-insertion order, so
    // assert structurally rather than as a fixed string.
    const u = new URL(result);
    expect(u.searchParams.get('tag')).toBe('mytag-20');
    expect(u.searchParams.get('th')).toBe('1');
    expect(u.searchParams.get('psc')).toBe('1');
  });

  it('leaves non-Amazon URLs untouched', () => {
    expect(addAmazonTag('https://newegg.com/p/x', TAG))
      .toBe('https://newegg.com/p/x');
    expect(addAmazonTag('https://bestbuy.com/site/abc', TAG))
      .toBe('https://bestbuy.com/site/abc');
  });

  it('leaves short links untouched', () => {
    // We can't tag a short link meaningfully — the redirect strips query
    // params before reaching amazon.com. Return as-is.
    expect(addAmazonTag('https://a.co/d/xyz', TAG))
      .toBe('https://a.co/d/xyz');
    expect(addAmazonTag('https://amzn.to/3xyz', TAG))
      .toBe('https://amzn.to/3xyz');
  });

  it('leaves URL untouched when tag is empty or whitespace', () => {
    // Treats unset/blank affiliate config as "feature off."
    expect(addAmazonTag('https://www.amazon.com/dp/B01', ''))
      .toBe('https://www.amazon.com/dp/B01');
    expect(addAmazonTag('https://www.amazon.com/dp/B01', '   '))
      .toBe('https://www.amazon.com/dp/B01');
  });

  it('passes malformed URLs through unchanged', () => {
    expect(addAmazonTag('not a url', TAG)).toBe('not a url');
    expect(addAmazonTag('', TAG)).toBe('');
  });

  it('works for regional Amazon TLDs (.co.uk, .de, .ca)', () => {
    expect(addAmazonTag('https://www.amazon.co.uk/dp/B01', TAG))
      .toBe('https://www.amazon.co.uk/dp/B01?tag=mytag-20');
    expect(addAmazonTag('https://amazon.de/dp/B01', TAG))
      .toBe('https://amazon.de/dp/B01?tag=mytag-20');
  });
});

describe('extractAmazonAsin', () => {
  it('pulls ASIN from /dp/<ASIN>', () => {
    expect(extractAmazonAsin('https://www.amazon.com/dp/B01N5IB20Q')).toBe('B01N5IB20Q');
  });

  it('pulls ASIN from /<title-slug>/dp/<ASIN> (most-common search-result form)', () => {
    expect(extractAmazonAsin(
      'https://www.amazon.com/Crocs-Unisex-Classic-Seasonal-Graphic/dp/B0FF2RJ11H/ref=sr_1_3',
    )).toBe('B0FF2RJ11H');
  });

  it('pulls ASIN from /gp/product/<ASIN> (legacy form)', () => {
    expect(extractAmazonAsin('https://www.amazon.com/gp/product/B01N5IB20Q')).toBe('B01N5IB20Q');
  });

  it('pulls ASIN from /gp/aw/d/<ASIN> (mobile-web form)', () => {
    expect(extractAmazonAsin('https://www.amazon.com/gp/aw/d/B01N5IB20Q')).toBe('B01N5IB20Q');
  });

  it('upper-cases lowercased ASIN paths (stable canonical form)', () => {
    expect(extractAmazonAsin('https://www.amazon.com/dp/b01n5ib20q')).toBe('B01N5IB20Q');
  });

  it('returns null when path has no ASIN', () => {
    // Search-results page, no product ASIN to extract.
    expect(extractAmazonAsin('https://www.amazon.com/s?k=crocs')).toBeNull();
    // Browse-node page.
    expect(extractAmazonAsin('https://www.amazon.com/b?node=12345')).toBeNull();
    // Storefront page.
    expect(extractAmazonAsin('https://www.amazon.com/stores/brand/abc')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(extractAmazonAsin('not a url')).toBeNull();
    expect(extractAmazonAsin('')).toBeNull();
  });
});

describe('canonicalizeAmazonUrl', () => {
  it('collapses the search-noise nightmare to /dp/<ASIN>', () => {
    const ugly =
      'https://www.amazon.com/Crocs-Unisex-Classic-Seasonal-Graphic/dp/B0FF2RJ11H/ref=sr_1_3' +
      '?crid=UZR6NZ6ZRCK3&dib=eyJ2IjoiMSJ9&dib_tag=se&keywords=crocs&qid=1778176964&sr=8-3&th=1&psc=1';
    expect(canonicalizeAmazonUrl(ugly)).toBe('https://www.amazon.com/dp/B0FF2RJ11H');
  });

  it('drops /ref=... path segments but keeps the host', () => {
    expect(canonicalizeAmazonUrl('https://www.amazon.com/dp/B01N5IB20Q/ref=cm_sw_r_apan'))
      .toBe('https://www.amazon.com/dp/B01N5IB20Q');
  });

  it('preserves regional hosts (.co.uk, .de)', () => {
    expect(canonicalizeAmazonUrl('https://www.amazon.co.uk/dp/B01N5IB20Q?ref=foo'))
      .toBe('https://www.amazon.co.uk/dp/B01N5IB20Q');
    expect(canonicalizeAmazonUrl('https://amazon.de/X-Y-Z/dp/B01N5IB20Q?keywords=stuff'))
      .toBe('https://amazon.de/dp/B01N5IB20Q');
  });

  it('rewrites /gp/product/<ASIN> to the canonical /dp/<ASIN>', () => {
    // Stable canonical regardless of which legacy path the user pasted.
    expect(canonicalizeAmazonUrl('https://www.amazon.com/gp/product/B01N5IB20Q?th=1'))
      .toBe('https://www.amazon.com/dp/B01N5IB20Q');
  });

  it('leaves URL unchanged when no ASIN can be extracted', () => {
    // Search-results URL — there is no single canonical product, so
    // don't mangle it. Better a working URL with noise than a broken
    // canonical guess.
    const search = 'https://www.amazon.com/s?k=crocs';
    expect(canonicalizeAmazonUrl(search)).toBe(search);
  });

  it('leaves non-Amazon URLs untouched', () => {
    expect(canonicalizeAmazonUrl('https://newegg.com/p/abc?ref=xyz'))
      .toBe('https://newegg.com/p/abc?ref=xyz');
  });

  it('leaves short links untouched (they redirect; we can\'t canonicalize without resolving)', () => {
    expect(canonicalizeAmazonUrl('https://a.co/d/xyz')).toBe('https://a.co/d/xyz');
    expect(canonicalizeAmazonUrl('https://amzn.to/3xyz')).toBe('https://amzn.to/3xyz');
  });

  it('is idempotent — already-canonical URLs stay put', () => {
    const canonical = 'https://www.amazon.com/dp/B01N5IB20Q';
    expect(canonicalizeAmazonUrl(canonical)).toBe(canonical);
  });

  it('passes malformed URLs through unchanged', () => {
    expect(canonicalizeAmazonUrl('not a url')).toBe('not a url');
  });
});
