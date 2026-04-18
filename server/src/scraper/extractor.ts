import { fetchPageContent } from './browser.js';
import { extractFromJsonLd } from './strategies/jsonld.js';
import { extractFromMicrodata } from './strategies/microdata.js';
import { extractFromOpenGraph } from './strategies/opengraph.js';
import { extractFromCssPatterns, isAmazonCurrentlyUnavailable } from './strategies/css-patterns.js';
import { extractFromRegex } from './strategies/regex.js';
import { extractWithCssSelector } from './strategies/css-selector.js';
import { withRetry, ScrapeError } from './retry.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export interface ExtractionResult {
  price: number;
  currency: string;
  strategy: string;
  finalUrl: string;
}

/**
 * Parse a price string like "$1,234.56" or "1234.56" into a number.
 */
export function parsePrice(text: string): number | null {
  if (!text) return null;
  // Remove everything except digits, dots, and commas
  const cleaned = text.replace(/[^0-9.,]/g, '');
  if (!cleaned) return null;

  // Handle comma as thousands separator: "1,234.56" -> "1234.56"
  // Handle comma as decimal: "1234,56" -> "1234.56" (European)
  let normalized: string;
  if (cleaned.includes(',') && cleaned.includes('.')) {
    // Both present: comma is thousands separator
    normalized = cleaned.replace(/,/g, '');
  } else if (cleaned.includes(',')) {
    // Only comma: could be thousands (1,234) or decimal (12,34)
    const parts = cleaned.split(',');
    if (parts[parts.length - 1].length === 2 && parts.length === 2) {
      // European decimal: 12,34
      normalized = cleaned.replace(',', '.');
    } else {
      // Thousands separator: 1,234
      normalized = cleaned.replace(/,/g, '');
    }
  } else {
    normalized = cleaned;
  }

  const price = parseFloat(normalized);
  if (isNaN(price) || price <= 0) return null;
  return Math.round(price * 100) / 100;
}

/**
 * Extract price from a URL using the pipeline of strategies.
 */
export async function extractPrice(url: string, cssSelector?: string | null): Promise<ExtractionResult> {
  // If user provided a CSS selector, try that first with a separate page load
  if (cssSelector) {
    logger.debug({ url, strategy: 'css-selector' }, 'Trying user CSS selector');
    const price = await extractWithCssSelector(url, cssSelector);
    if (price !== null) {
      return { price, currency: 'USD', strategy: 'css-selector', finalUrl: url };
    }
    logger.debug({ url }, 'User CSS selector failed, falling back to pipeline');
  }

  // Fetch page content with retry/backoff on transient failures. The
  // classifier only retries ScrapeErrors marked retryable (network errors,
  // timeouts, 5xx) plus unknown error types (browser context crashes and
  // similar). Deterministic failures like 4xx fail fast.
  const fetched = await withRetry(
    () => fetchPageContent(url),
    {
      maxRetries: config.scrapeMaxRetries,
      baseDelayMs: config.scrapeRetryBaseMs,
      isRetryable: (err) => (err instanceof ScrapeError ? err.retryable : true),
      onRetry: (err, attempt, delayMs) => {
        logger.warn(
          { url, attempt, delayMs, err: err instanceof Error ? err.message : String(err) },
          'Retrying scrape after transient failure',
        );
      },
    },
  );
  const { html, finalUrl } = fetched;

  // Short-circuit on Amazon "Currently unavailable" pages. Without this,
  // the strategy pipeline falls through to page-wide regex/css fallbacks
  // that grab a sponsored-carousel price and report it as the product
  // price (the JetKVM regression: reported $35.99 for an unavailable
  // product because the first `.a-offscreen` on the page was an
  // accessory). Non-retryable because the page state is deterministic
  // — retrying won't un-unavailable the product.
  if (isAmazonCurrentlyUnavailable(html)) {
    logger.info({ url }, 'Amazon lists product as Currently unavailable');
    throw new ScrapeError('Product is currently unavailable on Amazon', false);
  }

  const strategies: { name: string; fn: () => number | null }[] = [
    { name: 'json-ld', fn: () => extractFromJsonLd(html) },
    { name: 'microdata', fn: () => extractFromMicrodata(html) },
    { name: 'opengraph', fn: () => extractFromOpenGraph(html) },
    { name: 'css-patterns', fn: () => extractFromCssPatterns(html) },
    { name: 'regex', fn: () => extractFromRegex(html) },
  ];

  for (const { name, fn } of strategies) {
    logger.debug({ url, strategy: name }, 'Trying extraction strategy');
    const price = fn();
    if (price !== null) {
      logger.info({ url, strategy: name, price }, 'Price extracted');
      // Sanity check: reject obviously wrong prices
      if (price < 0.01 || price > 999999) {
        logger.warn({ url, strategy: name, price }, 'Price outside sanity range, skipping');
        continue;
      }
      return { price, currency: 'USD', strategy: name, finalUrl };
    }
  }

  throw new Error(`Could not extract price from ${url}`);
}
