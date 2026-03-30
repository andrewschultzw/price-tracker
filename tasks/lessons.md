# Lessons Learned

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
