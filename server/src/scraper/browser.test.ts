import { describe, it, expect, vi, afterEach } from 'vitest';
import { withTimeout, TimeoutError } from './browser.js';

describe('withTimeout', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, 'x')).resolves.toBe('ok');
  });

  it('propagates the underlying rejection when the promise rejects first', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'x')).rejects.toThrow('boom');
  });

  it('rejects with TimeoutError when the promise exceeds the deadline', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {}); // never settles
    const p = withTimeout(never, 5000, 'scrape');
    const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('TimeoutError message includes the label and duration', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<void>(() => {}), 250, 'context.close');
    const assertion = expect(p).rejects.toThrow('context.close timed out after 250ms');
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });
});
