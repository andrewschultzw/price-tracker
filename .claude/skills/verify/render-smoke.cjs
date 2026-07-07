#!/usr/bin/env node
// Render smoke: load a URL in headless chromium (the repo's own playwright,
// which CAN reach localhost — unlike the sandboxed Playwright MCP browser),
// fail on any console error or pageerror, save a screenshot for human eyes.
//
// Runnable from anywhere in the repo:
//   node .claude/skills/verify/render-smoke.cjs <url> [screenshot.png]
const { createRequire } = require('module');
const path = require('path');
// playwright lives in the server workspace; resolve from there, not from cwd
const serverRequire = createRequire(path.join(__dirname, '..', '..', '..', 'server', 'package.json'));
const { chromium } = serverRequire('playwright');

const [url, shot] = process.argv.slice(2);
if (!url) {
  console.error('usage: render-smoke.cjs <url> [screenshot.png]');
  process.exit(2);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // let the loading→loaded transition happen — that's where hooks-order bugs live
  await page.waitForTimeout(1000);
  if (shot) await page.screenshot({ path: shot, fullPage: true });
  await browser.close();
  if (errors.length) {
    console.error(`RENDER SMOKE FAILED (${errors.length} error${errors.length > 1 ? 's' : ''}):`);
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`render smoke OK: ${url}${shot ? ` — screenshot: ${shot}` : ''} (0 console errors)`);
})().catch((e) => {
  console.error('RENDER SMOKE FAILED:', e.message);
  process.exit(1);
});
