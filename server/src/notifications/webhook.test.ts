import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendGenericPriceAlert } from './webhook.js';
import type { Tracker } from '../db/queries.js';

function makeTracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 1, name: 'Test', url: 'https://example.com/p', threshold_price: 50,
    check_interval_minutes: 60, css_selector: null, last_price: 45,
    last_checked_at: '2026-04-08 12:00:00', last_error: null,
    consecutive_failures: 0, status: 'active',
    created_at: '2026-04-01 00:00:00', updated_at: '2026-04-08 12:00:00',
    user_id: 1, ...overrides,
  } as Tracker;
}

function mockFetch(status = 200, body = '') {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300, status, text: async () => body,
  });
  // @ts-expect-error overriding global for tests
  globalThis.fetch = fn;
  return fn;
}

describe('sendGenericPriceAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('omits ai_commentary when null', async () => {
    const fetchSpy = mockFetch();
    await sendGenericPriceAlert(makeTracker(), 30, 'https://hooks.example/x', null);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.ai_commentary).toBeNull();
  });

  it('includes ai_commentary in JSON when provided', async () => {
    const fetchSpy = mockFetch();
    await sendGenericPriceAlert(makeTracker(), 30, 'https://hooks.example/x', '12-month low.');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.ai_commentary).toBe('12-month low.');
  });
});
