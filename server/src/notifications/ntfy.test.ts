import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendNtfyPriceAlert } from './ntfy.js';
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

describe('sendNtfyPriceAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders without aiCommentary when null', async () => {
    const fetchSpy = mockFetch();
    const ok = await sendNtfyPriceAlert(makeTracker(), 30, 'https://ntfy.example/topic', undefined, null);
    expect(ok).toBe(true);
    const body = fetchSpy.mock.calls[0][1].body as string;
    expect(body).not.toContain('12-month low');
  });

  it('appends aiCommentary to the body when provided', async () => {
    const fetchSpy = mockFetch();
    await sendNtfyPriceAlert(makeTracker(), 30, 'https://ntfy.example/topic', undefined, '12-month low.');
    const body = fetchSpy.mock.calls[0][1].body as string;
    expect(body).toContain('12-month low.');
  });
});
