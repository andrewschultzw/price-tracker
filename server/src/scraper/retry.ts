/**
 * Generic retry helper with exponential backoff, plus a structured error
 * class the scrape pipeline uses to signal whether a failure is worth
 * retrying.
 *
 * Design rationale:
 *  - Transient failures (network blips, 5xx, timeouts) should retry so one
 *    bad minute doesn't trip the consecutive_failures counter.
 *  - Deterministic failures (4xx, page-shape mismatches, CAPTCHAs) should
 *    fail fast — retrying wastes time and doesn't change the outcome.
 *  - The classifier (`isRetryable`) is injectable so tests can drive
 *    different scenarios without mocking the clock or Playwright.
 *  - `sleep` is injectable so tests run instantly instead of waiting for
 *    real delays.
 */

export class ScrapeError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'ScrapeError';
  }
}

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  isRetryable: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Run `fn` up to `maxRetries + 1` times with exponential backoff (base,
 * base*3, base*9, ...). Stops immediately on any non-retryable error.
 * Returns the successful result, or re-throws the last error if every
 * attempt failed.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const maxAttempts = opts.maxRetries + 1;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Final attempt — no more retries regardless of classification
      if (attempt === maxAttempts - 1) break;

      // Deterministic failure — don't waste time retrying
      if (!opts.isRetryable(err)) break;

      const delayMs = opts.baseDelayMs * Math.pow(3, attempt);
      opts.onRetry?.(err, attempt + 1, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastErr;
}
