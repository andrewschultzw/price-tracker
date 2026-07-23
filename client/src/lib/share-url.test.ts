import { describe, expect, it } from 'vitest';
import { cleanSharedTitle, extractSharedUrl } from './share-url';

describe('extractSharedUrl', () => {
  it('prefers the url param', () => {
    expect(
      extractSharedUrl({
        url: 'https://amazon.com/dp/B0X',
        text: 'https://other.example/should-not-win',
      }),
    ).toBe('https://amazon.com/dp/B0X');
  });

  it('falls back to the first link inside text (Amazon-app style share)', () => {
    expect(
      extractSharedUrl({
        text: 'Check out Widget Pro on Amazon! https://a.co/d/abc123 #ad',
      }),
    ).toBe('https://a.co/d/abc123');
  });

  it('falls back to a link in title last', () => {
    expect(extractSharedUrl({ title: 'https://newegg.com/p/N82E1' })).toBe(
      'https://newegg.com/p/N82E1',
    );
  });

  it('trims trailing punctuation captured from prose', () => {
    expect(extractSharedUrl({ text: 'look: https://walmart.com/ip/123!' })).toBe(
      'https://walmart.com/ip/123',
    );
  });

  it('returns null when nothing shareable is present', () => {
    expect(extractSharedUrl({ title: 'Just some words', text: 'no links here' })).toBeNull();
    expect(extractSharedUrl({})).toBeNull();
  });

  it('ignores non-http schemes', () => {
    expect(extractSharedUrl({ text: 'ftp://example.com/file' })).toBeNull();
  });
});

describe('cleanSharedTitle', () => {
  it('strips the Amazon.com: prefix', () => {
    expect(cleanSharedTitle('Amazon.com: Widget Pro 3000')).toBe('Widget Pro 3000');
  });

  it('strips a trailing pipe-delimited retailer', () => {
    expect(cleanSharedTitle('Widget Pro 3000 | Best Buy')).toBe('Widget Pro 3000');
  });

  it('strips a trailing " - store.com" suffix but keeps hyphenated product names', () => {
    expect(cleanSharedTitle('Widget Pro - Walmart.com')).toBe('Widget Pro');
    expect(cleanSharedTitle('Cast Iron Skillet - 12 inch')).toBe('Cast Iron Skillet - 12 inch');
  });

  it('returns empty for URL-only titles and null input', () => {
    expect(cleanSharedTitle('https://amazon.com/dp/B0X')).toBe('');
    expect(cleanSharedTitle(null)).toBe('');
  });
});
