// Parity test: outputs must match server/src/lib/normalize-url.test.ts
// for the same inputs. This is a drift detector.
import { describe, it, expect } from 'vitest';
import { normalizeTrackerUrl } from './normalize-url.js';

describe('normalizeTrackerUrl — parity with server', () => {
  it('canonicalizes amazon variants to amazon.com', () => {
    expect(normalizeTrackerUrl('https://www.amazon.com/dp/B01N5IB20Q'))
      .toBe('amazon.com/dp/b01n5ib20q');
    expect(normalizeTrackerUrl('https://smile.amazon.com/dp/B01N5IB20Q'))
      .toBe('amazon.com/dp/b01n5ib20q');
    expect(normalizeTrackerUrl('https://amazon.co.uk/dp/B01N5IB20Q'))
      .toBe('amazon.com/dp/b01n5ib20q');
  });

  it('strips tracking + utm params, keeps product params', () => {
    expect(normalizeTrackerUrl(
      'https://www.amazon.com/dp/B01?tag=foo&ref=bar&utm_source=z&size=large',
    )).toBe('amazon.com/dp/b01?size=large');
  });

  it('returns null on malformed input', () => {
    expect(normalizeTrackerUrl('not a url')).toBeNull();
    expect(normalizeTrackerUrl('')).toBeNull();
  });

  it('strips trailing slash on path', () => {
    expect(normalizeTrackerUrl('https://newegg.com/p/A/'))
      .toBe('newegg.com/p/a');
  });
});
