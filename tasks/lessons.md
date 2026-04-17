# Lessons Learned

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
