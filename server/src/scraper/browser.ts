import { chromium, Browser, BrowserContext } from 'playwright';
import { getNextUserAgent } from './user-agents.js';
import { ScrapeError } from './retry.js';
import { logger } from '../logger.js';

// --- hard timeouts -----------------------------------------------------------
// One wedged page or an unresponsive Chromium must never hang a scrape — or the
// event loop behind it — indefinitely. goto already caps at 30s; these bound
// everything else: the post-goto waits, page.content(), and (the real footgun)
// context/browser teardown, which can block forever on a dead browser. This is
// the failure mode that took price-tracker down: a hung Amazon scrape froze the
// worker, the HTTP server stopped accepting connections, and headless-Chrome
// processes leaked for days.
const SCRAPE_HARD_TIMEOUT_MS = 60_000;
const CONTEXT_CLOSE_TIMEOUT_MS = 10_000;
const BROWSER_CLOSE_TIMEOUT_MS = 10_000;
const PAGE_DEFAULT_TIMEOUT_MS = 20_000;

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a wall-clock deadline. Rejects with TimeoutError if
 * `p` hasn't settled within `ms`; always clears the timer so a settled promise
 * never leaks a pending timeout.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

/** Close a context, bounded — a hung close() must not become the new hang. */
async function closeContextSafely(context: BrowserContext): Promise<void> {
  try {
    await withTimeout(context.close(), CONTEXT_CLOSE_TIMEOUT_MS, 'context.close');
  } catch (err) {
    logger.warn({ err: String(err) }, 'context.close failed/timed out; leaving it for browser recycle');
  }
}

/**
 * Discard the shared browser so the next scrape launches a fresh one. Called
 * after a hard timeout: the Chromium instance may be wedged and leaking pages/
 * processes, so we stop reusing it. The close is itself bounded.
 */
async function recycleBrowser(): Promise<void> {
  const b = browser;
  browser = null;   // swap out first so getBrowser() relaunches a clean instance
  if (!b) return;
  try {
    await withTimeout(b.close(), BROWSER_CLOSE_TIMEOUT_MS, 'browser.close');
    logger.info('Recycled wedged Playwright browser');
  } catch (err) {
    logger.warn({ err: String(err) }, 'browser recycle close failed/timed out; abandoning instance');
  }
}

export interface FetchResult {
  html: string;
  finalUrl: string;
}

/** Navigate + extract on a fresh page. The caller owns the context lifecycle
 * (and the hard timeout that bounds this whole operation). */
async function loadPage(context: BrowserContext, url: string): Promise<FetchResult> {
  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_DEFAULT_TIMEOUT_MS);

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
      // isn't coming back just because we asked again. But a 403 from a
      // known WAF server header means the retailer is blanket-blocking
      // our egress IP, which is a distinct state from "this product page
      // doesn't exist" — surface it specifically so the scheduler can
      // park the seller in 'blocked' status instead of treating it as
      // flaky scrape failures.
      if (isRetailerBlock(status, response.headers())) {
        throw new ScrapeError(
          `Retailer WAF blocked request to ${url} (HTTP ${status})`,
          false,
          status,
          true,
        );
      }
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
}

/**
 * Load a URL and return the rendered HTML and final URL (after redirects).
 * The whole operation is bounded by a hard wall-clock ceiling, and teardown is
 * bounded too, so a wedged page or unresponsive Chromium can never hang the
 * worker (the failure mode that froze the service). A hard timeout surfaces as
 * a retryable ScrapeError and recycles the shared browser.
 *
 * Throws a ScrapeError on failure:
 *   - Network errors / timeouts / hard timeout → retryable
 *   - HTTP 5xx                                 → retryable
 *   - HTTP 4xx                                 → NOT retryable (deterministic)
 *
 * Callers should wrap this in `withRetry()` to actually take advantage of
 * the retryable flag.
 */
export async function fetchPageContent(url: string): Promise<FetchResult> {
  const context = await createContext();
  let hardTimedOut = false;
  try {
    return await withTimeout(loadPage(context, url), SCRAPE_HARD_TIMEOUT_MS, `scrape ${url}`);
  } catch (err) {
    if (err instanceof TimeoutError) {
      hardTimedOut = true;
      throw new ScrapeError(
        `Scrape of ${url} exceeded ${SCRAPE_HARD_TIMEOUT_MS}ms hard timeout`,
        true,
      );
    }
    throw err;
  } finally {
    await closeContextSafely(context);
    // A hard timeout means the page/browser may be wedged — recycle so a
    // poisoned Chromium can't freeze every future scrape.
    if (hardTimedOut) await recycleBrowser();
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

/**
 * Detect a retailer-WAF blanket block based on the response headers.
 * Currently triggered by:
 *  - Akamai Bot Manager (Server: AkamaiGHost on a 4xx) — what Home Depot
 *    and Best Buy use to filter homelab-IP traffic at the edge.
 *  - Cloudflare's bot mitigation (Server: cloudflare + 403). Less precise
 *    on its own because some legitimate Cloudflare-fronted product pages
 *    return 403 for other reasons (e.g., region locks), but in
 *    combination with the status check it's a reasonable proxy.
 *
 * Conservative on purpose: anything we mis-classify as a retailer-block
 * gets a less-useful UX (the seller silently goes to 'blocked' instead
 * of an error alert), so we only flag the patterns we've actually
 * observed in production scrapes.
 */
export function isRetailerBlock(status: number, headers: Record<string, string>): boolean {
  if (status !== 403 && status !== 429) return false;
  const server = (headers['server'] || '').toLowerCase();
  if (server.includes('akamaighost')) return true;
  // Cloudflare's challenge / block page surfaces both `server: cloudflare`
  // and a `cf-mitigated` response header. The latter is the strongest
  // signal we're being filtered by their bot management, not just hitting
  // a generic 403 on a CF-fronted site.
  if (server === 'cloudflare' && headers['cf-mitigated']) return true;
  return false;
}

export async function closeBrowser(): Promise<void> {
  const b = browser;
  browser = null;
  if (!b) return;
  try {
    await withTimeout(b.close(), BROWSER_CLOSE_TIMEOUT_MS, 'browser.close');
    logger.info('Browser closed');
  } catch (err) {
    logger.warn({ err: String(err) }, 'closeBrowser timed out; abandoning instance');
  }
}
