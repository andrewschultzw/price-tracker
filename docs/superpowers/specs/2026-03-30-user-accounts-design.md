# User Accounts & Authentication Design

**Date:** 2026-03-30
**Status:** Approved
**Author:** Andrew Schultz + Claude

## Overview

Add multi-user support to Price-Tracker with fully isolated data per user, invite-only registration, and JWT-based authentication via httpOnly cookies. Replaces the existing Cloudflare Zero Trust gate with app-level auth.

## Decisions

- **Data model:** Fully isolated -- each user has their own trackers, price history, settings, and notifications. No shared data.
- **Registration:** Invite-only. Admin generates invite codes; users register with a valid code.
- **Auth mechanism:** JWT access tokens (15 min) + refresh tokens (30 days) in httpOnly secure cookies.
- **Auth library:** Roll our own with bcrypt + jsonwebtoken + cookie-parser (no Passport, no external auth service).
- **Cloudflare Zero Trust:** Remove entirely. App handles its own auth.
- **Notifications:** Per-user. Each user configures their own Discord webhook.
- **Admin:** In-app admin panel for managing users and invite codes.

## Database Schema Changes

### New Tables

#### `users`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| email | TEXT UNIQUE NOT NULL | Login identifier |
| password_hash | TEXT NOT NULL | bcrypt hash (12 rounds) |
| display_name | TEXT NOT NULL | Shown in UI |
| role | TEXT NOT NULL | `admin` or `user` |
| is_active | INTEGER NOT NULL | 1 = active, 0 = deactivated (default 1) |
| created_at | TEXT NOT NULL | ISO timestamp |
| updated_at | TEXT NOT NULL | ISO timestamp |

#### `invite_codes`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| code | TEXT UNIQUE NOT NULL | 24-char hex token |
| created_by | INTEGER FK | References users.id |
| used_by | INTEGER FK | Nullable, set on registration |
| expires_at | TEXT | Optional expiration |
| created_at | TEXT NOT NULL | ISO timestamp |

#### `refresh_tokens`

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| user_id | INTEGER FK NOT NULL | References users.id, CASCADE delete |
| token_hash | TEXT UNIQUE NOT NULL | SHA-256 hash of refresh token |
| expires_at | TEXT NOT NULL | Expiration timestamp |
| created_at | TEXT NOT NULL | ISO timestamp |

#### `schema_migrations`

| Column | Type | Notes |
|--------|------|-------|
| version | INTEGER PK | Migration version number |
| applied_at | TEXT NOT NULL | ISO timestamp |

Replaces the previous approach of storing schema version in the `settings` table, which conflicts with per-user settings.

### Existing Table Changes

- **`trackers`**: Add `user_id INTEGER` FK referencing `users.id` with `ON DELETE CASCADE`. Starts nullable for migration, enforced as NOT NULL at the application layer (all new trackers require a user_id). See Migration Strategy for details.
- **`settings`**: Restructured from single-key PK to composite PK `(user_id, key)`. In SQLite this requires recreating the table (create new, copy data, drop old, rename). System-level settings (like `schema_version`) are removed from this table -- see `schema_migrations` table above.
- **`notifications`**: No direct change -- inherits user isolation through tracker ownership. Trackers cascade-delete when a user is deleted, which cascade-deletes their notifications. All notification queries must join through `trackers` to enforce user isolation (no direct `user_id` column on this table).

## Auth Flow

### Token Strategy

- **Access token:** JWT, 15-minute expiry, httpOnly secure cookie. Payload: `{ userId, email, role }`.
- **Refresh token:** Random 64-byte hex string, 30-day expiry, httpOnly secure cookie. Stored as SHA-256 hash in `refresh_tokens` table. Rotated on each use.
- **Cookie attributes:** `HttpOnly`, `SameSite=Strict` on both cookies. `Secure` flag is conditional on `NODE_ENV=production` (browsers reject `Secure` cookies over HTTP during local development).

### API Endpoints

#### Auth Routes (`routes/auth.ts`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register with email, password, display name, invite code |
| POST | `/api/auth/login` | Login with email + password |
| POST | `/api/auth/logout` | Clear cookies, delete refresh token |
| POST | `/api/auth/refresh` | Rotate tokens using refresh cookie |
| GET | `/api/auth/me` | Get current user info |

#### Admin Routes (`routes/admin.ts`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/users` | List all users |
| PATCH | `/api/admin/users/:id` | Update user (deactivate, change role) |
| DELETE | `/api/admin/users/:id` | Delete user and all their data (refuses if last active admin) |
| POST | `/api/admin/invites` | Create invite code |
| GET | `/api/admin/invites` | List all invite codes |
| DELETE | `/api/admin/invites/:id` | Revoke unused invite code |

### Middleware

- **`authMiddleware`**: Runs on all `/api/*` routes except `/api/auth/login`, `/api/auth/register`, `/api/auth/refresh`, and `/api/health`. Verifies access token, attaches `req.user`. Does NOT re-check `is_active` on every request (accepts the 15-min access token window for deactivated users -- acceptable tradeoff for avoiding a DB hit on every request).
- **`adminMiddleware`**: Checks `req.user.role === 'admin'`. Applied to all `/api/admin/*` routes.

**`is_active` enforcement points:**
- `/api/auth/login`: Reject users where `is_active = 0` with a generic "invalid credentials" message.
- `/api/auth/refresh`: Check `is_active` before issuing new tokens. This ensures deactivated users are locked out within at most 15 minutes (when their access token expires and refresh is denied).

### First-Run Setup

1. Server starts, migration runs, detects zero users in `users` table.
2. Generates a one-time setup token, logs a setup URL to stdout.
3. Admin visits the URL, creates their account (email + password + display name).
4. First user is automatically assigned `role = 'admin'`.
5. All existing orphaned trackers/settings are assigned to the new admin user.
6. Setup token is invalidated.

## Data Isolation

### Query-Level Enforcement

All existing queries in `queries.ts` are updated with `WHERE user_id = ?`:

- Tracker CRUD: filtered by `user_id`
- Price history: filtered through tracker ownership
- Sparklines: filtered through tracker ownership
- Settings: per-user (each user has their own key-value pairs)
- Notifications: inherited through tracker FK relationship

### Scheduler & Notifications

The cron job continues to check all active trackers across all users. When a price drop triggers a notification, the scheduler must resolve the webhook URL for the tracker's owner:

1. `getDueTrackers()` returns trackers as before (all users, filtered by check interval).
2. When a notification is triggered, look up the tracker's `user_id`.
3. Query `settings` for that user's `discord_webhook_url`.
4. If the user has no webhook configured, skip notification silently (log a debug message).

This means `sendNotification()` in `discord.ts` needs a `userId` parameter (or receives the webhook URL directly from the caller). The global `config.discordWebhookUrl` env var fallback is removed in multi-user mode -- each user manages their own webhook.

**User deletion during active scrapes:** If a user is deleted while their trackers are being scraped, the CASCADE delete removes the trackers. Any in-flight scrape that tries to write a price result for a now-deleted tracker will fail on the FK constraint. The scheduler should catch this error gracefully and continue to the next tracker.

## Frontend Changes

### New Pages

- **Login** (`/login`): Email + password form.
- **Register** (`/register`): Email, password, display name, invite code. Accessible via `/register?code=abc123`.
- **Admin** (`/admin`): Users tab (list, deactivate) + Invites tab (create, list, revoke, copy link). Admin-only.

### Auth State

- `AuthContext` provider wrapping the app.
- On load, calls `GET /api/auth/me` to check authentication.
- Unauthenticated users redirected to `/login`.
- `ProtectedRoute` wrapper for authenticated routes.
- `AdminRoute` wrapper for admin routes.

### API Layer

- Add `credentials: 'include'` to all `fetch` calls (cookies sent automatically).
- Response interceptor: on 401 from non-auth endpoints, attempt a single refresh call. If the refresh itself returns 401 (expired refresh token), redirect to login. The interceptor must not retry auth endpoints to avoid infinite loops.

### Nav Updates

- Display user name in nav bar.
- Admin link visible to admin users.
- Logout button.

### No Changes to Existing Pages

Dashboard, AddTracker, TrackerDetail, and Settings work exactly as before. They only see the current user's data because the API filters it.

## Migration Strategy

### Schema Migration

- New `migrations.ts` module runs on server start before any routes are registered.
- Tracks applied migrations in the `schema_migrations` table (separate from user settings).
- Migration 1:
  - Create `users`, `invite_codes`, `refresh_tokens`, `schema_migrations` tables.
  - Add `user_id` column to `trackers` (nullable initially, FK with CASCADE delete).
  - Recreate `settings` table with composite PK `(user_id, key)` -- create new table, copy existing rows with `user_id = NULL`, drop old, rename.
  - Create indexes: `trackers.user_id`, `refresh_tokens.user_id`, `refresh_tokens.expires_at`, `invite_codes.created_by`, `invite_codes.used_by`.
- Idempotent -- checks `schema_migrations` before applying.

### Environment Variables

- `JWT_SECRET` (required in production): Signing key for JWTs. Server refuses to start if not set when `NODE_ENV=production`. In development, falls back to a hardcoded dev-only secret with a console warning.
- Existing `DISCORD_WEBHOOK_URL` env var is deprecated -- webhook configuration moves to per-user settings.

### Data Migration

- Existing trackers with `user_id = NULL` are held in place during schema migration.
- After admin account creation, a one-time migration assigns all orphaned data (trackers, settings) to the admin user.

## Security

### Password Policy

- Minimum 8 characters.
- bcrypt with 12 salt rounds.

### Rate Limiting

- `express-rate-limit` on auth endpoints: 5 attempts per 15 minutes per IP on `/api/auth/login` and `/api/auth/register`.

### Token Security

- Short-lived access tokens (15 min).
- Refresh tokens hashed in DB, rotated on use.
- Refresh token reuse triggers revocation of all tokens for that user.
- httpOnly + Secure + SameSite=Strict cookies.

### CORS

- Lock down to `https://prices.schultzsolutions.tech` in production.

### Invite Codes

- 24-character hex (96 bits of entropy).
- Single-use, optional expiration.
- Admin can revoke unused codes.

## Out of Scope (YAGNI)

- Email verification (invite-only, admin knows who they're inviting)
- Password reset via email (no email sending infra; admin can reset manually)
- 2FA (overkill for a price tracker with handful of users)
- Account lockout (rate limiting is sufficient)
- OAuth/social login (not needed for this use case)

## New Dependencies

### Server

- `bcrypt` -- password hashing
- `jsonwebtoken` -- JWT creation/verification
- `cookie-parser` -- parse cookies from requests
- `express-rate-limit` -- rate limiting on auth endpoints

### Client

- No new dependencies (uses existing React Context, fetch API)
