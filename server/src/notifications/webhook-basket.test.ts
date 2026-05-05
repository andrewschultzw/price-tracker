import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendGenericBasketAlert } from './webhook.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

function makeProject(): Project { return { id: 1, user_id: 1, name: 'NAS', target_total: 100,
  status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05' }; }
function makeBasket(): BasketState { return { total: 80, target_total: 100, item_count: 2,
  items_with_price: 2, items_below_ceiling: 2, eligible: true, ineligible_reason: null }; }
function makeMembers(): BasketMember[] { return [
  { tracker_id: 1, tracker_name: 'SSD', last_price: 30, tracker_status: 'active',
    per_item_ceiling: null, position: 0, ai_verdict_tier: 'BUY', ai_verdict_reason: null },
]; }
function mockFetch(status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => '' });
  // @ts-expect-error overriding global for tests
  globalThis.fetch = fn;
  return fn;
}

describe('sendGenericBasketAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts JSON with event=bundle_ready + project + basket + members', async () => {
    const fetchSpy = mockFetch();
    const ok = await sendGenericBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://hooks.example/x');
    expect(ok).toBe(true);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.event).toBe('bundle_ready');
    expect(body.project.name).toBe('NAS');
    expect(body.basket.total).toBe(80);
    expect(body.basket.savings).toBe(20);
    expect(body.members[0].tracker_name).toBe('SSD');
    expect(body.members[0].ai_verdict_tier).toBe('BUY');
    expect(body.ai_commentary).toBeNull();
  });

  it('includes ai_commentary in the JSON when provided', async () => {
    const fetchSpy = mockFetch();
    await sendGenericBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://hooks.example/x', 'AI line.');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.ai_commentary).toBe('AI line.');
  });

  it('returns false when basket.total is null', async () => {
    const basket = { ...makeBasket(), total: null };
    const ok = await sendGenericBasketAlert(makeProject(), basket, makeMembers(), 'https://hooks.example/x');
    expect(ok).toBe(false);
  });

  it('returns false for invalid webhook URL', async () => {
    const ok = await sendGenericBasketAlert(makeProject(), makeBasket(), makeMembers(), 'not-a-url');
    expect(ok).toBe(false);
  });
});
