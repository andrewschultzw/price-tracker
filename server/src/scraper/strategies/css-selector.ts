import { chromium } from 'playwright';
import { createContext } from '../browser.js';
import { parsePrice } from '../extractor.js';
import { logger } from '../../logger.js';

/**
 * Extract price using a user-provided CSS selector.
 * This re-fetches the page with Playwright to use real DOM querying.
 */
export async function extractWithCssSelector(url: string, selector: string): Promise<number | null> {
  const context = await createContext();
  try {
    const page = await context.newPage();

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const element = await page.$(selector);
    if (!element) return null;

    const text = await element.textContent();
    if (!text) return null;

    return parsePrice(text);
  } catch (err) {
    logger.error({ err, url, selector }, 'CSS selector extraction failed');
    return null;
  } finally {
    await context.close();
  }
}
