# Price Tracker

> A self-hosted price tracker for anything you can link to. Multi-seller support, multiple notification channels, and a dashboard that actually respects your attention.

[![tests](https://img.shields.io/badge/tests-206%20passing-success)](./server) [![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE) [![typescript](https://img.shields.io/badge/typescript-5.9-blue)](https://www.typescriptlang.org/)

<!-- Screenshot placeholder — drop a dashboard.png in /docs/ and uncomment: -->
<!-- ![Dashboard](./docs/dashboard.png) -->

## What it is

Paste a product URL, set a target price, and get notified when the price drops. Same idea as CamelCamelCamel or Keepa but for any retailer (not just Amazon), self-hosted on your own box, and without the "email us for pricing" upsell funnel.

Built as a homelab project, designed to be portable. Runs in a single Node process with a SQLite file for storage — no external database, no Redis, no Docker orchestration required. Comfortable on a 1 vCPU / 2 GB container.

## Features

### Tracking
- **Any retailer** — six cascading extraction strategies (JSON-LD, Microdata, OpenGraph, CSS patterns, regex, user CSS selector) handle most e-commerce sites without per-site code
- **Multi-seller per product** — track the same product across Amazon, Newegg, B&H, etc. with per-seller price history and one color-coded chart per seller
- **Amazon-direct preference** — when multiple sellers compete for the Amazon buy box, prefer Amazon.com's retail offer over cheaper third-party sellers (matches what you see in your browser)
- **All-time low indicator** — see at a glance whether the current price is a real historical deal or just slightly below your arbitrary threshold
- **CSV / JSON export** of full price history per tracker

### Notifications
- **Three channels**, each optional and configurable per user:
  - **Discord** — via incoming webhook
  - **ntfy** — push notifications via [ntfy.sh](https://ntfy.sh) or a self-hosted instance, with optional Bearer token auth for private topics
  - **Generic webhook** — JSON POST to any HTTPS endpoint (Home Assistant, Slack, n8n, custom bots)
- **Per-seller cooldowns** — one seller alerting doesn't silence another seller's later drop on the same tracker
- **Manual-check bypass** — clicking "Check Now" always fires fresh notifications, regardless of cooldown
- **Notification history** — see every alert ever sent, with channel, timestamp, and savings
- **Encrypted at rest** — webhook URLs and tokens are AES-256-GCM encrypted in the database with a version-prefixed format for future key rotation

### Reliability
- **Retry with exponential backoff** on transient scrape failures (network errors, timeouts, 5xx) — 3 attempts with 1s → 3s backoff before giving up
- **Bot-check detection** for Amazon's captcha/intercept pages, automatically retried with a rotated user agent
- **Per-seller scrape state** — one broken seller doesn't take down the whole tracker
- **Manual "Check All Now"** for every errored tracker at once

### UX
- **Sort order that respects attention** — errored items first, below-target items next, rest after
- **Dynamic category views** — clicking the stat cards opens live-filtered views (deals, errors, errored tracker bulk-refresh)
- **Domain-based category collapse** — when a single retailer has more than 10 trackers, they roll up into a category card so the dashboard stays readable
- **Mobile-first** — hamburger menu, responsive charts, optimized for phone use
- **Savings celebration** — because hitting a big total savings milestone deserves confetti

### Multi-user
- **Invite-code registration** — admins generate one-time codes; no open signup
- **Per-user trackers, settings, and notification channels** — full isolation between users
- **Admin panel** — user management, tracker counts per user, invite code management

## Tech stack

### Backend
- **Node 22** + **TypeScript 5.9**
- **Express 4** for the HTTP layer
- **better-sqlite3** for storage (synchronous, no connection pool nonsense, ~10k writes/sec on a Raspberry Pi)
- **Playwright (Chromium)** for scraping — real browser, handles JS-rendered prices
- **node-cron** + **p-queue** for the scheduler with configurable concurrency
- **pino** for structured JSON logging
- **zod** for request validation
- **jsonwebtoken** + **bcrypt** for auth (httpOnly cookies)

### Frontend
- **React 19** + **Vite 8**
- **Tailwind CSS 4** with a custom dark theme
- **react-router 7** for routing
- **recharts** for the price history charts (lazy-loaded)
- **lucide-react** for icons
- **canvas-confetti** for the celebration overlay (lazy-loaded)

### Testing
- **vitest** in both workspaces
- **206 tests** covering pure logic (price parser, dashboard sort, savings tiers, canonical domains), integration (migrations, per-seller aggregation, cooldown invariants with in-memory SQLite), and notification payload shape (with mocked fetch)
- Tests are wired into the deploy pipeline so failing tests block pushes

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Single Node Process                │
│                                                         │
│  ┌───────────┐  ┌────────────┐  ┌────────────────────┐  │
│  │  Express  │  │ node-cron  │  │  Playwright pool   │  │
│  │  API + SPA│  │  scheduler │  │  (shared browser)  │  │
│  └─────┬─────┘  └──────┬─────┘  └──────────┬─────────┘  │
│        │               │                    │           │
│        └───────────────┼────────────────────┘           │
│                        │                                │
│              ┌─────────▼─────────┐                      │
│              │  better-sqlite3   │                      │
│              │  (single .db file)│                      │
│              └───────────────────┘                      │
└─────────────────────────────────────────────────────────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌────▼────┐ ┌─────▼─────┐
        │  Discord  │ │  ntfy   │ │  Generic  │
        │  webhook  │ │         │ │  webhook  │
        └───────────┘ └─────────┘ └───────────┘
```

- **One process** serves the API, the built SPA, and runs the scheduler
- **SQLite file** stores everything (users, trackers, price history, notifications, encrypted settings)
- **Playwright** shares a single browser across all scrape jobs; each job gets a fresh context with a rotated user agent
- **Scheduler** checks `tracker_urls` every minute for due sellers, respects `check_interval_minutes` per tracker

## Getting started

### Prerequisites

- **Node 22+** (uses native fetch, modern ES features)
- **~500 MB disk** for Playwright's bundled Chromium
- **~2 GB RAM** comfortable (1 GB works if you're not running many concurrent scrapes)

### Quick start

```bash
# Clone
git clone https://github.com/andrewschultzw/price-tracker.git
cd price-tracker

# Install both workspaces
(cd server && npm ci)
(cd client && npm ci)

# Install Playwright's browser (Chromium only — skip the others)
(cd server && npx playwright install chromium)

# Generate a settings encryption key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Copy and edit the env template
cp .env.example .env
# Fill in SETTINGS_ENCRYPTION_KEY, JWT_SECRET, DATABASE_PATH

# Build the client
(cd client && npm run build)

# Build the server
(cd server && npm run build)

# Start
(cd server && npm start)
```

First-run setup: on first start with no users, the server logs a one-time setup URL to stdout:

```
FIRST-RUN SETUP: No users found. Create your admin account:
http://localhost:3100/setup?token=<setup-token>
```

Open that URL, create your admin account, and you're in.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | — | `3100` | HTTP listen port |
| `DATABASE_PATH` | yes (prod) | `./data/price-tracker.db` | SQLite file path. **Use an absolute path in production** — systemd services run from `WorkingDirectory` and a relative path will land in an unexpected place. |
| `JWT_SECRET` | **yes (prod)** | dev placeholder | Signs JWT access/refresh tokens. Generate with `openssl rand -hex 64`. Fail-fast in production if unset. |
| `SETTINGS_ENCRYPTION_KEY` | **yes (prod)** | — | AES-256-GCM key for encrypting webhook URLs and tokens at rest. Accepts either a base64-encoded 32-byte key (preferred, high entropy) or any passphrase (SHA-256'd to 32 bytes). Fail-fast in production if unset. |
| `NODE_ENV` | — | `development` | Set to `production` to enable fail-fast checks |
| `SCRAPE_MAX_RETRIES` | — | `2` | Number of retry attempts on transient scrape failures |
| `SCRAPE_RETRY_BASE_MS` | — | `1000` | Base delay for exponential backoff (doubled each attempt) |

Example `.env`:

```ini
PORT=3100
DATABASE_PATH=/opt/price-tracker/data/price-tracker.db
JWT_SECRET=<64 random hex chars>
SETTINGS_ENCRYPTION_KEY=<32-byte base64>
NODE_ENV=production
```

### systemd unit

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

### Reverse proxy

Works behind any reverse proxy. The auth flow uses httpOnly cookies so make sure your proxy forwards them correctly. Example Nginx snippet:

```nginx
location / {
    proxy_pass http://127.0.0.1:3100;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## Usage

### Adding your first tracker

1. Log in
2. Click **Add Tracker**
3. Paste a product URL
4. Set a target price (optional)
5. Pick a check interval (hourly, 6h, daily, etc.)
6. Save — the server scrapes immediately so you see a current price right away

### Multiple sellers per product

On the tracker detail page, scroll to the **Sellers** section. Paste a second URL pointing to the same product at a different retailer (or a different listing at the same retailer) and hit **Add Seller**. The new URL scrapes immediately and joins the per-seller chart.

The dashboard card shows the lowest current price across all your sellers with a "lowest @ retailer.com" indicator. The chart on the detail page draws one color-coded line per seller.

### Notification setup

Open **Settings**. Configure any combination of:

- **Discord** — paste a channel webhook URL from Server Settings → Integrations → Webhooks
- **ntfy** — paste a topic URL (e.g. `https://ntfy.sh/my-long-unguessable-topic`), install the ntfy app on your phone, subscribe to the same topic. Optional access token for self-hosted deny-all instances.
- **Generic webhook** — any HTTPS endpoint that accepts a JSON POST. The payload shape is documented on the Settings page.

Each channel has its own Save and Test button so you can verify the wiring before committing.

### Dashboard views

- **Default** — all trackers, sorted errored → below-target → active → paused
- **Below Target** (click the green stat card) — live list of trackers currently at or below their threshold, sorted by biggest savings first
- **Errors** (click the red stat card) — every errored tracker with a "Check All Now" button to bulk-refresh
- **Category view** — when you have more than 10 trackers at a single retailer, clicking the category card shows just that retailer's trackers
- **Potential Savings** (click the amber stat card) — confetti

## Development

### Project structure

```
price-tracker/
├── server/              # Node + Express backend
│   ├── src/
│   │   ├── auth/        # JWT + bcrypt
│   │   ├── crypto/      # AES-256-GCM for settings at rest
│   │   ├── db/          # queries, schema, migrations
│   │   ├── notifications/  # discord, ntfy, webhook senders
│   │   ├── routes/      # Express handlers
│   │   ├── scheduler/   # cron + per-seller scrape orchestration
│   │   ├── scraper/     # Playwright + extraction strategies
│   │   └── util/        # CSV, slug helpers
│   └── package.json
│
├── client/              # React + Vite frontend
│   ├── src/
│   │   ├── components/  # TrackerCard, StatCards, PriceChart, etc.
│   │   ├── context/     # AuthContext
│   │   ├── lib/         # Pure helpers (dashboard-sort, domains, tiers)
│   │   ├── pages/       # Route components
│   │   └── types.ts
│   └── package.json
│
├── scripts/             # deploy.sh, rebuild.sh
└── package.json         # Workspace orchestration
```

### Running locally

```bash
# Terminal 1: server in watch mode
cd server && npm run dev

# Terminal 2: client dev server (Vite, with HMR)
cd client && npm run dev
```

The Vite dev server proxies `/api/*` to `http://localhost:3100` automatically. Open `http://localhost:5173`.

### Running tests

```bash
# All server tests
cd server && npm test

# All client tests
cd client && npm test

# Watch mode
cd server && npm run test:watch
```

### Adding a new scrape strategy

1. Create `server/src/scraper/strategies/my-strategy.ts` exporting `extractFromMyStrategy(html: string): number | null`
2. Add it to the pipeline in `server/src/scraper/extractor.ts` in the desired priority order
3. Write a test in `server/src/scraper/strategies/my-strategy.test.ts` with a fixture HTML snippet
4. Run `npm test` to verify

### Building for production

```bash
npm run build        # builds client + server from the root
```

Or individually:

```bash
npm run build:client
npm run build:server
```

The server expects the built client at `../client/dist` relative to its `WorkingDirectory`. Static files are served by Express in production; the client dev server is only for local HMR.

## Roadmap

Planned but not yet built:

- **Email notification channel** — fourth channel using SMTP
- **OpenClaw / Discord bot integration** — accept product links in Discord to create trackers automatically
- **Cross-user tracker overlap** — "N others also track this" indicator when multiple users track the same product
- **Bulk add** — paste a list of URLs at once

See [`tasks/todo.md`](./tasks/todo.md) for the full open list.

## Security notes

- **Webhook URLs are encrypted at rest** with AES-256-GCM. A leaked SQLite backup can't be used to spam your Discord channel or publish to your ntfy topic without the encryption key.
- **JWT tokens** live in httpOnly cookies (not localStorage) to mitigate XSS token theft.
- **Invite-only registration** — no public signup path.
- **Passwords** hashed with bcrypt (12 rounds).
- **Fail-fast on missing secrets in production** — the server refuses to start if `JWT_SECRET` or `SETTINGS_ENCRYPTION_KEY` is unset with `NODE_ENV=production`.
- **Favicons are proxied** through the server (not fetched directly from Google), so your retailer list doesn't leak to a third party on every dashboard load.

## Contributing

Pull requests welcome. Before you start:

1. Open an issue for anything non-trivial so we can discuss scope first
2. Run `npm test` in both workspaces — failing tests block the merge
3. Match the existing code style (no tool enforcement yet, just taste)
4. Keep commit messages descriptive — this repo uses conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `chore:`)

## License

MIT — see [LICENSE](./LICENSE)

## Acknowledgments

Built with [Claude Code](https://claude.com/claude-code) as a pair-programming partner. Most commits include a `Co-Authored-By: Claude` trailer reflecting the collaboration pattern.
