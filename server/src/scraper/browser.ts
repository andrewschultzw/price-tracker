import { chromium, Browser, BrowserContext } from 'playwright';
import { getNextUserAgent } from './user-agents.js';
import { ScrapeError } from './retry.js';
import { logger } from '../logger.js';

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    logger.info('Launching Playwright browser');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });
  }
  return browser;
}

export async function createContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  return b.newContext({
    userAgent: getNextUserAgent(),
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });
}

/**
 * Load a URL and return the rendered HTML. Throws a ScrapeError on failure:
 *   - Network errors / timeouts → retryable
 *   - HTTP 5xx                  → retryable
 *   - HTTP 4xx                  → NOT retryable (deterministic)
 *
 * Callers should wrap this in `withRetry()` to actually take advantage of
 * the retryable flag.
 */
export async function fetchPageContent(url: string): Promise<string> {
  const context = await createContext();
  try {
    const page = await context.newPage();

    // Block unnecessary resources for speed
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
      // Playwright throws on network errors, DNS failures, and timeouts.
      // These are transient — classify as retryable.
      const msg = err instanceof Error ? err.message : String(err);
      throw new ScrapeError(`Failed to load ${url}: ${msg}`, true);
    }

    if (response) {
      const status = response.status();
      if (status >= 400 && status < 500) {
        // Client errors (404, 403, 410, etc.) are deterministic — the page
        // isn't coming back just because we asked again.
        throw new ScrapeError(`HTTP ${status} from ${url}`, false, status);
      }
      if (status >= 500) {
        // Server errors may clear up — retry.
        throw new ScrapeError(`HTTP ${status} from ${url}`, true, status);
      }
    }

    // Wait a bit for JS to render prices
    await page.waitForTimeout(2000);

    return await page.content();
  } finally {
    await context.close();
  }
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('Browser closed');
  }
}
