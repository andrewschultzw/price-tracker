# price-tracker

Self-hosted product price tracker: scrapes retailer prices on a cron schedule, charts history, and notifies on drops. TypeScript monorepo — Express/SQLite/Playwright API + React/Vite SPA.

## Stack
- **server/** — Node + Express 4, TypeScript (ESM), better-sqlite3, Playwright (Chromium), pino, JWT (jsonwebtoken + bcrypt), node-cron, zod. Tests: vitest.
- **client/** — React 19, Vite 8, TypeScript, react-router-dom 7, Tailwind CSS 4 (`@tailwindcss/vite`), recharts, lucide-react. Tests: vitest. Lint: eslint.
- Two npm packages with separate `node_modules`; install each with `npm ci` in its own dir. No Python despite GitHub's "HTML" label (that's `client/index.html`).

## Commands (run inside the relevant package dir)
- Install: `(cd server && npm ci)` and `(cd client && npm ci)`
- **Playwright browser (required, ~500MB):** `(cd server && npx playwright install chromium)`
- Server dev: `cd server && npm run dev` (tsx watch, port 3100)
- Client dev: `cd client && npm run dev` (Vite; proxies `/api` → localhost:3100) — root `npm run dev` starts ONLY the server, so run the client separately
- Build all: `npm run build` (root — client then server)
- Server tests: `cd server && npm test` (`vitest run`) · Client tests: `cd client && npm test`
- Client lint: `cd client && npm run lint`
- Prod start: `cd server && npm start` (`node dist/index.js`, build first)

## Structure
- `server/src/index.ts` — API entry · `client/src/main.tsx`/`App.tsx` — SPA entry
- `server/src/scraper/` — Playwright fetch (`browser.ts`) + extraction (`extractor.ts`, `strategies/`)
- `server/src/db/` — queries, schema, migrations · `server/src/routes/`, `notifications/`, `scheduler/cron.ts`, `crypto/`
- `docs/deployment.md` — systemd/reverse-proxy deploy notes

## Conventions & gotchas
- DB migrations run automatically on server start (`db/migrations.ts`, tracked in `schema_migrations`).
- First run with no users: server logs a one-time `FIRST-RUN SETUP` URL w/ token to stdout — open it to create the admin.
- **Scraper is fragile, regression-tested.** Amazon: prefer Amazon-direct seller (`ATVPDKIKX0DER`) and `apex-pricetopay-accessibility-label` over generic `a-offscreen` (the "Husq Chainsaw" multi-seller bug). Bot-check detection lives in `browser.ts`. Don't touch `scraper/` without running `scraper/strategies/css-patterns.test.ts`.
- Plausibility guard in `extractor.ts`: prices outside `0.01..999999` are rejected, next strategy tried.

## Env (see `.env.example`)
- `PORT` (3100), `DATABASE_PATH` — **must be absolute in production** (systemd WorkingDirectory).
- `JWT_SECRET`, `SETTINGS_ENCRYPTION_KEY` — required when `NODE_ENV=production` (server fail-fasts if unset).
- `SETTINGS_ENCRYPTION_KEY` is AES-256-GCM for webhook URLs/tokens at rest; **rotation is unimplemented** — changing it bricks existing encrypted settings.
- `SCRAPE_MAX_RETRIES` (2), `SCRAPE_RETRY_BASE_MS` (1000) — transient-failure backoff (4xx fails fast).
