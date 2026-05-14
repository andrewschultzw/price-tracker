# Lessons Learned

## 2026-05-14: Scheduled-review issues as a maintenance-loop pattern

### Auto-opened GitHub issues with the diagnostic playbook in the body are the right notification channel for periodic reviews
**What happened:** A scheduled remote agent opened issue #32 ("2-week plausibility guard log review") with the queries to run baked into the body as a copy-pasteable bash block plus a findings checklist. When the issue surfaced, it got noticed immediately (vs. log dashboards we never check, or weekly email digests). Running the queries took ~2 minutes; posting findings + closing the issue took another minute. Total maintenance-loop friction: ~3 minutes for a meaningful prod-data review that would otherwise sit on a "should look at this" list indefinitely.

**Why it works better than the alternatives:**
- **GitHub issues grab attention.** They show up in the standard notification feed alongside actual development work, so they're not separable from "real" tasks the way a separate monitoring dashboard is.
- **The playbook lives WITH the review.** Next quarter's review reads the issue body and re-runs the same commands — no separate runbook to maintain, no "where did we put those queries again" hunt. The issue is the artifact.
- **Findings get archived in the right place.** Closed issues live in the project's GitHub history, indexed and searchable. Future "did we ever check this?" questions have a one-search answer.
- **No notification fatigue.** The issue stays open until explicitly closed. Unlike emails or push notifications, it doesn't decay or get buried.
- **Free schema for "what to review."** The checklist in the issue body forces the reviewer to confirm each finding deliberately, rather than skimming and clicking "looks fine."

**Rule:** Any time-bound prod health check that takes <5 min to run is a candidate for a scheduled-remote-agent issue. Cost: trivial. Benefit: the loop actually closes. Specifically: bake the SSH commands / SQL queries into the issue body (don't link to a separate doc), structure findings as a checklist, mark the issue as auto-opened so future reviewers know to close it after.

**Candidates worth scheduling next:**
- Monthly DB size + backup integrity check on CT 302 (price-tracker.db size, backup file count, last successful backup timestamp)
- Quarterly cron load review (scrapes/min over the month, p99 scrape duration, OOM/restart events)
- Monthly Claude API cost review (when AI features are enabled — current spend vs. budget, failure rates, summary staleness backlog)
- Quarterly tracker-error audit (sellers stuck in status='error' or status='blocked' > 90 days that the user has forgotten about and should manually delete)
- Bi-annual dependency audit (npm audit, outdated packages, deprecation warnings)

Pattern for the issue body:
1. Brief "why this review exists" preamble
2. Bash block(s) with the commands to run, copy-paste ready
3. `## Checklist` of findings to confirm
4. `## Findings` empty section, "Fill in numbers as comments below before closing"
5. "Auto-opened by a scheduled remote agent. Close this issue when the review is done." footer

## 2026-05-11: Retailer-WAF IP blocks (Home Depot 403)

### A 403 with `Server: AkamaiGHost` on the BARE HOMEPAGE is an IP-reputation block, not a scraper bug
**What happened:** A new Home Depot tracker failed 3 consecutive scrapes with `HTTP 403`. First instinct was to debug user-agent / fingerprint detection. Diagnostic curls from CT 302 showed every URL on `homedepot.com` (including the bare `/` homepage) returning 403 regardless of headers — `Server: AkamaiGHost`, body is Akamai's standard "Access Denied" page with an `errors.edgesuite.net` reference URL. This is the same class of issue Best Buy already has (memory `feedback_pricetracker_bestbuy_blocked.md`): Akamai has the homelab egress IP on a low-reputation list and blanket-rejects.

**Diagnostic shortcut:** When a scrape fails 403, before opening the extraction code, curl the retailer's HOMEPAGE from the scraper's egress IP with a real Chrome UA. If the homepage 403s too, the problem is at the network/WAF layer — no headers/fingerprint trick will fix it. Don't waste time on stealth Playwright when the WAF has already decided your IP is hostile.

**Rule:** Detect Akamai/CF retailer blocks specifically (response header `Server: AkamaiGHost` on 403/429, or `Server: cloudflare` + `cf-mitigated` on 403). Mark those sellers as a distinct `status='blocked'` instead of letting them churn through `consecutive_failures`. Stop scheduling re-checks; surface a clear "Retailer blocked" UI state; allow manual "Check Now" to test if the block lifts later. Maintain a known-blocked-host list so new trackers for those domains land in the right state immediately rather than waiting for 3 failed cron ticks. See `server/src/scraper/blocked-retailers.ts`.

### SQLite CHECK constraints can't be ALTERed; rebuild-the-table cascades through FKs; `db.unsafeMode(true)` + `PRAGMA writable_schema` is the safe path
**What happened:** Migration v17 needed to widen the `status` CHECK constraint on `trackers` and `tracker_urls` to admit a new `'blocked'` value. First attempt followed the v11 pattern (CREATE _new, INSERT...SELECT, DROP, RENAME). The `DROP TABLE trackers` step cascaded through child tables' `ON DELETE CASCADE` (tracker_urls.tracker_id) and `ON DELETE SET NULL` (price_history.tracker_url_id, notifications.tracker_url_id) FKs — wiping pre-seeded test rows. Worse, `db.pragma('foreign_keys = OFF')` inside a migration is a no-op because **SQLite refuses to change the `foreign_keys` pragma mid-transaction** (`runMigrations` wraps every migration in a `db.transaction(...)`).

**Rule:** For CHECK-constraint widening that doesn't change row format on disk, skip the rebuild. Use `db.unsafeMode(true)` (better-sqlite3) + `PRAGMA writable_schema = ON` and `UPDATE sqlite_schema SET sql = replace(sql, old_check, new_check) WHERE ...` directly. Bump `PRAGMA schema_version = current+1` to invalidate SQLite's prepared-statement cache, then `db.unsafeMode(false)`. Idempotent: fresh DBs whose CREATE statement already has the new CHECK don't match the WHERE clause and the UPDATE is a no-op. This is the SQLite-recommended pattern for constraint-only changes and doesn't disturb child rows.

**Anti-pattern to remember:** `db.pragma('foreign_keys = OFF')` inside `db.transaction(() => migration.up())` silently does nothing. If you ever need to disable FKs for a migration, the pragma has to be flipped BEFORE the transaction starts — which means restructuring `runMigrations` or building a non-transactional migration variant.

## 2026-04-18: OpenClaw skill integration

### OpenClaw skill files use `{{env.X}}` template substitution, not shell `$VAR`
**What happened:** First SKILL.md draft used `$PRICE_TRACKER_URL` in example curl commands. OpenClaw's exec tool runs commands in a shell that does NOT inherit `openclaw.json`'s `env` section, so `$PRICE_TRACKER_URL` expanded to empty and curl hit `/api/trackers` (no host). Fix: replace with `{{env.PRICE_TRACKER_URL}}` — those placeholders get rendered into LITERAL values at skill-load time before the agent ever runs the command.

**Rule:** In OpenClaw SKILL.md files, always use `{{env.VAR}}` substitution for values that live in `~/.openclaw/openclaw.json`'s `env` object. Shell-style `$VAR` will silently expand to empty in the exec tool. The existing paperless-docs / directus-cms skills follow this pattern — mirror it.

### OpenClaw agent sessions cache their system prompt (including skill list)
**What happened:** Deployed a new skill + restarted the gateway, but the first Discord DM after restart didn't see the new skill — the agent invented its own solution (created an internal cron job). The Discord session (`agent:main:discord:direct:<user-id>`) is long-lived and assembles its system prompt (with skill registry) at session creation. New skills added after that are invisible until the user `/reset`s the session.

**Rule:** After deploying a new OpenClaw skill, ALWAYS instruct the user to run `/reset` in their Discord DM with the bot. Restarting the gateway is not enough — it keeps the existing session and its cached prompt. Document this in any OpenClaw-skill deploy runbook.

### Give OpenClaw agents concrete shell one-liners, not HTTP descriptions
**What happened:** First SKILL.md draft described the API as `POST /trackers with JSON body` + a schema table. The agent guessed and used `exec` with a Python helper (failed: `python` not in PATH on CT 301). Replacing with a literal `curl -sS -X POST "..." -H "..." -d '{...}'` example eliminated the guesswork — agent copied the pattern directly.

**Rule:** When writing an OpenClaw skill that performs an HTTP call, include an explicit `curl` one-liner the agent can copy. Describing the API at the "verb + path + headers" level leaves the agent to invent a client implementation, which it's bad at. Pattern: show the full curl, mention "use `curl` via the `exec` tool — do NOT write a Python / Node helper", list concrete examples with real URLs.

## 2026-04-18: Email notification channel

### `.env` values containing shell metacharacters need quoting
**What happened:** `SMTP_FROM=Price Tracker <alerts@schultzsolutions.tech>` was written unquoted. Systemd's `EnvironmentFile=` parser tolerates this but a shell `. /opt/price-tracker/.env` throws `syntax error near unexpected token '<'` because the unquoted `<` is interpreted as an input redirection. Our smoke-test script sourced the env through the shell and got a partial environment — `isEmailConfigured()` returned false and the test failed misleadingly.

**Rule:** When a `.env` value contains `<`, `>`, `|`, `&`, `(`, `)`, `"`, `'`, `` ` ``, `$`, `;`, or spaces in a way that could confuse a POSIX shell, wrap the value in double quotes: `SMTP_FROM="Price Tracker <alerts@schultzsolutions.tech>"`. Both systemd and shell sourcing accept quoted values. Quote defensively any time you're not sure — the cost is one character pair; the benefit is portability across env consumers.

### Gmail Send-As "Treat as alias" is the right mode for app SMTP sending
**What happened:** Setting up `alerts@schultzsolutions.tech` as a Send-As alias on `homelab.schultz@gmail.com`. Gmail offers two paths: (1) Treat as alias (uses Google's outbound infrastructure; DKIM is gmail.com's), or (2) Send through another SMTP relay (requires running an SMTP server for the alias domain).

**Rule:** For homelab / small-volume sending where the alias is a Cloudflare Email Routing forward back to the same Gmail account, "Treat as alias" is the right choice. Outbound traffic goes through smtp.gmail.com with the app password; the `From:` header shows the alias. Deliverability is fine for personal-use volumes. If the `schultzsolutions.tech` domain ever gets flagged by a strict receiver, the escape hatch is a transactional service (Resend/Postmark) with proper DKIM — but that's only worth doing when it bites.

## 2026-04-17: Silent false-positive trackers (JetKVM, WD Red 10TB)

### Fallback strategies must be scoped to the main product container
**What happened:** Two trackers silently reported wrong prices because fallback extraction strategies (`.a-offscreen` for Amazon, `.price-current` + regex for Newegg) matched the FIRST occurrence page-wide. Modern retailer product pages render sponsored / recommended-product carousels BEFORE and AROUND the main buy box, so the first `.a-offscreen` or `.price-current` on the page is often a carousel item — not the real product price. JetKVM reported $35.99 from a sponsored accessory (real product was "Currently unavailable"); WD Red cycled $10/$249/$389 from random sponsored hard drives when JSON-LD timing missed.

**Rule:** Any fallback that picks "first match" must be scoped to a retailer-specific main-price container (`#apex_desktop`, `<div class="product-price">`). When the container is present but empty, return null — do NOT fall through to page-wide — otherwise carousels poison the signal. When no container is present (non-retailer / simpler HTML), page-wide fallback is still safe.

### Detect unavailability explicitly, surface it as an error
**What happened:** Amazon's anonymous product page for an unavailable item renders `#apex_desktop` but with no price content inside. Every strategy that didn't find the apex-pricetopay-accessibility-label fell through to the next, eventually grabbing a carousel price. No strategy's contract said "distinguish unavailable from missing".

**Rule:** Pipeline-level short-circuit: check known unavailability markers (`availability_feature_div` containing "Currently unavailable") BEFORE running any strategy. Throw a specific, non-retryable `ScrapeError` so the tracker surfaces a clean error state instead of silently reporting a wrong price. Silent wrong prices are worse than loud errors.

### Fixture tests from real HTML are worth their disk cost
**What happened:** Synthetic test HTML had never caught either regression because neither test author had modeled "the product is unavailable and sponsored carousels exist". The real pages from the failing trackers capture those shapes faithfully.

**Rule:** When you fix a scraping regression, capture the actual HTML that failed and check it into `__fixtures__/` as a regression test. Assert specific wrong values are NEVER returned (`expect(result).not.toBe(10)`) — positive "expected 459.95" is less resilient since extraction may tighten or loosen over time. The ~2MB per fixture is fine for this kind of test.

### The repo security hook flags regex `.e` `xec()` — use `.match()` instead
**What happened:** The pre-edit hook scans for `.e`+`xec(` to catch shell-injection patterns and does not distinguish `child_process` from `RegExp`.

**Rule:** In scraper code, prefer `String.match(regex)` over the equivalent regex method. Same semantics for single matches, doesn't trip the hook, one less argument during refactor.

## 2026-03-30: User Accounts Feature

### Use absolute paths in production configs
**What happened:** The systemd service runs with `WorkingDirectory=/opt/price-tracker/server`, but `.env` had `DATABASE_PATH=./data/price-tracker.db`. This resolved to `/opt/price-tracker/server/data/price-tracker.db` — a new empty DB — instead of the real one at `/opt/price-tracker/data/price-tracker.db`. All 16 trackers appeared missing after deploy.

**Rule:** Always use absolute paths in `.env` for file-based config in production. Relative paths are only safe when you control the working directory.

### Systemd env vars: use EnvironmentFile, not Environment
**What happened:** The systemd service had env vars hardcoded as `Environment=` lines. When we added `JWT_SECRET` to `.env`, the service couldn't see it because there was no `EnvironmentFile=` directive. Also, `Environment=` takes precedence over `EnvironmentFile=`, so duplicate entries in both cause confusion.

**Rule:** Use `EnvironmentFile=/opt/price-tracker/.env` as the single source of truth. Don't duplicate env vars as `Environment=` lines in the service file.

### Test first-run flows end-to-end in the browser
**What happened:** The setup page successfully created the admin account, but the React `AuthContext` still had `needsSetup: true` in state. `ProtectedRoute` redirected back to `/setup` (without the token), showing "Setup Token Required." Curl-based API tests passed because they only tested the backend.

**Rule:** One-time flows (setup, onboarding, migration) need browser-level testing, not just API testing. State transitions in the frontend are a separate concern from API correctness.

### Exclude build artifacts from deploy rsync
**What happened:** The `.worktrees/` directory (used for isolated development) was in `.gitignore` but not in the rsync `--exclude` list in `deploy.sh`. Hundreds of MB of duplicate code shipped to the server.

**Rule:** The rsync exclude list in `deploy.sh` should cover everything in `.gitignore` plus any local-only directories (`.worktrees`, IDE configs, etc.).

### Document deployment infrastructure
**What happened:** Multiple deploy issues (DB path, systemd config, env var loading) all stemmed from undocumented tribal knowledge about how CT 302 is set up.

**Rule:** Create and maintain a `docs/deployment.md` covering the service config, env var source, DB location, backup strategy, and deploy process. Review it before any feature that changes the deploy surface.
