import { describe, it, expect, vi, beforeEach } from 'vitest';
import { purchaseArmContent } from './purchase-arm.js';
import { sendGenericPurchaseArm } from './webhook.js';

describe('purchaseArmContent', () => {
  it('builds title + body with price, threshold, and buy link', () => {
    const { title, body } = purchaseArmContent('LG 27" Monitor', 219.99, 250, 'https://prices.example/buy/tok');
    expect(title).toContain('LG 27" Monitor');
    expect(body).toContain('$219.99');
    expect(body).toContain('$250.00');
    expect(body).toContain('https://prices.example/buy/tok');
  });
});

describe('sendGenericPurchaseArm — payload shape', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs event=purchase_arm with buy_url and price to the webhook URL', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    // @ts-expect-error overriding global for tests
    globalThis.fetch = fetchSpy;

    const { body: canonicalBody } = purchaseArmContent('Gaming Chair', 179.99, 200, 'https://prices.example/buy/abc123');
    const result = await sendGenericPurchaseArm(
      'Gaming Chair', 179.99, 200, 'https://prices.example/buy/abc123',
      'https://hooks.example/purchase', canonicalBody,
    );

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.example/purchase');
    const payload = JSON.parse(init.body as string);
    expect(payload.event).toBe('purchase_arm');
    expect(payload.buy_url).toBe('https://prices.example/buy/abc123');
    expect(payload.price).toBe(179.99);
    expect(payload.threshold).toBe(200);
    expect(payload.tracker).toBe('Gaming Chair');
    expect(payload.body).toContain('$179.99');
  });

  it('returns false and does not throw when the webhook returns a non-2xx status', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });
    // @ts-expect-error overriding global for tests
    globalThis.fetch = fetchSpy;

    const result = await sendGenericPurchaseArm(
      'Gaming Chair', 179.99, 200, 'https://prices.example/buy/abc123',
      'https://hooks.example/purchase', 'body text',
    );
    expect(result).toBe(false);
  });
});
