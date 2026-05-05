import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendDiscordBasketAlert } from './discord.js';
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
      per_item_ceiling: null, position: 0, ai_verdict_tier: 'BUY', ai_verdict_reason: null },
    { tracker_id: 2, tracker_name: 'CPU', last_price: 50, tracker_status: 'active',
      per_item_ceiling: null, position: 1, ai_verdict_tier: 'BUY', ai_verdict_reason: null },
  ];
}
function mockFetch(status = 204) {
  const fn = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, text: async () => '' });
  // @ts-expect-error overriding global for tests
  globalThis.fetch = fn;
  return fn;
}

describe('sendDiscordBasketAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders title + total/target/savings + member list', async () => {
    const fetchSpy = mockFetch();
    const ok = await sendDiscordBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://example/wh');
    expect(ok).toBe(true);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    const embed = body.embeds[0];
    expect(embed.title).toBe('Bundle Ready: NAS Build');
    expect(embed.description).toContain('SSD');
    expect(embed.description).toContain('CPU');
    const fieldByName = (n: string) => embed.fields.find((f: { name: string }) => f.name === n)?.value;
    expect(fieldByName('Total')).toBe('$80.00');
    expect(fieldByName('Target')).toBe('$100.00');
    expect(fieldByName('Savings')).toBe('$20.00');
    expect(fieldByName('Items')).toBe('2');
  });

  it('omits aiCommentary when null', async () => {
    const fetchSpy = mockFetch();
    await sendDiscordBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://example/wh', null);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.embeds[0].description).not.toContain('great deal');
  });

  it('appends aiCommentary when provided', async () => {
    const fetchSpy = mockFetch();
    await sendDiscordBasketAlert(makeProject(), makeBasket(), makeMembers(), 'https://example/wh', 'All 4 components at 30-day low.');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.embeds[0].description).toContain('All 4 components at 30-day low.');
  });

  it('returns false when basket.total is null', async () => {
    const basket = { ...makeBasket(), total: null };
    const ok = await sendDiscordBasketAlert(makeProject(), basket, makeMembers(), 'https://example/wh');
    expect(ok).toBe(false);
  });
});
