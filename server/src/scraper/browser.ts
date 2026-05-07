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
        // Some retailers (notably Best Buy) trigger ERR_HTTP2_PROTOCOL_ERROR
        // with Chromium's HTTP/2 implementation. Forcing HTTP/1.1 sidesteps
        // it cleanly. We abort images/fonts/CSS anyway, so the parallelism
        // benefit of HTTP/2 is negligible for scrape workloads.
        '--disable-http2',
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

export interface FetchResult {
  html: string;
  finalUrl: string;
}

/**
 * Load a URL and return the rendered HTML and final URL (after redirects).
 * Throws a ScrapeError on failure:
 *   - Network errors / timeouts → retryable
 *   - HTTP 5xx                  → retryable
 *   - HTTP 4xx                  → NOT retryable (deterministic)
 *
 * Callers should wrap this in `withRetry()` to actually take advantage of
 * the retryable flag.
 */
export async function fetchPageContent(url: string): Promise<FetchResult> {
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
      // Use 'commit' (just first-byte received) instead of 'domcontentloaded'.
      // Some retailers (notably Best Buy) keep the network busy with bot-detection
      // and analytics scripts well past the actual content load, so domcontentloaded
      // never fires within any reasonable timeout. Price data comes from server-
      // rendered JSON-LD which lands in the initial HTML, so we don't need
      // domcontentloaded — just the response. The post-goto wait below gives
      // dynamic content a chance to render for sites that need it.
      response = await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
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

    // Wait for JS to render prices. 5s is enough for any retailer to populate
    // dynamic content on top of the server-rendered HTML; longer would dilute
    // happy-path scrape throughput. 'commit' navigation gets us here within
    // ~1s for slow sites, so total page time is bounded at ~6s in practice.
    await page.waitForTimeout(5000);

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
    return { html, finalUrl: response?.url() ?? url };
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
export function isBotCheckPage(html: string, finalUrl: string): boolean {
  // URL-based signals are the most reliable
  if (/\/errors\/validateCaptcha/i.test(finalUrl)) return true;
  if (/\/ap\/cvf\/request/i.test(finalUrl)) return true;

  // Title-based signals. Amazon's bot-check title is literally
  // "Amazon.com" with a short body like "Enter the characters you see
  // below". Extract the title and check for known intercept phrases.
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';
  if (/robot check/i.test(title)) return true;
  // Walmart's press-and-hold / PerimeterX intercept renders a title of
  // exactly "Robot or human?". Confirmed via canary sweep 2026-04-18 —
  // see server/src/scraper/strategies/__fixtures__/walmart-bot-check.html.
  if (/^\s*robot or human\??\s*$/i.test(title)) return true;
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
