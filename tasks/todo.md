# Price Tracker — Todo

## Current Status

Deployed and live at `prices.schultzsolutions.tech` (CT 302, `192.168.1.166:3100`). GitHub: `andrewschultzw/price-tracker` (private). DB persists through deploys with automatic backups. Proxmox snapshot taken 2026-04-09.

**Scale:** ~20 trackers across multiple retailers, multi-seller support live.

**Notification channels configured:** Discord, self-hosted ntfy (CT 115 at `ntfy.schultzsolutions.tech`), generic webhook.

**Test coverage:** 184 tests total (123 server + 61 client) across scrape pipeline, notification channels, crypto, retry logic, dashboard sort, tier celebrations.

---

## Open items

### In flight — 2026-05-11

- [x] **Retailer-blocked status (Akamai 403 / Cloudflare 403 etc.)** ~~New Home Depot tracker hit `HTTP 403 from www.homedepot.com` on all 3 scrape attempts.~~ **Done 2026-05-11:** diagnosis confirmed Akamai (`server: AkamaiGHost`) blanket-blocking CT 302's egress IP `167.253.135.140` — homepage curl 403s too, same class as Best Buy. First-class `'blocked'` status now lives end-to-end. 38 new tests, 764+115 passing.

  Shipped:
  - [x] Migration v17 widens status CHECK via `db.unsafeMode(true)` + `PRAGMA writable_schema` + `UPDATE sqlite_schema` (rebuild-the-table approach hit FK cascade issues — `foreign_keys` pragma is a no-op inside a transaction). Lessons captured.
  - [x] `schema.ts` fresh-install schema + TS unions updated in `queries.ts` / `projects/types.ts` / client `types.ts`.
  - [x] New `isRetailerBlock(status, headers)` in `browser.ts` matches `AkamaiGHost` (403/429) and `cloudflare` + `cf-mitigated` (403). Throws `ScrapeError` with new `retailerBlocked: true` flag.
  - [x] `checkTrackerUrl` error handler: `retailerBlocked` → `status='blocked'`, resets `consecutive_failures`, suppresses error alert, logs at warn.
  - [x] `getDueTrackerUrls` filters `tu.status NOT IN ('paused', 'blocked')` — cron stops re-checking. Manual "Check Now" still works (in case the block lifts).
  - [x] `refreshTrackerAggregates` rolls all-blocked → `'blocked'`; mixed (blocked + active) stays `'active'` so the working seller's price still surfaces.
  - [x] Known-blocked-host list (`homedepot.com`, `bestbuy.com`) in `scraper/blocked-retailers.ts`. `createTracker` and `addTrackerUrl` auto-mark sellers from those hosts as `'blocked'` at insert time.
  - [x] `StatusBadge` adds amber `"Retailer blocked"` badge (ShieldOff icon). `isErrored()` excludes blocked sellers (server's `errored_seller_count` SQL already excluded them because we reset `consecutive_failures` to 0).
  - [x] Tests: scraper detection (Akamai 403/429 + Cloudflare cf-mitigated), migration v17 (CHECK widening + rejection of unknown values + row preservation), aggregate roll-up, auto-block on creation, host-match safety (case, substring lookalikes).
  - [x] `tasks/lessons.md` updated with both patterns (WAF IP-block diagnosis shortcut + SQLite writable_schema migration trick).

### New — 2026-05-29

- [ ] **Tighten up OpenClaw.** CT 301 has been powered off for a while; the integration is unreliable when it is up. Harden the whole loop: container uptime/restart policy, gateway health, the `price-tracker` create skill, and the silent-zombie failure mode (see `feedback_openclaw_zombie` memory). Goal: OpenClaw is dependable enough to trust as a real input channel — or we consciously decide to scale back what depends on it. Brainstorm scope at session start; may warrant its own todo file under the OpenClaw project rather than living here.

- [ ] **Autonomous purchasing (buy-on-trigger) — v1 built on `feature/autonomous-purchasing`, [PR #43](https://github.com/andrewschultzw/price-tracker/pull/43) (CI green), DEPLOYED to CT 302 prod + browser smoke PASSED 2026-05-31; MERGED via PR #43 on 2026-06-01.** Per-tracker "arm for purchase" → on threshold cross an armed Amazon tracker creates a one-time owner-approved purchase intent + a purchase-arm notification (all 5 channels: Discord/ntfy/web push/email/webhook) with a one-tap `/buy/<token>` link → owner approves → handed to the Amazon `/dp/<ASIN>?tag=` product page (no stored payment, no checkout automation; legacy add-to-cart URL dropped — see below) → "Did it go through?" closes the loop, reusing the existing `createPurchase()` ledger. Spec: `docs/superpowers/specs/2026-05-31-autonomous-purchasing-design.md`. Plan: `docs/superpowers/plans/2026-05-31-autonomous-purchasing.md`. Migration v19 (`purchase_intents` + `buy_armed`/`buy_quantity`). Safety: armed+one-tap-confirm (the tap is the spend control), one-open-intent-per-tracker, atomic/transactional state-gated resolution, re-arm cooldown, auth-gated owner-only `/api/buy/*` (404 on non-owner), arming runs post-plausibility-guard. Server 881 tests + client 131 tests + extension 50 + all builds green; per-task spec/quality/security reviews + final holistic review done.
  - [x] **Real-browser render smoke — DONE 2026-05-31.** Headless Chromium on CT 302 (throwaway instance on :3101, fresh DB, prod untouched) rendered `/buy/:token` (armed + approved states) and the TrackerDetail "Arm for purchase" card with **zero console errors**; screenshots visually confirmed. Branch deployed to live prod via `deploy.sh` (bundle-hash verified, migration v19 applied, service active).
  - [x] **Amazon handoff validated + fixed — DONE 2026-06-01 ([PR #44](https://github.com/andrewschultzw/price-tracker/pull/44)).** Real-browser test (CT 302 Chromium, 4 live ASINs) showed the legacy `/gp/aws/cart/add.html` URL 302-redirects to an Amazon **Associates sign-in wall** (not dead/404, not bot-blocked — repurposed behind Associates auth), so a normal shopper gets a login page with no item. Switched the handoff to the confirmed-working `/dp/<ASIN>?tag=` product page (`buildAmazonBuyUrl`, field `cartUrl`→`buyUrl`, copy "Open on Amazon" + hint). Deployed to prod + re-smoked (approve API returns the `/dp/` URL; page renders clean, zero console errors).
  - [ ] **v2 (separate spec):** autonomous checkout — removes the per-purchase tap. The cumulative-wallet/per-item/recurring spend envelope becomes the mandatory autonomous-overspend guardrail and gates graduation. Plus stored/tokenized payment, checkout bot-defenses, retailer ToS, order-confirmation signal.
  - [ ] **Deferred fast-follows:** a DB partial-unique index for one-open-per-tracker (currently read/route-layer + atomic-gate enforced; fine while cron is single-threaded); end-to-end arming test through `firePriceAlerts` (currently unit-tested on `maybeArmPurchase` directly). (Email + generic-webhook purchase-arm builders are now DONE — all 5 channels covered.)

### Priority: next big bets

- [x] **AI Buyer's Assistant.** ~~Claude API integration that turns the price chart into an advisor.~~ **Done 2026-05-04:** rules-judge / LLM-narrate pattern. Pure signals + verdict (zero IO, fully unit-tested), Anthropic Haiku 4.5 client wrapper with retry/validation/kill switch, ephemeral-cached prompt builders with hallucination guard, generators that compose all the pieces. Wired into the cron path as fire-and-forget on price change; alert copy across all 4 channels with 3s timeout fallback to plain template; nightly backfill cron for summaries. New env: `AI_ENABLED` (default false), `ANTHROPIC_API_KEY`, `AI_MODEL`. Migration v8 adds 8 AI columns to `trackers`. UI: BUY/WAIT/HOLD verdict pill on every card, AIInsightsCard above the chart on TrackerDetail. Server tests 280 → 364 (+84). Estimated cost ~$0.20/month at current scale. Spec: `docs/superpowers/specs/2026-05-04-ai-buyers-assistant-design.md`. Plan: `docs/superpowers/plans/2026-05-04-ai-buyers-assistant.md`. [PR #11](https://github.com/andrewschultzw/price-tracker/pull/11).

  **Carry-forward — done 2026-05-06 in [PR #14](https://github.com/andrewschultzw/price-tracker/pull/14):**
  - [x] Rename `ai_verdict_failures_24h` → `ai_verdict_failures_total` in `/api/health`.
  - [x] `generateSummaryForTracker` now increments `ai_failure_count` on failure (symmetric with verdict path).
  - [x] `community_low` wired into `loadSignalsForTracker` via `getOverlapForTracker` — Claude now sees the cohort signal.
  - [x] Dead `config.aiEnabled` field deleted; added NB comment in `config.ts` to prevent re-introduction.
  - [x] `updateTrackerAIVerdict` arg type tightened from `tier: string` to `tier: VerdictTier` + `reasonKey: ReasonKey`.

  **Verdict backfill cron — done 2026-05-06 in [PR #16](https://github.com/andrewschultzw/price-tracker/pull/16):** nightly sweep at 03:00 CT now also backfills missing/stale verdicts (previously only summaries). New `aiVerdictStalenessDays: 7` config. Server tests 511 → 520.

- [x] **Project / Bundle tracker.** ~~Multi-tracker "baskets" with a combined budget target.~~ **Done 2026-05-05:** new `projects` + `project_trackers` + `project_notifications` tables (migration v9), basket aggregation with eligibility checks (per-item ceilings, item count, total target), per-channel fanout, AI commentary on basket alerts, BasketMembersTable with verdict pills + ceiling editor. Channel fanout extended to support project-scoped notifications alongside per-tracker. Spec: `docs/superpowers/specs/2026-05-05-bundle-tracker-design.md`. [PR #12](https://github.com/andrewschultzw/price-tracker/pull/12).

- [x] **PWA + Web Push (the PWA half of the third big bet).** ~~Service worker + manifest + `<WebPushSettings>` Settings UI.~~ **Done 2026-05-05:** plain-JS service worker for push + click handling, web app manifest with theme/icons, WebPushSettings 5-state UI + devices list, per-device subscription model with auto-cleanup on 410/404, web_push as 5th channel in `firePriceAlerts` + basket-alert fanout, channel-level cooldown via `web_push_cooldown_hours`. Migration v10 (`web_push_subscriptions`) + v11 (extends `project_notifications.channel` CHECK to include `web_push`). Spec: `docs/superpowers/specs/2026-05-05-pwa-web-push-design.md`. [PR #13](https://github.com/andrewschultzw/price-tracker/pull/13).

- [x] **Browser extension (the extension half of the third big bet).** ~~Chrome MV3 extension, sideload-only for v1, one-click "Track this" from any retailer page via toolbar icon + right-click context menu.~~ **Done 2026-05-06:** new `extension/` workspace (Vite + @crxjs/vite-plugin + TypeScript MV3) with toolbar icon + right-click context menu, popup confirmation form, "Already tracking" state on revisit (60s `chrome.storage.session` cache), loading spinner, options page for token paste-in. Server-side per-user API tokens feature (Settings → Connected Apps): migration v12 (`user_api_tokens` table), SHA-256 hashed at rest with soft-delete, plaintext shown once. `apiKeyMiddleware` extended to accept user-issued tokens alongside the existing global env var. Server tests 488 → 511 (+23). Client tests 76 → 80 (+ component test infra: testing-library + jsdom). New extension test suite at 7 tests (message guards + normalize-url parity with server). Spec: `docs/superpowers/specs/2026-05-06-browser-extension-design.md`. Plan: `docs/superpowers/plans/2026-05-06-browser-extension.md`. [PR #15](https://github.com/andrewschultzw/price-tracker/pull/15).

  **v2 / future additions (not in v1):**
  - [ ] **Chrome Web Store distribution.** Promote v1 sideload to a public Web Store listing — $5 dev fee, screenshots, privacy policy, ~1-3 day review per update. Worth doing once v1 is stable.
  - [ ] **Firefox MV3 compat.** Different polyfills (`browser.*` vs `chrome.*`), different signing, AMO listing. Only if there's actual demand.
  - [x] **Element picker / point-and-click CSS selector capture.** ~~Content script overlay where the user clicks the price element to extract a selector.~~ **Done 2026-05-13:** new on-demand content script `extension/src/content/picker.ts` injected via `chrome.scripting.executeScript` (rides on `activeTab` permission, NO `<all_urls>` host_permissions added). 2px sky-500 outline on hovered element, live selector preview in floating tooltip, click commits via `@medv/finder` (~3.4KB gzipped). Result stored in `chrome.storage.session` keyed by URL; popup pre-fills the CSS field one-shot on next open with a "Picked from page — matched '$X.XX'" hint. Esc / right-click cancel. New `extension/src/lib/price-shape.ts` provides conservative price-text detection (rejects "Some Product $129" false positives). The picker.ts source declares in `content_scripts` with a never-matching `.invalid` pattern so @crxjs bundles it without auto-injecting; service worker reads the hashed bundle path from `chrome.runtime.getManifest()` at runtime. 13 new tests. Extension counts: 37 → 50. [PR #36](https://github.com/andrewschultzw/price-tracker/pull/36).
  - [ ] **Live in-page price preview** in the popup (the explicitly-rejected "Option C" from the click-flow brainstorm). Inject a content script on supported retailers to extract the current price/title from the live DOM, show in popup before confirming.
  - [ ] **Quick-edit / delete trackers from the popup.** Right now popup is write-side only — re-visit on a tracked URL shows "Open in Price Tracker →". Could expose threshold edit + delete inline.
  - [ ] **Add-to-Project flow from popup.** "Which bundle?" dropdown after Add succeeds — drops the new tracker straight into a Bundle Tracker project.
  - [ ] **Toolbar badge / icon coloring.** Light up the icon on supported retailer hosts; show "tracking" badge if URL is already tracked. Requires a tab-update listener and either a host_permissions broadening or a periodic dup-check refresh.
  - [ ] **Keyboard shortcut** (`Alt+Shift+T` or similar). Easy add via manifest's `commands`. Skipped in v1 because most users never learn extension shortcuts.

  **v1 fast-follows from final review (sub-threshold but worth tracking):**
  - [x] **`appendToCache` race window.** ~~Two popups simultaneously calling CREATE could lose one cache append.~~ **Resolved by v2 refactor 2026-05-09:** the post-CREATE path now does `invalidateTrackerCache()` + immediate `getCachedTrackerList()` re-fetch instead of in-place append. Concurrent CREATEs converge to the correct list within ~60s TTL regardless of interleaving — no append to lose.
  - [x] **No drift detection on `extension/src/types/api.ts`.** ~~Hand-mirror with no automated parity test.~~ **Done 2026-05-13** in extension v2.1 cleanup: new `extension/src/types/api.parity.test.ts` reads both source files at test time, extracts `interface Tracker` field names, and asserts (a) every extension field exists on the server, (b) every server field is either mirrored or explicitly listed in an `IGNORED_SERVER_FIELDS` set, (c) the ignored list has no stale entries. New server fields force a one-line decision (mirror or ignore-with-reason).
  - [x] **VALIDATION errors leak raw zod JSON to popup UI.** ~~`URL doesn't look right ({"fieldErrors":{...}}).`~~ **Resolved in earlier popup polish:** `errorText` already ignores `_detail` for every case (popup.ts:236) — `showError` only renders the friendly string. The raw zod payload still arrives as `resp.detail` but never gets rendered. No code change needed.
  - [x] **`errorText(code: string)` should be `errorText(code: ErrorCode)`.** ~~Loses exhaustiveness checks.~~ **Resolved in earlier popup polish:** already `errorText(code: ErrorCode, _detail?: string)` (popup.ts:236) with `const _exhaustive: never = code;` in the default branch. Adding a new `ErrorCode` would fail compilation as intended.
  - [x] **Hostname display can show non-hostname strings.** ~~`new URL('chrome://settings').hostname === 'settings'`.~~ **Done 2026-05-13** in extension v2.1 cleanup: new `extension/src/lib/url-guard.ts` with `unsupportedReason()` checks protocol (http/https only) AND DNS-shape hostname regex. `popup.ts main()` calls it before the form render — non-product pages get the new `tpl-unsupported` template with a clear "Can't track this page" message and a hint to open a real retailer URL. 11 unit tests covering chrome://, about:, file://, javascript:, localhost, IP literals, malformed input, and the happy path.
  - [x] **Spec drift: global key path kept plaintext compare instead of hash-compare.** ~~Spec says hash-compare; impl uses plaintext.~~ **Resolved in spec:** `docs/superpowers/specs/2026-05-06-browser-extension-design.md:75` explicitly documents the deviation with a security justification (`timingSafeEqual` over plaintext is constant-time and the env-var key has known length, so hash-compare adds no real security). Spec matches implementation already.

### Priority: future portfolio

- [x] **Public product pages.** ~~Anonymous aggregated history at `/p/<slug>`.~~ **Done 2026-05-06:** migration v13 (`public_product_slugs` table) backfilled at migration time + auto-created on each new tracker. Public API at `/api/public/products/:slug` (no auth, 15-min cache, daily-aggregated MIN price across all users tracking the same `normalized_url`). Sitemap.xml at root, robots.txt allowing `/p/*`. New PublicProduct page outside the auth wrapper with simplified header + meta/OG tags. Privacy: aggregated-only, no user counts, no usernames. [PR #19](https://github.com/andrewschultzw/price-tracker/pull/19) + [PR #26](https://github.com/andrewschultzw/price-tracker/pull/26) (discoverability: top-nav link, cross-link from `/p/<slug>`, Settings nudge).
- [x] **Community deal feed.** ~~Opt-in anonymous trending feed.~~ **Done 2026-05-06:** `/deals` route + `/api/public/deals` endpoint. Per-user opt-in via Settings → Community card (`share_in_deal_feed` setting). Sorted by `(threshold-price)/threshold` desc, last 7 days, 50 max. One entry per product (most recent notification wins). Reuses `public_product_slugs` for stable links to `/p/<slug>`. 5-min cache. [PR #20](https://github.com/andrewschultzw/price-tracker/pull/20).
- [x] **Stock + refurb tracking.** ~~Amazon Warehouse, Newegg refurb, Best Buy open-box.~~ **Done 2026-05-06:** new `condition` enum on `tracker_urls` (migration v14, default `'new'`). UI dropdown in AddTracker + TrackerDetail. Alert messages append condition tag (e.g., `$239 (Warehouse)`) when winning URL is non-`'new'`. No new scrape adapters needed. [PR #23](https://github.com/andrewschultzw/price-tracker/pull/23).
- [x] **Doorbuster mode.** ~~Prime Day / Black Friday cadence escalation.~~ **Done 2026-05-06:** 3 new nullable columns on `trackers` (migration v15: `doorbuster_start_at`, `doorbuster_end_at`, `doorbuster_interval_minutes`). When current time is inside the window, scheduler uses the doorbuster interval. UI on TrackerDetail to set/clear; `⚡ Doorbuster` badge on tracker card when active. [PR #25](https://github.com/andrewschultzw/price-tracker/pull/25).
- [x] **Confidence-scored alerts.** ~~"12-month low, 3rd time this year, holds for ~3 days."~~ **Done 2026-05-06:** pure deterministic layer on `computeSignals` returning HIGH/MEDIUM/LOW + 1-2 reasons. Renders as channel-specific prefix + reasons line across all 5 channels. Zero API cost; AI alert-copy prompt receives confidence as cached context. Plus per-channel suppression (`{channel}_min_confidence` setting: All deals / Good deals only / Strong deals only). [PR #18](https://github.com/andrewschultzw/price-tracker/pull/18) + [PR #21](https://github.com/andrewschultzw/price-tracker/pull/21).
- [ ] **Natural-language query via OpenClaw.** "When was the LG monitor cheapest this year?" Discord DM hits a NL query endpoint. Extends the existing OpenClaw skill (currently create-only).
- [ ] **Apple Watch / iOS widget.** Glanceable status of trackers near target.
- [x] **Wishlist / gift mode.** ~~Share wishlists; recipient can't see what's been bought.~~ **Done 2026-05-07:** per-user implicit wishlist with anonymous claim flow. Migration v16 adds `users.wishlist_share_token`, `trackers.is_wishlisted`, `wishlist_claims` table. Owner toggles `is_wishlisted` per tracker via TrackerDetail; Settings → Wishlist card generates a shareable `/wishlist/<token>` URL. Privacy: owner is claim-blind, public response hides `threshold_price`, anonymous claim with claim_token saved in claimer's localStorage for "I changed my mind" un-claim. [PR #27](https://github.com/andrewschultzw/price-tracker/pull/27).
- [x] **Affiliate revenue layer (Amazon).** ~~Route "Buy" clicks through Amazon Associates etc.~~ **Done 2026-05-13:** `AMAZON_AFFILIATE_TAG` env var (single global, currently `schultzsoluti-20`). Server appends `?tag=<id>` to every Amazon URL in API responses on the way out — pure helper in `server/src/lib/affiliate.ts` handles hostname-suffix matching for `amazon.com` + 14 regional TLDs, idempotent tag replacement, short-link passthrough. Applied at: tracker list, tracker detail, seller URL list (web UI), public wishlist (anonymous click-throughs). Skipped: push channels (clean URLs in notifications), email (Amazon ToS §5(b) prohibits), CSV/JSON exports (clean source data). New `GET /api/public/config` boolean drives the Amazon-canonical disclosure footer on every authenticated and public page. 18 new tests. [PR #34](https://github.com/andrewschultzw/price-tracker/pull/34). Other retailers (Best Buy, Newegg, etc.) deferred — Best Buy/Home Depot are network-blocked anyway, and Newegg's affiliate program is via Impact Radius which needs separate integration.
- [x] **Invite flow + family/friends polish.** ~~Multi-user is already there under the hood; needs onboarding polish.~~ **Done 2026-05-06:** new public `GET /api/auth/invite-info/:code` endpoint validates invite codes on Register page mount (shows inviter name when share_display_name is on, clean reason-specific error for invalid). WelcomeModal on first Dashboard visit when user has zero trackers. Per-user invite quotas (default 3 active unused, admins unlimited) via new `/api/invites/*` routes. New "Invites" Settings card visible to all users with Generate / Copy / Revoke. [PR #22](https://github.com/andrewschultzw/price-tracker/pull/22) + [PR #24](https://github.com/andrewschultzw/price-tracker/pull/24).

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
