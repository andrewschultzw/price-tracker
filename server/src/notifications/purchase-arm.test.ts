import { describe, it, expect } from 'vitest';
import { purchaseArmContent } from './purchase-arm.js';

describe('purchaseArmContent', () => {
  it('builds title + body with price, threshold, and buy link', () => {
    const { title, body } = purchaseArmContent('LG 27" Monitor', 219.99, 250, 'https://prices.example/buy/tok');
    expect(title).toContain('LG 27" Monitor');
    expect(body).toContain('$219.99');
    expect(body).toContain('$250.00');
    expect(body).toContain('https://prices.example/buy/tok');
  });
});
