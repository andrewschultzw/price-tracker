import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendNtfyBasketAlert } from './ntfy.js';
import type { Project, BasketState, BasketMember } from '../projects/types.js';

function makeProject(): Project {
  return { id: 1, user_id: 1, name: 'NAS Build', target_total: 100,
    status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05' };
}
function makeBasket(): BasketState {
  return { total: 80, target_total: 100, item_count: 2,
    items_with_price: 2, items_below_ceiling: 2, eligible: true, ineligible_reason: null };
}
function makeMembers(): BasketMember[] {
  return [
    { tracker_id: 1, tracker_name: 'SSD', last_price: 30, tracker_status: 'active',
      per_item_ceiling: null, position: 0, ai_verdict_tier: null, ai_verdict_reason: null },
    { tracker_id: 2, tracker_name: 'CPU', last_price: 50, tracker_status: 'active',
      per_item_ceiling: null, position: 1, ai_verdict_tier: null, ai_verdict_reason: null },
  ];
}
function mockFetch(status = 200) {
  const fn = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => '' });
  // @ts-expect-error overriding global for tests
  globalThis.fetch = fn;
  return fn;
}

describe('sendNtfyBasketAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders body with totals + members', async () => {
    const fetchSpy = mockFetch();
    const ok = await sendNtfyBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://ntfy.example/topic');
    expect(ok).toBe(true);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.message).toContain('$80.00');
    expect(body.message).toContain('SSD');
    expect(body.message).toContain('CPU');
    expect(body.title).toBe('Bundle Ready: NAS Build');
  });

  it('appends aiCommentary when provided', async () => {
    const fetchSpy = mockFetch();
    await sendNtfyBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://ntfy.example/topic', undefined, 'Worth pulling the trigger.');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.message).toContain('Worth pulling the trigger.');
  });

  it('renders without aiCommentary when null', async () => {
    const fetchSpy = mockFetch();
    await sendNtfyBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://ntfy.example/topic', undefined, null);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.message).not.toContain('Worth pulling');
  });

  it('returns false when basket.total is null', async () => {
    const basket = { ...makeBasket(), total: null };
    const ok = await sendNtfyBasketAlert(makeProject(), basket, makeMembers(), 'https://ntfy.example/topic');
    expect(ok).toBe(false);
  });

  it('returns false when ntfy URL is invalid', async () => {
    const ok = await sendNtfyBasketAlert(makeProject(), makeBasket(), makeMembers(), 'not-a-url');
    expect(ok).toBe(false);
  });
});
