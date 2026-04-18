/**
 * Canary sweep — local dev tool (not deployed to prod).
 *
 * Runs Playwright against a list of retailer URLs, tries every extraction
 * strategy, reports which ones work / fail, and captures the raw HTML of
 * any URL that fails or looks like a bot-check intercept. Output HTMLs
 * land in `tmp/canary/<host>-<stamp>.html` (gitignored) for post-mortem.
 *
 * Usage:
 *   npm run canary                 # fetch tracker URLs from prod DB via SSH
 *   npm run canary -- --file urls.txt
 *   npm run canary -- --urls https://a.example/x,https://b.example/y
 *
 * Designed to be re-run on demand — no cron integration. The whole point
 * is to catch strategy drift BEFORE it causes silent data quality issues
 * in production (would have caught the Amazon split-price bug ~2 weeks
 * earlier).
 */

import { chromium, Browser } from 'playwright';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { resolve } from 'path';
import { extractFromJsonLd } from '../scraper/strategies/jsonld.js';
import { extractFromMicrodata } from '../scraper/strategies/microdata.js';
import { extractFromOpenGraph } from '../scraper/strategies/opengraph.js';
import { extractFromCssPatterns, isAmazonCurrentlyUnavailable } from '../scraper/strategies/css-patterns.js';
import { extractFromRegex } from '../scraper/strategies/regex.js';
import { isBotCheckPage } from '../scraper/browser.js';

const TMP_DIR = resolve(process.cwd(), 'tmp/canary');
const TIMEOUT_MS = 30000;
const WAIT_AFTER_LOAD_MS = 2000;

interface Outcome {
  url: string;
  finalUrl?: string;
  host: string;
  htmlBytes: number;
  strategies: { name: string; price: number | null }[];
  winner: string | null;
  winnerPrice: number | null;
  classification: 'ok' | 'unavailable' | 'bot_check' | 'no_price' | 'fetch_error';
  note?: string;
  savedFixture?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Delegates to the production `isBotCheckPage` so canary detection
 * stays in lockstep with what the real scraper flags. Returns a short
 * tag so the report explains which signal fired (for the cases we can
 * cheaply re-derive) or just 'bot-check' otherwise.
 */
function detectBotCheck(html: string, finalUrl: string): string | null {
  if (!isBotCheckPage(html, finalUrl)) return null;
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1] : '';
  if (/robot or human/i.test(title)) return 'walmart-perimeterx';
  if (/robot check/i.test(title)) return 'amazon-robot-check';
  if (/\/errors\/validateCaptcha/i.test(finalUrl)) return 'amazon-validateCaptcha';
  return 'bot-check';
}

async function sweepOne(browser: Browser, url: string): Promise<Outcome> {
  const host = hostOf(url);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
    locale: 'en-US',
  });
  try {
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
      return route.continue();
    });

    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS });
    } catch (err) {
      return {
        url, host, htmlBytes: 0, strategies: [], winner: null, winnerPrice: null,
        classification: 'fetch_error', note: err instanceof Error ? err.message : String(err),
      };
    }

    await page.waitForTimeout(WAIT_AFTER_LOAD_MS);
    const html = await page.content();
    const finalUrl = response?.url() ?? url;

    // Run every strategy so drift analysis shows WHICH strategies still work.
    const strategies = [
      { name: 'json-ld', price: extractFromJsonLd(html) },
      { name: 'microdata', price: extractFromMicrodata(html) },
      { name: 'opengraph', price: extractFromOpenGraph(html) },
      { name: 'css-patterns', price: extractFromCssPatterns(html) },
      { name: 'regex', price: extractFromRegex(html) },
    ];
    const winner = strategies.find(s => s.price !== null) ?? null;

    // Classify the outcome.
    const botSig = detectBotCheck(html, finalUrl);
    let classification: Outcome['classification'];
    let note: string | undefined;
    let savedFixture: string | undefined;

    // Use the FINAL URL's host for retailer-specific checks — a.co / amzn.to
    // short links redirect to amazon.com and should still run through the
    // Amazon unavailable detector. Using the input host misses them.
    const finalHost = hostOf(finalUrl);

    if (botSig) {
      classification = 'bot_check';
      note = botSig;
      savedFixture = saveFixture(host, 'botcheck', html);
    } else if (/amazon\./i.test(finalHost) && isAmazonCurrentlyUnavailable(html)) {
      classification = 'unavailable';
    } else if (!winner) {
      classification = 'no_price';
      savedFixture = saveFixture(host, 'no-price', html);
    } else if (winner.price === null || winner.price <= 0 || winner.price > 999999) {
      classification = 'no_price';
      note = `nonsense price ${winner.price}`;
      savedFixture = saveFixture(host, 'bad-price', html);
    } else {
      classification = 'ok';
    }

    return {
      url, finalUrl, host, htmlBytes: html.length, strategies,
      winner: winner?.name ?? null,
      winnerPrice: winner?.price ?? null,
      classification, note, savedFixture,
    };
  } finally {
    await context.close();
  }
}

function saveFixture(host: string, kind: string, html: string): string {
  mkdirSync(TMP_DIR, { recursive: true });
  const path = resolve(TMP_DIR, `${host}-${kind}-${stamp()}.html`);
  writeFileSync(path, html);
  return path;
}

async function loadUrls(): Promise<string[]> {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf('--file');
  const urlsIdx = argv.indexOf('--urls');

  if (fileIdx !== -1) {
    const path = argv[fileIdx + 1];
    const body = readFileSync(path, 'utf-8');
    return body.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  }
  if (urlsIdx !== -1) {
    return argv[urlsIdx + 1].split(',').map(u => u.trim()).filter(Boolean);
  }

  // Default: pull from prod DB via SSH. Requires key-based access set up
  // on CT 300 (the dev container) — see reference_ssh_access memory.
  // Script is base64-encoded because SSH args get re-parsed by the remote
  // shell and multi-line JS with quotes / parens triggers bash syntax
  // errors before node ever sees it.
  const remoteScript = `
    const db = require('/opt/price-tracker/server/node_modules/better-sqlite3')('/opt/price-tracker/data/price-tracker.db', {readonly: true});
    console.log(JSON.stringify(db.prepare("SELECT url FROM tracker_urls WHERE status != 'paused'").all()));
  `;
  const script64 = Buffer.from(remoteScript).toString('base64');
  const raw = execFileSync(
    'ssh',
    ['root@192.168.1.166', `echo ${script64} | base64 -d | node`],
    { encoding: 'utf-8' },
  ).trim();
  const rows = JSON.parse(raw) as { url: string }[];
  return rows.map(r => r.url);
}

function printReport(outcomes: Outcome[]): void {
  const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);

  // eslint-disable-next-line no-console
  console.log('\n=== Canary sweep report ===\n');
  console.log(pad('HOST', 22) + pad('CLASS', 14) + pad('WINNER', 14) + pad('PRICE', 12) + 'NOTE/URL');
  console.log('-'.repeat(120));
  for (const o of outcomes) {
    const note = o.note ?? o.savedFixture ?? o.url.slice(0, 60);
    console.log(
      pad(o.host, 22) +
      pad(o.classification, 14) +
      pad(o.winner ?? '-', 14) +
      pad(o.winnerPrice !== null ? `$${o.winnerPrice.toFixed(2)}` : '-', 12) +
      note,
    );
  }

  // Summary.
  const counts: Record<Outcome['classification'], number> = {
    ok: 0, unavailable: 0, bot_check: 0, no_price: 0, fetch_error: 0,
  };
  for (const o of outcomes) counts[o.classification]++;
  console.log('\n' + JSON.stringify(counts, null, 2));

  // Per-strategy coverage on the ok outcomes.
  const ok = outcomes.filter(o => o.classification === 'ok');
  const byStrategy: Record<string, number> = {};
  for (const o of ok) byStrategy[o.winner!] = (byStrategy[o.winner!] ?? 0) + 1;
  if (ok.length > 0) {
    console.log('\nStrategy usage (ok only):', byStrategy);
  }
}

async function main() {
  const urls = await loadUrls();
  if (urls.length === 0) {
    console.error('No URLs to sweep.');
    process.exit(1);
  }
  console.log(`Sweeping ${urls.length} URL${urls.length !== 1 ? 's' : ''}...\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const outcomes: Outcome[] = [];
    for (const url of urls) {
      process.stdout.write(`  ${hostOf(url)} ...`);
      const o = await sweepOne(browser, url);
      process.stdout.write(` ${o.classification}${o.winner ? ` (${o.winner})` : ''}\n`);
      outcomes.push(o);
    }
    printReport(outcomes);

    const fail = outcomes.some(o => o.classification === 'no_price' || o.classification === 'fetch_error');
    process.exit(fail ? 2 : 0);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
