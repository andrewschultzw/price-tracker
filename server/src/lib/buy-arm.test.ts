import { describe, it, expect } from 'vitest';
import { buildAmazonCartUrl } from './buy-arm.js';

describe('buildAmazonCartUrl', () => {
  it('builds an add-to-cart URL with ASIN and quantity', () => {
    const url = buildAmazonCartUrl('B07XYZ1234', 1, '');
    expect(url).toBe(
      'https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B07XYZ1234&Quantity.1=1',
    );
  });

  it('appends the affiliate tag when configured', () => {
    const url = buildAmazonCartUrl('B07XYZ1234', 2, 'schultzsoluti-20');
    expect(url).toBe(
      'https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B07XYZ1234&Quantity.1=2&AssociateTag=schultzsoluti-20',
    );
  });

  it('clamps quantity to a minimum of 1', () => {
    const url = buildAmazonCartUrl('B07XYZ1234', 0, '');
    expect(url).toContain('Quantity.1=1');
  });
});
