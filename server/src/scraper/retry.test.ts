import { describe, it, expect, vi } from 'vitest';
import { withRetry, ScrapeError } from './retry.js';

// Stub sleep so tests run instantly instead of waiting for real backoffs.
const instantSleep = () => Promise.resolve();

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 10,
      isRetryable: () => true,
      sleep: instantSleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on second attempt', async () => {
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new ScrapeError('blip', true);
      return 'ok';
    });
    const result = await withRetry(fn, {
      maxRetries: 2,
      baseDelayMs: 10,
      isRetryable: err => err instanceof ScrapeError ? err.retryable : true,
      sleep: instantSleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on deterministic (non-retryable) failure', async () => {
    const fn = vi.fn().mockRejectedValue(new ScrapeError('HTTP 404', false, 404));
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 10,
        isRetryable: err => err instanceof ScrapeError ? err.retryable : true,
        sleep: instantSleep,
      }),
    ).rejects.toMatchObject({ name: 'ScrapeError', httpStatus: 404 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries up to maxRetries + 1 times then re-throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(new ScrapeError('still failing', true));
    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 10,
        isRetryable: () => true,
        sleep: instantSleep,
      }),
    ).rejects.toMatchObject({ message: 'still failing' });
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('calls onRetry with attempt number and delay before each retry', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(new ScrapeError('blip', true));
    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 1000,
        isRetryable: () => true,
        onRetry,
        sleep: instantSleep,
      }),
    ).rejects.toBeDefined();

    expect(onRetry).toHaveBeenCalledTimes(2);
    // First retry: attempt=1, delay=1000ms (base * 3^0)
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.any(Error), 1, 1000);
    // Second retry: attempt=2, delay=3000ms (base * 3^1)
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.any(Error), 2, 3000);
  });

  it('uses exponential backoff with base*3^n', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => { delays.push(ms); };
    const fn = vi.fn().mockRejectedValue(new ScrapeError('blip', true));
    await expect(
      withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 500,
        isRetryable: () => true,
        sleep,
      }),
    ).rejects.toBeDefined();
    // 3 retries → 3 sleeps at 500, 1500, 4500
    expect(delays).toEqual([500, 1500, 4500]);
  });

  it('does not sleep after the final attempt', async () => {
    const sleepSpy = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new ScrapeError('blip', true));
    await expect(
      withRetry(fn, {
        maxRetries: 2,
        baseDelayMs: 10,
        isRetryable: () => true,
        sleep: sleepSpy,
      }),
    ).rejects.toBeDefined();
    // 2 retries → 2 sleeps (not 3)
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  it('treats unknown error types as retryable if the classifier says so', async () => {
    // Real-world case: Playwright throws generic Error on browser context
    // crashes. The default classifier we use in extractPrice treats these
    // as retryable for safety.
    let calls = 0;
    const fn = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls < 3) throw new Error('browser context crashed');
      return 'ok';
    });
    const result = await withRetry(fn, {
      maxRetries: 3,
      baseDelayMs: 10,
      isRetryable: err => (err instanceof ScrapeError ? err.retryable : true),
      sleep: instantSleep,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('maxRetries=0 means exactly one attempt', async () => {
    const fn = vi.fn().mockRejectedValue(new ScrapeError('nope', true));
    await expect(
      withRetry(fn, {
        maxRetries: 0,
        baseDelayMs: 10,
        isRetryable: () => true,
        sleep: instantSleep,
      }),
    ).rejects.toBeDefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('ScrapeError', () => {
  it('carries retryable flag and optional httpStatus', () => {
    const err = new ScrapeError('boom', true, 503);
    expect(err.message).toBe('boom');
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(503);
    expect(err.name).toBe('ScrapeError');
  });

  it('httpStatus is optional', () => {
    const err = new ScrapeError('network blip', true);
    expect(err.httpStatus).toBeUndefined();
  });
});
