# Price Tracker — Todo

## Current Status

Deployed and live at `prices.schultzsolutions.tech` (CT 302, `192.168.1.166:3100`). GitHub: `andrewschultzw/price-tracker` (private). DB persists through deploys with automatic backups. Proxmox snapshot taken 2026-04-09.

**Scale:** ~20 trackers across multiple retailers, multi-seller support live.

**Notification channels configured:** Discord, self-hosted ntfy (CT 115 at `ntfy.schultzsolutions.tech`), generic webhook.

**Test coverage:** 184 tests total (123 server + 61 client) across scrape pipeline, notification channels, crypto, retry logic, dashboard sort, tier celebrations.

---

## Open items

### Priority: next big bets

- [x] **AI Buyer's Assistant.** ~~Claude API integration that turns the price chart into an advisor.~~ **Done 2026-05-04:** rules-judge / LLM-narrate pattern. Pure signals + verdict (zero IO, fully unit-tested), Anthropic Haiku 4.5 client wrapper with retry/validation/kill switch, ephemeral-cached prompt builders with hallucination guard, generators that compose all the pieces. Wired into the cron path as fire-and-forget on price change; alert copy across all 4 channels with 3s timeout fallback to plain template; nightly backfill cron for summaries. New env: `AI_ENABLED` (default false), `ANTHROPIC_API_KEY`, `AI_MODEL`. Migration v8 adds 8 AI columns to `trackers`. UI: BUY/WAIT/HOLD verdict pill on every card, AIInsightsCard above the chart on TrackerDetail. Server tests 280 → 364 (+84). Estimated cost ~$0.20/month at current scale. Spec: `docs/superpowers/specs/2026-05-04-ai-buyers-assistant-design.md`. Plan: `docs/superpowers/plans/2026-05-04-ai-buyers-assistant.md`. [PR #11](https://github.com/andrewschultzw/price-tracker/pull/11).

  **Carry-forward (address before flipping `AI_ENABLED=true` globally):**
  - [ ] Rename `ai_verdict_failures_24h` → `ai_verdict_failures_total` in `/api/health` (or document inline that it's cumulative-since-last-success, not a 24h window).
  - [ ] `generateSummaryForTracker` doesn't increment `ai_failure_count` on failure — only verdict failures count. Either symmetrize the behavior or document the asymmetry on the failure-count column.
  - [ ] Wire `community_low` into `loadSignalsForTracker` from `getOverlapForTracker`. Currently hardcoded to `null`, so Claude never sees the cohort signal even though the field is in the prompt.
  - [ ] Delete the dead `config.aiEnabled` field — all callers read `process.env.AI_ENABLED` directly. Field is populated at startup but never read.
  - [ ] Strengthen `updateTrackerAIVerdict` arg type from `tier: string` to `tier: VerdictTier`. Single caller today (generators) passes the right type; tightens the type-safety net.

- [ ] **Project / Bundle tracker.** Multi-tracker "baskets" with a combined budget target. Alert fires when the basket total hits target, regardless of any single item's drop. Per-item ceilings supported. Pairs with the AI Buyer's Assistant for per-item "buy now / wait" guidance. Spec: TBD.

- [ ] **Browser extension + installable PWA.** One-click capture from any retailer page (Chrome / Firefox extension) plus PWA-ification of the existing site for installable mobile app + Web Push. Stretch: iOS Share Sheet shortcut. Spec: TBD.

### Priority: future portfolio

- [ ] **Public product pages.** Anonymous aggregated history at `/p/<slug>`. Camelcamelcamel for the long tail; SEO + reference utility.
- [ ] **Community deal feed.** Opt-in anonymous trending feed of biggest drops across the user base. Reuses the existing `normalized_url` groundwork.
- [ ] **Stock + refurb tracking.** Amazon Warehouse, Newegg refurb, Best Buy open-box alongside new. Often beats new by 20-30%.
- [ ] **Doorbuster mode.** Prime Day / Black Friday escalates polling cadence to every 2-3 min and routes alerts through priority channels.
- [ ] **Confidence-scored alerts.** "12-month low, 3rd time this year, holds for ~3 days." Replaces gut-feel with data on every alert.
- [ ] **Natural-language query via OpenClaw.** "When was the LG monitor cheapest this year?" Discord DM hits a NL query endpoint. Extends the existing OpenClaw skill (currently create-only).
- [ ] **Apple Watch / iOS widget.** Glanceable status of trackers near target.
- [ ] **Wishlist / gift mode.** Share wishlists; recipient can't see what's been bought.
- [ ] **Affiliate revenue layer.** Route "Buy" clicks through Amazon Associates etc. Self-sustaining hobby-business angle.
- [ ] **Invite flow + family/friends polish.** Multi-user is already there under the hood; needs onboarding polish to go from 1 to ~20 real users.

### Priority: actually worth doing

- [x] **Test debt from multi-seller session.** ~~Core invariants that could silently break~~ **Done 2026-04-09:** all 4 items closed. 38 new integration tests across `refresh-aggregates.test.ts` (14), `delete-tracker-url.test.ts` (9), `migration-v4.test.ts` (7), and `scheduler/cron-cooldown.test.ts` (8). New `_setDbForTesting()` helper in `connection.ts` lets tests spin up fresh in-memory sqlite instances with full migration runs. The cron-cooldown test is the most valuable — it locks down the defining multi-seller invariant that one seller hitting cooldown does NOT silence a later alert from a different seller on the same tracker. Server tests: 134 → 172.

- [x] **Email notification channel.** ~~Fourth channel reusing Cloudflare+Gmail relay.~~ **Done 2026-04-18:** Gmail SMTP via `alerts@schultzsolutions.tech` Send-As alias (Cloudflare Email Routing + Gmail Send-As, Treat-as-alias mode), nodemailer transport, multipart HTML + plaintext bodies, encrypted `email_recipient` per user, new `POST /api/settings/test-email` endpoint, Settings card with "Send test email" button. 5 new tests in `email.test.ts`. Spec: `docs/superpowers/specs/2026-04-18-email-notification-channel-design.md`. Plan: `docs/superpowers/plans/2026-04-18-email-notification-channel.md`. [PR #3](https://github.com/andrewschultzw/price-tracker/pull/3).

- [x] **Test with 10+ real product URLs.** ~~Integration sanity sweep across retailers.~~ **Done 2026-04-18:** new `npm run canary` dev tool (`server/src/scripts/canary-sweep.ts`) — pulls every active `tracker_urls` row from the prod DB via SSH, runs every extraction strategy against each URL, classifies outcomes as `ok` / `unavailable` / `bot_check` / `no_price` / `fetch_error`, saves intercept HTMLs to `tmp/canary/` (gitignored) for post-mortem. First run covered 25 URLs across amazon / newegg / a.co / amzn.to / ikoolcore / wisdpi / worldwidestereo / walmart. Discovered Walmart uses PerimeterX "Robot or human?" intercept.

### Priority: polish

- [x] **Bundle code-splitting.** ~~Vite is warning at ~650 KB bundle.~~ **Done 2026-04-09:** converted all non-Dashboard pages to `React.lazy()` with a shared Suspense boundary. `PriceChart` (recharts, 347 KB) and `SavingsCelebration` (canvas-confetti, 14 KB) also lazy from their usage sites. Initial gzipped payload dropped 200 KB → 66.6 KB (-67%). Vite's chunk-size warning is gone.

- [x] **Active stat card clickable.** ~~Plain number.~~ **Done 2026-04-17:** 4 of 4 stat cards now clickable. `/active` route shows flat grid of every `status='active'` tracker sorted by `last_checked_at` desc (no category collapse, unlike the main dashboard). 4 new unit tests for `sortByLastCheckedDesc`. [PR #2](https://github.com/andrewschultzw/price-tracker/pull/2).

### Priority: only when it bites

- [x] **Per-channel cooldowns.** ~~Current cooldown is per-`(tracker, seller)` shared across all channels.~~ **Done 2026-04-29:** cooldown gate moved into the per-channel fanout in `firePriceAlerts`, now keyed off `(tracker, seller, channel)`. Each channel has its own user-configurable duration via new settings keys `{discord,ntfy,webhook,email}_cooldown_hours` (Settings UI exposes a number input per channel; blank uses the existing 6h default; `0` means "no cooldown" — the "ntfy instant" case). Plausibility guard placement unchanged. 6 new test cases on top of the existing 8 in `cron-cooldown.test.ts`. The unused `getLastNotificationForSeller` was removed since the refactor took its only caller. Spec: `docs/superpowers/specs/2026-04-29-per-channel-cooldowns-design.md`. Plan: `docs/superpowers/plans/2026-04-29-per-channel-cooldowns.md`.

- [x] **Scheduler jitter.** ~~Same-minute firing risk at 30-50 trackers.~~ **Done 2026-04-18:** new `jitter_minutes` column on `trackers` with a fixed per-tracker random offset assigned at creation (formula: `randomInt(0, min(interval/6, 30))`). `getDueTrackerUrls` and `getDueTrackers` add jitter to `check_interval_minutes` when computing due time. Migration v5 backfilled all 22 existing trackers — confirmed spread across 15 distinct jitter values (2-29 min). 9 new tests in `jitter.test.ts`.

- [x] **CT 302 UniFi DHCP reservation** ~~MAC `BC:24:11:6D:45:11`, current IP `192.168.1.166`. Static in `pct config` but belt-and-suspenders reservation recommended.~~ **Done 2026-05-04:** UniFi DHCP reservation added.

- [x] **CT 115 ntfy UniFi DHCP reservation** ~~Current IP `192.168.1.34`.~~ **Done 2026-05-04:** UniFi DHCP reservation added.

### Priority: future / separate session

- [x] **OpenClaw integration.** ~~Discord bot skill that accepts a product link + threshold.~~ **Done 2026-04-18:** new `X-API-Key` middleware (`server/src/auth/apiKey.ts`) that runs before JWT on `/api/*`. Single shared key in env (`PRICE_TRACKER_API_KEY` + `PRICE_TRACKER_API_KEY_USER_ID`) — any matching request acts as the configured user. New `price-tracker` skill file on CT 301 tells OpenClaw's agent to `curl` the create endpoint with `{{env.X}}` template substitution. DM OpenClaw "track this: <url> for $N" → POSTs `/api/trackers` → tracker appears within ~60s with the first scraped price. Create-only by design; list/check/delete stay in web UI. Spec: `docs/superpowers/specs/2026-04-18-openclaw-discord-skill-design.md`. Plan: `docs/superpowers/plans/2026-04-18-openclaw-discord-skill.md`. [PR #7](https://github.com/andrewschultzw/price-tracker/pull/7).

- [x] **Better CAPTCHA / block detection for non-Amazon retailers.** ~~Extend bot-check detection beyond Amazon.~~ **Done 2026-04-18 (partial):** captured Walmart's PerimeterX intercept page (title `<title>Robot or human?</title>`) via the canary sweep. Added title match `^\s*robot or human\??\s*$` to `isBotCheckPage` in `browser.ts`. Fixture test at `server/src/scraper/strategies/__fixtures__/walmart-bot-check.html` plus a false-positive guard test (benign "Robot Vacuum" product page stays clean). Best Buy / Target patterns deferred — we haven't seen their intercept pages in any real scrape (no trackers yet; canary run was clean across our current URL set).

- [x] **Cross-user tracker overlap flag.** ~~"N others track this" indicator.~~ **Done 2026-04-18:** new `normalized_url` column on `trackers` (migration v6), populated at create-time + re-normalized on primary-seller scrape (resolves short links like `a.co/d/xyz` → `amazon.com/dp/...`). Two API endpoints: `GET /api/trackers/:id/overlap` (`{count, names, communityLow}`) and `GET /api/trackers/overlap-counts` (batch). Dashboard pill "Also tracked by N" on every card grid (Dashboard/Active/BelowTarget/Errors). Community card on TrackerDetail with count, opt-in names, and community low price (only when beating user's current). Settings toggle `share_display_name` (global, default off). Fetch + delivery smoke-tested in prod; migration v6 backfilled all 22 trackers. Known limitation: Amazon wishlist URLs with `colid`/`coliid` params don't match plain product URLs — can extend TRACKING_PARAMS later if it matters.

  **Design questions to resolve first:**
  - **Matching strategy.** Exact URL match is easy but misses reality — `a.co/d/xyz`, `amazon.com/dp/ABC`, and `smile.amazon.com/dp/ABC` might all be the same product. Options: (a) exact URL match only (simple, misses cases), (b) canonical URL normalization (strip query params, follow short-link redirects at add time), (c) product identity matching (extract the ASIN or SKU from known retailers and match on that — most accurate, requires per-retailer parsers).
  - **Privacy model.** Do users see *who* else tracks it, or just an anonymous count? Anonymous count is less invasive and still useful ("3 others track this"). Showing names requires opt-in. Default to anonymous count.
  - **What's shared vs what stays private.** The URL overlap is shared context — but threshold prices, notification settings, alert history, and per-user price history MUST stay private. Only the "this product is tracked by N users" fact crosses the user boundary. Consider: could share a community all-time low across matching trackers without leaking any individual's data (min across all users is anonymous aggregate).
  - **Surface.** Where does the indicator appear? Options: (a) badge on TrackerCard — passive, always visible, (b) toast on the Add Tracker flow — proactive: "Hey, 2 others already track this. Want to see the community low?", (c) TrackerDetail card section showing overlap count + optional community low, (d) all of the above.
  - **Scale concern.** The match-existing-URLs check runs on every tracker creation. At current scale (<100 total trackers) a full-table scan is fine; at higher scale might want an index on a normalized URL column. Probably not worth worrying about until 1000+ trackers.

  **Scope when we build it:**
  - New `normalized_url` column on `trackers` populated on create/update via a shared canonicalization helper (same canonical domain logic as categories, plus path normalization and query-param stripping).
  - Migration to backfill `normalized_url` for existing rows.
  - Index on `normalized_url` for fast overlap lookups.
  - New `GET /api/trackers/:id/overlap` returning `{ count: number }` — anonymous, no user info leaked.
  - Dashboard/Detail UI pill "Also tracked by N others" when count > 0.
  - Optional stretch: "community low" aggregate if users opt in.

  **Brainstorm this properly at the start of that session** — the matching strategy decision especially is non-trivial and will shape the schema.

---

## Done

### 2026-04-17 — Silent false-positive fix, scoped fallbacks

- [x] **Amazon / Newegg silent false-positive trackers.** Two trackers were firing below-threshold alerts on wrong prices: JetKVM at $35.99 (a sponsored Amazon accessory when the real product was "Currently unavailable") and WD Red Plus 10TB at cycling $10/$249/$389 (random Newegg sponsored-carousel hard drives when JSON-LD extraction missed). Root cause: the `.a-offscreen` (Amazon) and `.price-current` / generic regex (Newegg) fallbacks were unscoped and picked up carousel prices when the main buy box couldn't be located. Fix: new `sliceBalancedDiv` helper with nested-div depth counting, scope Amazon fallback to `#apex_desktop` / `#corePrice*`, scope Newegg to `<div class="product-price">`, and short-circuit with a non-retryable `ScrapeError` when Amazon reports "Currently unavailable". Real-HTML fixture tests lock down the $35.99 / $10 / $249 / $389 values as never returned. Bad history deleted (41 Newegg, 8 JetKVM rows) and both URLs reseeded. [PR #1](https://github.com/andrewschultzw/price-tracker/pull/1).

### 2026-04-09 — Celebrations, ntfy hosting, scrape fixes

- [x] **Self-hosted ntfy on CT 115.** Debian 12, 1 vCPU / 512MB / 4GB. ntfy 2.14.0 from official Debian repo. `auth-default-access: deny-all` — every user needs an account and explicit ACL grant. Web push with auto-generated VAPID keys. Reachable at `https://ntfy.schultzsolutions.tech` via Cloudflare Tunnel + NPM (proxy_host #13 with websocket upgrade + 3600s read timeout for long-poll /subscribe). Admin user `andrew`, price-tracker access token generated. Full onboarding walkthrough published as [docs/services/ntfy-add-friend](https://docs.schultzsolutions.tech/docs/services/ntfy-add-friend/) on the Jekyll docs site.

- [x] **Price Tracker ntfy auth token support.** New optional `ntfy_token` setting (encrypted at rest alongside `ntfy_url`). Backend sends `Authorization: Bearer <token>` when present. Settings page has a password-style token input under the ntfy URL field. Works with both public ntfy.sh (no token) and self-hosted deny-all (token required).

- [x] **Clickable Potential Savings stat card with tier celebrations.** 6 tiers ($1-10, $10-25, $25-50, $50-100, $100-250, $250+) each with 5 rotating sayings and progressively more ridiculous visual effects via `canvas-confetti`. Strict superset escalation — tier 6 plays everything from tiers 1-5 plus a massive cannon, gold border pulse, screen shake, backdrop blur. Respects `prefers-reduced-motion`. 29 new tier tests. Hold duration 7s (tiers 1-5) / 9s (tier 6).

- [x] **Amazon split-price bug fixed.** `css-patterns` strategy was matching `.a-price-whole` and returning the dollar portion only (e.g. `$53` instead of `$53.99`). Added dedicated `AMAZON_OFFSCREEN_RE` that matches `<span class="a-offscreen">` for Amazon's accessibility full-price span (always contains the complete price text). Removed `.a-price-whole` and the broken compound selector `.a-price .a-offscreen` from COMMON_SELECTORS. Also fixed the class-name boundary regex to require real whitespace/quote boundaries so `.price` stops falsely matching `price-characteristic`. 13 new tests.

- [x] **Bot-check retry for transient Amazon intercepts.** New `isBotCheckPage()` helper in `browser.ts` detects Amazon's `/errors/validateCaptcha` and `/ap/cvf/request` redirects, "Robot Check" title, known intercept phrases, and suspiciously small HTML from known retailer domains. Throws retryable `ScrapeError` so the existing retry loop takes another attempt with a rotated user agent.

- [x] **Manual-check cooldown bypass + info-level cooldown logging.** Clicking "Check Now" or "Check All Now" or adding a new seller URL now bypasses the per-seller cooldown — those are explicit user requests, not scheduler ticks. Cooldown-suppressed alerts log at `info` level (was `debug`) with tracker name, seller URL, last sent timestamp, and minutes until ready.

- [x] **Global git identity set.** Commits now authored as `andrewschultzw <andrewschultzw@users.noreply.github.com>` instead of `root`.

- [x] **Proxmox snapshot taken** after confirmed working state.

### 2026-04-08 — Multi-seller, test scaffolding, security hardening

- [x] **Multi-seller tracker support.** New `tracker_urls` table with per-seller state (`last_price`, `last_checked_at`, `last_error`, `consecutive_failures`, `status`, `position`). Migration v4 backfilled 20 existing trackers into primary seller rows and attributed 845 historical price_history rows + 1 notification. Scheduler walks per-seller rows, aggregates back to the tracker via `refreshTrackerAggregates()`. Per-`(tracker, seller)` cooldown — Amazon dropping doesn't silence a later Newegg drop. Dashboard card shows lowest across sellers with "lowest @ host" indicator and "N sellers" badge. TrackerDetail has a full Sellers section with add/remove controls. API: `GET/POST/DELETE /trackers/:id/urls`. CSV export gains `seller_url` column.

- [x] **Dashboard virtual category pages.**
  - `/below-target` — clickable Below Target stat card opens a live deals view sorted by biggest savings first. Header shows total potential savings.
  - `/errors` — clickable Errors stat card opens a view of every errored tracker (uses shared `isErrored()` helper). "Check All Now" button fans out `POST /trackers/:id/check` in parallel via `Promise.allSettled`.

- [x] **Notification history view.** New `/notifications` page with colour-coded channel badges (discord blue, ntfy green, webhook orange, unknown grey). Migration v2 added nullable `channel` column; `cron.ts` records one notification row per successful channel. TrackerDetail has a "Recent Alerts" card scoped to that tracker.

- [x] **CSV/JSON export of price history.** `GET /api/trackers/:id/export?format={csv|json}` with RFC 4180 CSV, `seller_url` column, filename slug from tracker name. Export buttons on TrackerDetail. 15 util tests.

- [x] **Lowest-ever price indicator.** `/api/trackers/stats` returns per-tracker sparkline + all-time low with timestamp. TrackerCard shows "Low: $X" plus "at low" pill when current matches historical minimum. TrackerDetail has an "All-Time Low" stat tile (not range-scoped).

- [x] **Admin users page — tracker count column.** `getAllUsersForAdmin()` joins users and trackers with LEFT JOIN + COUNT so users with zero trackers still appear. Right-aligned column with `tabular-nums` for aligned digits.

- [x] **Scrape retry/backoff.** New `scraper/retry.ts` with `withRetry()` + `ScrapeError`. Default: 2 retries, 1s → 3s exponential backoff. Retries transient failures (network errors, timeouts, 5xx, unknown error types) and fails fast on deterministic ones (4xx). Configurable via `SCRAPE_MAX_RETRIES` and `SCRAPE_RETRY_BASE_MS` env. 11 tests.

- [x] **Webhook URLs encrypted at rest.** AES-256-GCM authenticated encryption via `crypto/settings-crypto.ts`. Per-value random IV, `v1:` prefix for future rotation. Key from `SETTINGS_ENCRYPTION_KEY` env (fail-fast in production). Migration v3 encrypted existing rows in place. Transparent to callers via `getSetting`/`setSetting`. 19 tests covering round-trip, GCM tamper detection, key derivation, cross-instance isolation.

- [x] **Favicon privacy leak fixed.** Public `GET /api/favicon?domain=...` route proxies DuckDuckGo's icons service with 24h in-memory cache and 10min negative cache. Strict hostname validation (rejects IPv4 literals, protocol prefixes, paths, CRLF injection) as SSRF guards. 25 validator tests.

- [x] **Test scaffolding set up.** vitest in both workspaces, wired into `rebuild.sh` so failing tests block deploys. Initial suites: `parsePrice`, `jsonld` strategy, Discord notification payload shape, `canonicalDomain`, `buildDashboardLayout` (extracted to pure module from Dashboard.tsx during this refactor).

- [x] **ntfy + generic webhook notification channels** (before self-hosting — this was the initial multi-channel rollout). Three channels available; real error messages surface in the Settings UI instead of silent "Failed".

- [x] **Domain alias grouping.** Short-links and regional variants roll up to a canonical brand key (a.co, amzn.to, amazon.co.uk → amazon.com). Category collapse at >10 trackers per domain.

- [x] **Mobile UX pass.** Hamburger menu below md breakpoint, responsive TrackerDetail action row, responsive Settings card padding, Notifications page mobile fix.

### Pre-review (initial build phases)

- [x] Phase 1: Project scaffold, Express server, SQLite schema, CRUD routes
- [x] Phase 2: Playwright browser pool, 6 extraction strategies, price parser
- [x] Phase 3: Scheduler (node-cron + p-queue), Discord webhook notifications
- [x] Phase 4: React + Vite + Tailwind frontend (Dashboard, Add, Detail, Settings)
- [x] Phase 5: CT 302 deploy, systemd service, NPM proxy, SSH key
- [x] UI polish: stat cards, sparklines, favicon, retailer logos, page titles
- [x] DB persistence: `deploy.sh` excludes `data/`, `rebuild.sh` backs up DB before changes
- [x] GitHub repo pushed (private)
