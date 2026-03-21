import { chromium, Browser, BrowserContext } from 'playwright';
import { getNextUserAgent } from './user-agents.js';
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

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

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
