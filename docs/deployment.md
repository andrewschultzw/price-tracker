# Deployment Guide — Price Tracker

## Infrastructure

| Component | Location |
|-----------|----------|
| Dev machine | CT 300 (192.168.1.164) |
| Production server | CT 302 (192.168.1.166) |
| Domain | prices.schultzsolutions.tech |
| Reverse proxy | NPM on CT 100 |
| Code repo | /root/price-tracker (CT 300) |
| Production install | /opt/price-tracker (CT 302) |

## Production Layout (CT 302)

```
/opt/price-tracker/
  .env                        # All env vars (single source of truth)
  scripts/
    deploy.sh                 # Run from CT 300 to deploy
    rebuild.sh                # Run on CT 302 by deploy.sh
  server/
    dist/                     # Compiled server JS
    node_modules/
    package.json
  client/
    dist/                     # Built frontend SPA
    node_modules/
    package.json
  data/
    price-tracker.db          # SQLite database (persists through deploys)

/opt/price-tracker-backups/   # Auto DB backups (last 10 kept)
```

## Environment Variables

All env vars live in `/opt/price-tracker/.env`. The systemd service loads them via `EnvironmentFile=`.

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | Yes | Server port (3100) |
| `DATABASE_PATH` | Yes | **Absolute path** to SQLite DB (`/opt/price-tracker/data/price-tracker.db`) |
| `NODE_ENV` | Yes | `production` in prod |
| `JWT_SECRET` | Yes (prod) | 64-char hex string for signing JWTs. Generate with `openssl rand -hex 32` |
| `DISCORD_WEBHOOK_URL` | No | Deprecated — users now configure webhooks per-account in the app |

**Important:** `DATABASE_PATH` must be an absolute path. The systemd service runs with `WorkingDirectory=/opt/price-tracker/server`, so relative paths resolve from there, not the project root.

## Systemd Service

**Location:** `/etc/systemd/system/price-tracker.service`

```ini
[Unit]
Description=Price Tracker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/price-tracker/server
EnvironmentFile=/opt/price-tracker/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Key points:**
- `EnvironmentFile` is the single source of truth for env vars — do NOT add `Environment=` lines
- `WorkingDirectory` is `/opt/price-tracker/server` (where `dist/index.js` lives)
- Service auto-restarts on failure with 5s delay

**Commands:**
```bash
systemctl status price-tracker       # Check status
systemctl restart price-tracker      # Restart
systemctl stop price-tracker         # Stop
journalctl -u price-tracker -f       # Tail logs
journalctl -u price-tracker -n 50    # Last 50 log lines
```

## Deploy Process

From CT 300:

```bash
cd /root/price-tracker
bash scripts/deploy.sh
```

**What it does:**
1. Builds server (`tsc`) and client (`vite build`) locally on CT 300
2. Rsyncs everything to CT 302 (excludes: `node_modules`, `.git`, `data`, `.env`, `.worktrees`)
3. SSHes to CT 302 and runs `scripts/rebuild.sh`

**What rebuild.sh does on CT 302:**
1. Backs up the DB to `/opt/price-tracker-backups/` (keeps last 10)
2. `npm ci` + `npm run build` for server
3. `npm ci` + `npm run build` for client
4. `systemctl restart price-tracker`

## Database

- **Engine:** SQLite via better-sqlite3
- **Location:** `/opt/price-tracker/data/price-tracker.db`
- **Pragmas:** WAL mode, foreign keys ON
- **Backups:** Auto-backup before each deploy to `/opt/price-tracker-backups/`
- **Migrations:** Run automatically on server start via `db/migrations.ts` (version tracked in `schema_migrations` table)

## Auth System

- JWT access tokens (15 min) + refresh tokens (30 days) in httpOnly cookies
- Invite-only registration — admin generates invite codes from the Admin panel
- First-run: server logs a one-time setup URL to stdout for creating the admin account

## Adding a New Env Var

1. Add to `/opt/price-tracker/.env` on CT 302
2. Restart: `systemctl restart price-tracker`
3. No need to edit the systemd service file

## First-Time Setup (new server)

1. Clone repo and run `scripts/deploy.sh`
2. SSH to CT 302, create `.env` with required vars (generate `JWT_SECRET` with `openssl rand -hex 32`)
3. Restart service, check logs for the setup URL: `journalctl -u price-tracker -n 20`
4. Visit the setup URL to create the admin account
5. Configure reverse proxy (NPM on CT 100) to point `prices.schultzsolutions.tech` to `192.168.1.166:3100`

## Push-to-deploy (webhook)

Merging to `main` triggers CI. When CI passes, GitHub sends a `workflow_run`
webhook to the `deploy-listener` on CT 302, which rebuilds and restarts the app.

**Flow:** push → CI (GitHub-hosted) → `workflow_run` webhook → CF tunnel → NPM
(`pt-deploy.schultzsolutions.tech`) → `127.0.0.1:9000` listener → verify HMAC +
CI/success/main → `scripts/deploy-local.sh <sha>` (checkout SHA, build server +
client, back up DB, restart, verify live bundle).

**Break-glass (manual):** if the webhook chain is down, deploy from CT 300 with
`scripts/deploy.sh` exactly as before — it is unchanged.

**Listener logs:** `journalctl -u price-tracker-deploy -f` on CT 302.

**Environment:** the listener reads `/opt/price-tracker-deploy/.env`
(`DEPLOY_WEBHOOK_SECRET`, `DEPLOY_PORT`, `DEPLOY_REPO_ROOT`, `DEPLOY_PUBLIC_URL`).
`deploy-local.sh` also honors `DEPLOY_PUBLIC_URL` (defaults to the prod URL).

### CT 302 deploy-listener setup (one-time)

Run in order. These are operational steps against CT 302 (`root@192.168.1.166`).

1. **Convert `/opt/price-tracker` to a clean clone tracking `origin/main`**
   (it is currently a local-only repo with no remote). Preserve `data/` and the
   `.env` files (all gitignored):
   ```bash
   systemctl stop price-tracker
   cd /opt
   cp -a price-tracker/data /opt/pt-data.bak
   cp price-tracker/.env /opt/pt-server.env.bak
   mv price-tracker price-tracker.old.$(date +%s)
   git clone https://github.com/andrewschultzw/price-tracker.git price-tracker
   cd price-tracker && rm -rf data && mv /opt/pt-data.bak data && cp /opt/pt-server.env.bak .env
   ```

2. **Create `client/.env`** with the public VAPID key (safe to store — it ships
   to browsers): `VITE_VAPID_PUBLIC_KEY=<value>` in `/opt/price-tracker/client/.env`.

3. **Create the listener secret env** (mode 600):
   ```bash
   mkdir -p /opt/price-tracker-deploy
   SECRET=$(openssl rand -hex 32)
   cat > /opt/price-tracker-deploy/.env <<ENV
   DEPLOY_WEBHOOK_SECRET=$SECRET
   DEPLOY_PORT=9000
   DEPLOY_REPO_ROOT=/opt/price-tracker
   DEPLOY_PUBLIC_URL=https://prices.schultzsolutions.tech
   ENV
   chmod 600 /opt/price-tracker-deploy/.env
   echo "$SECRET"   # copy into the GitHub webhook config
   ```

4. **Build + install/enable services:**
   ```bash
   cd /opt/price-tracker
   ( cd server && npm ci --no-audit --no-fund && npm run build )
   ( cd client && npm ci --no-audit --no-fund && npm run build )
   cp scripts/price-tracker-deploy.service /etc/systemd/system/
   systemctl daemon-reload
   systemctl enable --now price-tracker price-tracker-deploy
   ```

5. **Add the NPM proxy host** `pt-deploy.schultzsolutions.tech` → `127.0.0.1:9000`
   (HTTP, wildcard SSL).

6. **Register the GitHub webhook** (use the secret from step 3):
   ```bash
   gh api -X POST repos/andrewschultzw/price-tracker/hooks \
     -f name=web -F active=true -f 'events[]=workflow_run' \
     -f config.url=https://pt-deploy.schultzsolutions.tech/hook \
     -f config.content_type=json -f config.secret='<SECRET>'
   ```
