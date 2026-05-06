import { describe, it, expect } from 'vitest';
import { listTrackers } from './api.js';

// Indirect tests of the shape validators via listTrackers + a stubbed fetch.
// getStoredToken reads chrome.storage.local.get; we stub that minimally.

function stubChromeStorage(token: string | null) {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async () => (token ? { apiToken: token } : {}),
      },
    },
  };
}

function stubFetch(body: unknown) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

describe('listTrackers — response shape validation', () => {
  it('throws when response is missing a required field', async () => {
    stubChromeStorage('pt_x');
    const restore = stubFetch([{ id: 1, name: 'X' }]); // missing other fields
    try {
      await expect(listTrackers()).rejects.toMatchObject({
        code: 'UNKNOWN',
        detail: expect.stringMatching(/missing field/) as unknown as string,
      });
    } finally {
      restore();
    }
  });

  it('throws when response is not an array', async () => {
    stubChromeStorage('pt_x');
    const restore = stubFetch({ id: 1, name: 'X' });
    try {
      await expect(listTrackers()).rejects.toMatchObject({
        code: 'UNKNOWN',
        detail: expect.stringMatching(/not an array/) as unknown as string,
      });
    } finally {
      restore();
    }
  });

  it('passes through a fully-shaped tracker list', async () => {
    stubChromeStorage('pt_x');
    const restore = stubFetch([{
      id: 1, name: 'X', url: 'https://x', normalized_url: 'x',
      threshold_price: null, check_interval_minutes: 360, last_price: 99,
      ai_verdict_tier: null, ai_verdict_reason: null,
    }]);
    try {
      const result = await listTrackers();
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(1);
    } finally {
      restore();
    }
  });
});
