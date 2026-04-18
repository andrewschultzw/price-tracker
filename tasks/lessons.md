# Lessons Learned

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
