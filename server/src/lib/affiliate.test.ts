import { describe, it, expect } from 'vitest';
import { addAmazonTag, isAmazonStorefrontUrl } from './affiliate.js';

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
