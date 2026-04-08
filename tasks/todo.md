# Price Tracker — Todo

## Current Status
Deployed and live at prices.schultzsolutions.tech (CT 302, 192.168.1.166:3100). GitHub: andrewschultzw/price-tracker (private). DB persists through deploys with automatic backups.

## Done
- [x] Phase 1: Project scaffold, Express server, SQLite schema, CRUD routes
- [x] Phase 2: Playwright browser pool, 6 extraction strategies, price parser
- [x] Phase 3: Scheduler (node-cron + p-queue), Discord webhook notifications
- [x] Phase 4: React + Vite + Tailwind frontend (Dashboard, Add, Detail, Settings)
- [x] Phase 5: CT 302 deploy, systemd service, NPM proxy, SSH key
- [x] UI polish: stat cards, sparklines, favicon, retailer logos, page titles
- [x] DB persistence: deploy.sh excludes data/, rebuild.sh backs up DB before changes
- [x] GitHub repo pushed (private)

## Future
- [ ] OpenClaw integration — Discord bot skill that accepts a product link + threshold, calls the Price Tracker API to create a tracker automatically
- [ ] CAPTCHA/block detection (graceful skip)
- [ ] Test with 10+ real product URLs
- [ ] Proxmox snapshot after confirmed working

## Improvements (from 2026-04-08 review)

### Real problems
- [ ] **Zero test coverage.** CLAUDE.md demands tests and none exist. Set up vitest for both workspaces. Start with: pure-function tests for Dashboard sort/grouping and `canonicalDomain()`; unit tests for price parser and each scrape strategy (`jsonld`, `css-patterns`, `opengraph`, `microdata`, `regex`, `css-selector`); integration tests per notification channel using `nock` or similar to fake HTTP endpoints.
- [ ] **Webhook URLs stored plaintext in sqlite.** `settings` table holds Discord/ntfy/generic webhook URLs as raw strings — these are effectively credentials. Before inviting any less-trusted user: encrypt sensitive settings at rest with an env-provided key, or at minimum redact them in API responses (return `"***configured***"` and require re-entry to change).
- [ ] **Favicon privacy leak.** `TrackerCard` and `CategoryCard` fetch favicons from `www.google.com/s2/favicons`, leaking the full list of tracked retailers to Google on every dashboard load. Fix options: local proxy+cache route (`GET /api/favicon?domain=...`), switch to DuckDuckGo's `icons.duckduckgo.com/ip3/...`, or drop favicons entirely.

### Features
- [ ] **Lowest-ever indicator on TrackerCard.** Show the all-time low next to current price so users can see if the current price is actually a historical deal, not just slightly below an arbitrary threshold. Free with existing `price_history` table — add `SELECT MIN(price)` per tracker to the sparklines endpoint or its own.
- [ ] **Notification history view.** We have three channels + cooldowns tracked in the `notifications` table but no UI to see what got sent. New page showing last N alerts per tracker (channel, timestamp, price). Useful for debugging silent failures and transparency.
- [ ] **CSV/JSON export of price history.** Button on TrackerDetail that dumps full `price_history` to CSV. Trivial build, useful for user analysis and as a migration escape hatch.
- [ ] **Email notification channel.** Fourth channel using the existing Cloudflare+Gmail relay already set up for Paperless (`docs@schultzsolutions.tech`). Most accessible channel for non-technical users — no app install, no webhook setup, just paste an email address.

### Polish
- [ ] **Bundle code-splitting.** Vite is warning about the 632 kB bundle. Split `PriceChart` and the Admin page into dynamic imports — should cut ~150 kB off the initial bundle and help mobile first-load.
- [ ] **Per-channel cooldowns.** Current cooldown is per-tracker, locking all channels together. Only worth doing if someone actually wants mixed-frequency notifications (e.g., ntfy immediately, webhook hourly).

### Worth investigating before claiming it's broken
- [ ] **Scrape retry/backoff.** Read `scraper/browser.ts` and `scraper/extractor.ts` — if a single transient network blip bumps `consecutive_failures` with no retry, one flaky minute can cause false error alerts. Add exponential backoff at the network layer if missing.
- [ ] **Scheduler jitter.** If trackers all share `check_interval_minutes`, they hit their sources in the same minute. Fine at current scale; add a small random offset per tracker at creation time if you pass ~30-50 trackers or start hitting rate limits.
