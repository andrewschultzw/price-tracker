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
- [x] **Zero test coverage.** ~~CLAUDE.md demands tests and none exist.~~ **Done 2026-04-08:** vitest scaffolding in both workspaces, 68 tests across scrape pipeline (`parsePrice`, `jsonld` strategy), notifications (`discord`), and client pure functions (`canonicalDomain`, `buildDashboardLayout`). Wired into `rebuild.sh` so failing tests block deploys. Dashboard sort extracted to `lib/dashboard-sort.ts` as a pure module. Still to cover: the other 5 scrape strategies (`css-patterns`, `opengraph`, `microdata`, `regex`, `css-selector`), ntfy/webhook channels, and cron threshold/cooldown/fanout integration tests.
- [x] **Webhook URLs stored plaintext in sqlite.** ~~`settings` table holds Discord/ntfy/generic webhook URLs as raw strings~~ **Done 2026-04-08:** AES-256-GCM authenticated encryption at rest via new `crypto/settings-crypto.ts` module. Per-value random IV, `v1:` version prefix for future key rotation. Key from `SETTINGS_ENCRYPTION_KEY` env var (fail-fast in production like JWT_SECRET). Migration v3 encrypted existing rows in place (idempotent). Transparent to callers via `getSetting`/`setSetting`. 19 unit tests covering round-trip, tamper detection via GCM auth tag, key derivation, cross-instance isolation.
- [x] **Favicon privacy leak.** ~~`TrackerCard` and `CategoryCard` fetch favicons from `www.google.com/s2/favicons`~~ **Done 2026-04-08:** new public `GET /api/favicon?domain=...` route proxies DuckDuckGo's icons service with a 24h in-memory cache and 10min negative cache. Strict hostname validation rejects IPv4 literals, protocol prefixes, paths, and CRLF injection as SSRF guards. 5-second upstream timeout. Soft LRU cap at 500 entries. 25 unit tests on the validator.

### Test debt from multi-seller session (2026-04-08)
- [ ] **Unit tests for `refreshTrackerAggregates`.** Rules: `last_price = MIN` across sellers, `status = 'error'` only if all sellers errored / `'paused'` only if all paused / else `'active'`, `last_error = first non-null`, `consecutive_failures = MAX`. Easy to mis-remember and would silently show wrong data on the dashboard if broken.
- [ ] **Per-seller cooldown integration test in `cron.ts`.** Core invariant of multi-seller: one seller hitting cooldown does NOT silence a later alert from a different seller on the same tracker. Needs an in-memory DB fixture and faked time.
- [ ] **`deleteTrackerUrl` primary-promotion test.** When the primary (position=0) seller is deleted, the next-lowest position is promoted AND `trackers.url` is updated to match. Either half silently breaking = category grouping goes wrong.
- [ ] **Migration v4 backfill test.** Idempotency (re-running skips already-backfilled rows via the LEFT JOIN guard), child-table backfill touches only NULL `tracker_url_id` rows, primary rows copy all seller state correctly.

### Dashboard stat cards — make them interactive
- [ ] **Make the 4 stat cards at the top of the dashboard actionable.** Currently `Active`, `Below Target`, `Errors`, and `Potential Savings` (`client/src/components/StatCards.tsx`) are purely informational. Ideas to explore once you decide what you want: click a card to filter the tracker grid below (e.g., clicking "Errors" shows only errored trackers, clicking "Below Target" shows only deals); click "Potential Savings" to sort the grid by savings descending; hover tooltips showing the calculation breakdown; tapping twice to clear the filter. You'll give input on which behaviours you actually want before I build.

### Features
- [x] **Lowest-ever indicator on TrackerCard.** ~~Show the all-time low next to current price~~ **Done 2026-04-08:** `/api/trackers/stats` returns per-tracker sparkline + all-time low with timestamp. TrackerCard shows a "Low: $X" line plus an "at low" pill when current price matches the historical minimum. TrackerDetail gets a new "All-Time Low" stat tile (not range-scoped).
- [x] **Notification history view.** ~~We have three channels + cooldowns tracked in the `notifications` table but no UI to see what got sent.~~ **Done 2026-04-08:** new `/notifications` page in the nav with colour-coded channel badges. Added `channel` column via migration v2. cron.ts now records one notification row per successful channel. TrackerDetail has a "Recent Alerts" card scoped to that tracker.
- [x] **CSV/JSON export of price history.** ~~Button on TrackerDetail that dumps full `price_history` to CSV.~~ **Done 2026-04-08:** new `GET /api/trackers/:id/export?format={csv|json}` route, RFC 4180 CSV with quote-doubling escape, JSON wraps history with tracker metadata + exported_at. TrackerDetail has CSV and JSON download buttons next to the range picker. Shared `util/csv.ts` with `toCsv()` and `slugify()`, 15 unit tests.
- [ ] **Email notification channel.** Fourth channel using the existing Cloudflare+Gmail relay already set up for Paperless (`docs@schultzsolutions.tech`). Most accessible channel for non-technical users — no app install, no webhook setup, just paste an email address.

### Polish
- [ ] **Bundle code-splitting.** Vite is warning about the 632 kB bundle. Split `PriceChart` and the Admin page into dynamic imports — should cut ~150 kB off the initial bundle and help mobile first-load.
- [ ] **Per-channel cooldowns.** Current cooldown is per-tracker, locking all channels together. Only worth doing if someone actually wants mixed-frequency notifications (e.g., ntfy immediately, webhook hourly).

### Worth investigating before claiming it's broken
- [x] **Scrape retry/backoff.** ~~Read `scraper/browser.ts`~~ **Investigated + fixed 2026-04-08:** confirmed zero retries existed anywhere in the scrape path. Added `scraper/retry.ts` with `withRetry()` + `ScrapeError` class. Default policy: 2 retries with 1s → 3s exponential backoff (3 attempts total). Classifier retries transient failures (network errors, timeouts, 5xx, unknown error types like browser crashes) and fails fast on deterministic ones (4xx). Configurable via `SCRAPE_MAX_RETRIES` and `SCRAPE_RETRY_BASE_MS` env vars. Worst-case scrape time per tracker grows from ~32s to ~95s, still well within PQueue capacity. 11 unit tests covering the retry helper.
- [ ] **Scheduler jitter.** If trackers all share `check_interval_minutes`, they hit their sources in the same minute. Fine at current scale; add a small random offset per tracker at creation time if you pass ~30-50 trackers or start hitting rate limits.
