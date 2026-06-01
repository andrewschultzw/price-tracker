import { describe, it, expect } from 'vitest';
import { buildAmazonBuyUrl } from './buy-arm.js';

describe('buildAmazonBuyUrl', () => {
  it('builds a /dp/ product URL without a tag', () => {
    expect(buildAmazonBuyUrl('B07XYZ1234', '')).toBe('https://www.amazon.com/dp/B07XYZ1234');
  });
  it('appends the affiliate tag', () => {
    expect(buildAmazonBuyUrl('B07XYZ1234', 'schultzsoluti-20'))
      .toBe('https://www.amazon.com/dp/B07XYZ1234?tag=schultzsoluti-20');
  });
  it('trims a whitespace-only tag to no tag', () => {
    expect(buildAmazonBuyUrl('B07XYZ1234', '   ')).toBe('https://www.amazon.com/dp/B07XYZ1234');
  });
});
