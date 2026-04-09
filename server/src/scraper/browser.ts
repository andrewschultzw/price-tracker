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

    const html = await page.content();

    // Bot-check / captcha detection. Amazon (and some other retailers)
    // occasionally serve an intercept page instead of the real product
    // page — the HTML parses fine but contains no real price data, so
    // every extraction strategy returns null and the caller sees a
    // confusing "Could not extract price" error. Detecting the intercept
    // here and throwing a retryable ScrapeError lets the retry loop in
    // extractPrice() take another pass (usually with a different user
    // agent, since the context is recreated per attempt), which
    // frequently clears the intercept.
    if (isBotCheckPage(html, response?.url() ?? url)) {
      throw new ScrapeError(`Bot check / captcha page detected for ${url}`, true);
    }

    return html;
  } finally {
    await context.close();
  }
}

/**
 * Heuristic bot-check detection. Tuned to minimize false positives: we
 * only flag pages whose title OR final URL strongly suggests an intercept,
 * not anything that merely contains the word "robot" somewhere in product
 * copy. The final URL check catches Amazon's /errors/validateCaptcha
 * redirects even when the rendered page body looks normal.
 */
function isBotCheckPage(html: string, finalUrl: string): boolean {
  // URL-based signals are the most reliable
  if (/\/errors\/validateCaptcha/i.test(finalUrl)) return true;
  if (/\/ap\/cvf\/request/i.test(finalUrl)) return true;

  // Title-based signals. Amazon's bot-check title is literally
  // "Amazon.com" with a short body like "Enter the characters you see
  // below". Extract the title and check for known intercept phrases.
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';
  if (/robot check/i.test(title)) return true;
  if (/sorry,?\s*we just need to make sure/i.test(html.slice(0, 5000))) return true;
  if (/enter the characters you see below/i.test(html.slice(0, 5000))) return true;
  if (/to discuss automated access to amazon data/i.test(html.slice(0, 10000))) return true;

  // Suspiciously short HTML (under ~3KB) from a known retailer domain is
  // almost always a bot intercept or error page, not a real product listing.
  try {
    const host = new URL(finalUrl).hostname;
    if (/(amazon|walmart|target|bestbuy|newegg)\./i.test(host) && html.length < 3000) {
      return true;
    }
  } catch {
    // invalid URL, don't block on it
  }

  return false;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
    logger.info('Browser closed');
  }
}
