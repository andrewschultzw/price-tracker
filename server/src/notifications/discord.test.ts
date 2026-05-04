import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendDiscordPriceAlert, sendDiscordErrorAlert, testDiscordWebhook } from './discord.js';
import type { Tracker } from '../db/queries.js';

function makeTracker(overrides: Partial<Tracker> = {}): Tracker {
  return {
    id: 1,
    name: 'Test Product',
    url: 'https://example.com/product',
    threshold_price: 50,
    check_interval_minutes: 60,
    css_selector: null,
    last_price: 45,
    last_checked_at: '2026-04-08 12:00:00',
    last_error: null,
    consecutive_failures: 0,
    status: 'active',
    created_at: '2026-04-01 00:00:00',
    updated_at: '2026-04-08 12:00:00',
    user_id: 1,
    ...overrides,
  } as Tracker;
}

function mockFetch(status = 204, body = ''): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
  // @ts-expect-error — overwriting the global for the test
  globalThis.fetch = fn;
  return fn;
}

describe('sendDiscordPriceAlert', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs a Discord embed with price, threshold, and savings', async () => {
    const fetchMock = mockFetch();
    const tracker = makeTracker({ threshold_price: 60, name: 'Widget' });

    const ok = await sendDiscordPriceAlert(tracker, 45, 'https://discord.com/api/webhooks/abc');

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/webhooks/abc');
    expect(options.method).toBe('POST');

    const body = JSON.parse(options.body as string);
    expect(body.embeds).toHaveLength(1);
    const embed = body.embeds[0];
    expect(embed.title).toBe('Price Drop Alert: Widget');
    expect(embed.url).toBe('https://example.com/product');

    // Fields: Current Price, Threshold, Savings
    const fieldsByName = Object.fromEntries(
      (embed.fields as { name: string; value: string }[]).map(f => [f.name, f.value]),
    );
    expect(fieldsByName['Current Price']).toBe('$45.00');
    expect(fieldsByName['Threshold']).toBe('$60.00');
    expect(fieldsByName['Savings']).toBe('$15.00');
  });

  it('returns false when tracker has no threshold', async () => {
    const fetchMock = mockFetch();
    const tracker = makeTracker({ threshold_price: null });

    const ok = await sendDiscordPriceAlert(tracker, 45, 'https://discord.com/api/webhooks/abc');

    expect(ok).toBe(false);
    // Must not even attempt the HTTP call
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when Discord returns a non-2xx', async () => {
    mockFetch(400, 'Bad Request');
    const ok = await sendDiscordPriceAlert(makeTracker(), 45, 'https://discord.com/api/webhooks/bad');
    expect(ok).toBe(false);
  });

  it('returns false when the fetch itself throws', async () => {
    // @ts-expect-error — overwriting the global for the test
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const ok = await sendDiscordPriceAlert(makeTracker(), 45, 'https://discord.com/api/webhooks/x');
    expect(ok).toBe(false);
  });

  it('renders without ai_commentary when aiCommentary is null', async () => {
    const fetchSpy = mockFetch();
    await sendDiscordPriceAlert(makeTracker(), 30, 'https://example/wh', null);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(JSON.stringify(body)).not.toContain('ai_commentary');
    expect(body.embeds[0].description).toBeUndefined();
  });

  it('appends aiCommentary to embed description when provided', async () => {
    const fetchSpy = mockFetch();
    await sendDiscordPriceAlert(makeTracker(), 30, 'https://example/wh', '12-month low.');
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(JSON.stringify(body)).toContain('12-month low.');
    expect(body.embeds[0].description).toBe('12-month low.');
  });
});

describe('sendDiscordErrorAlert', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs a Discord embed containing the error text', async () => {
    const fetchMock = mockFetch();
    const tracker = makeTracker({ consecutive_failures: 3, name: 'Broken Link' });

    const ok = await sendDiscordErrorAlert(tracker, 'ECONNRESET', 'https://discord.com/api/webhooks/abc');

    expect(ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const embed = body.embeds[0];
    expect(embed.title).toBe('Tracker Error: Broken Link');
    expect(embed.description).toContain('3 consecutive');
    const errorField = (embed.fields as { name: string; value: string }[]).find(f => f.name === 'Error');
    expect(errorField?.value).toBe('ECONNRESET');
  });

  it('truncates long error messages at 1024 chars', async () => {
    const fetchMock = mockFetch();
    const longError = 'x'.repeat(2000);
    await sendDiscordErrorAlert(makeTracker(), longError, 'https://discord.com/api/webhooks/abc');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const errorField = (body.embeds[0].fields as { name: string; value: string }[]).find(f => f.name === 'Error');
    expect(errorField!.value.length).toBe(1024);
  });
});

describe('testDiscordWebhook', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns ok:true on 2xx', async () => {
    mockFetch(204);
    const result = await testDiscordWebhook('https://discord.com/api/webhooks/abc');
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns ok:false with an error message on non-2xx', async () => {
    mockFetch(404, 'Unknown Webhook');
    const result = await testDiscordWebhook('https://discord.com/api/webhooks/abc');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
    expect(result.error).toContain('Unknown Webhook');
  });

  it('returns ok:false with the thrown error message when fetch throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as typeof globalThis.fetch;
    const result = await testDiscordWebhook('https://discord.com/api/webhooks/abc');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });
});
