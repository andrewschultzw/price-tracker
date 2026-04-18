# Email Notification Channel Design

**Date:** 2026-04-18
**Status:** Approved
**Author:** Andrew Schultz + Claude

## Overview

Add email as the fourth notification channel for price alerts, alongside Discord, ntfy, and generic webhook. Email is the most accessible channel for non-technical users — no app install, no webhook setup, just paste an address. Uses the existing `homelab.schultz@gmail.com` account as the SMTP sender, with a verified Gmail "Send As" alias of `alerts@schultzsolutions.tech` so the from-address matches the domain.

## Decisions

- **Transport:** Gmail SMTP (`smtp.gmail.com:465`) via nodemailer with app-password auth. Rationale: reuses the existing Gmail account already used by Paperless for inbound relay; simplest path; the ~500/day quota is far above any homelab tracker volume.
- **From-address:** `Price Tracker <alerts@schultzsolutions.tech>` via a Gmail Send-As alias. Cloudflare Email Routing forwards `alerts@schultzsolutions.tech` to `homelab.schultz@gmail.com` for verification and any replies.
- **Credentials location:** App-wide in server `.env`. The SMTP account is the *sender*; each user configures only their *recipient* address.
- **Recipient format:** Single email per user (no comma-separated lists, no separate cc). Multi-recipient use cases are solved by multiple user accounts, which the app already supports.
- **Body format:** Multipart HTML + plaintext fallback (nodemailer's `html:` + `text:` fields).
- **Cooldown:** Inherits the existing per-`(tracker, seller)` cooldown used by Discord/ntfy/webhook. No per-channel cooldown.
- **Encryption at rest:** Recipient email stored encrypted via the existing `settings-crypto.ts` AES-256-GCM path — same pattern as webhook URLs.

## Architecture

### New module: `server/src/notifications/email.ts`

Exports functions matching the shape used by the other three channels:

- `sendEmailPriceAlert(tracker: Tracker, price: number, recipient: string): Promise<boolean>`
- `sendEmailErrorAlert(tracker: Tracker, errorMsg: string, recipient: string): Promise<boolean>`
- `testEmail(recipient: string): Promise<{ ok: boolean; error?: string }>` — backing for `POST /api/settings/test-email`.

Creates a shared nodemailer transport on first use (module-level singleton, mirroring the browser singleton in `scraper/browser.ts`). Returns `false` on SMTP failure after logging — matches the `Promise<boolean>` shape of `sendDiscordPriceAlert`/`sendGenericPriceAlert` so the cron fan-out can treat every channel uniformly.

### Transport configuration

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=homelab.schultz@gmail.com
SMTP_PASS=<Gmail app password>
SMTP_FROM="Price Tracker <alerts@schultzsolutions.tech>"
```

Added to `src/config.ts` with validation: all five values required for the email channel to be enabled. If any is missing, `sendEmailPriceAlert` throws a clear "email channel not configured" error and the settings UI greys out the email card.

### Per-user setting

New encrypted setting key: `email_recipient`. Stored via the existing `getSetting`/`setSetting` path in `queries.ts` which handles encryption transparently (prefix `v1:` from `settings-crypto.ts`). No new schema — just a new key string.

### Cron integration

In `scheduler/cron.ts`, `getEnabledChannels` returns a new `email` field alongside `discord`, `ntfy`, `webhook`. `hasAnyChannel` OR's all four. `firePriceAlerts` and `fireErrorAlerts` get a fourth branch using `Promise.allSettled` so one channel's failure doesn't block the others (existing pattern).

### Settings UI card

New card in `Settings.tsx` mirroring the ntfy card:

- Email input (`type="email"`, client-side HTML5 validation + server regex `^[^@\s]+@[^@\s]+\.[^@\s]+$`).
- Status hint text: "Alerts will be sent from `alerts@schultzsolutions.tech`" when SMTP is configured; "Email channel not configured by admin" when server `.env` lacks SMTP vars.
- "Send test email" button → `POST /api/settings/test-email` (auth required) → server sends a short fixed "this is a test from Price Tracker" to the current `email_recipient`. Response mirrors the other test endpoints (200 on success, 400/500 with `{error: string}` on failure, surfaced inline in the card).
- "Clear" button — blanks the field and saves, disabling the channel for that user.

### Email content

**Subject (price alert):**
```
Price drop: {tracker name} is ${new price}
```

**Subject (error alert):**
```
Tracker error: {tracker name}
```

**Plaintext body (price alert):**
```
{tracker name} dropped to ${new price}

Your target: ${threshold}
Savings: ${threshold - new price}
Seller: {canonical hostname}

Buy now: {tracker.url}
```

**HTML body (price alert):** Same information, wrapped in a minimal template: tracker name as bold header, price in large bold green, threshold/savings/seller as a small table, "Buy now" link button at the bottom pointing to the retailer URL. No inline images (no retailer favicons or sparklines — those are a future nice-to-have, not MVP).

The outbound link points to the retailer URL (`tracker.url`), matching what Discord/ntfy/webhook already do. Linking to the app's own `/tracker/:id` page would require a new `PUBLIC_URL` config var and a public-URL / LAN-URL distinction that the other channels don't have; out of scope.

Plain-text version is always included so Gmail's mobile text-mode clients and accessibility paths render cleanly.

## Validation

- **Recipient address:** Server regex `/^[^@\s]+@[^@\s]+\.[^@\s]+$/` — basic shape check, matches what the existing webhook URL validator does for its domain (intentionally not RFC 5322 strict; SMTP delivery will reject genuinely invalid addresses).
- **SMTP port:** Restricted to 465 (implicit TLS) or 587 (STARTTLS); other ports rejected at config validation.
- **From-address:** Server config only; not user-settable. Prevents spoofing by users setting a from-address for trackers they don't own.

## Error handling

Same pattern as the other three channels:

- SMTP transport errors → throw up to the cron try/catch → recorded as `last_error`, increments `consecutive_failures`, status flips to `error` after `maxConsecutiveFailures`.
- Bad recipient → 400 at the save endpoint; never reaches the SMTP layer.
- Silent bounces (soft / hard) land in the `homelab.schultz@gmail.com` inbox via Cloudflare forwarding; not handled in-app for MVP. If it becomes a problem we can add bounce parsing later.

## Testing

- `email.test.ts` — nodemailer mocked via `vi.mock('nodemailer')`. Covers:
  - Transport config matches `SMTP_*` env vars
  - Subject/body templating for price and error alerts
  - Multipart shape: both `html` and `text` fields populated
  - Transport error bubbles up (no silent swallow)
  - Missing SMTP config → clear error message
- `cron.test.ts` — extend the existing fan-out test so a configured `email_recipient` fires the email branch; verify `Promise.allSettled` isolation (Discord failing doesn't skip email).
- Settings route test — recipient regex accept/reject cases.

## Manual setup runbook

These are one-time Gmail / Cloudflare configuration steps that have to happen outside the codebase. Claude will walk through them interactively during deploy.

### 1. Gmail app password for `homelab.schultz@gmail.com`

Requires 2-Step Verification on the Gmail account (enable first if off).

1. Visit https://myaccount.google.com/apppasswords while signed in as `homelab.schultz@gmail.com`.
2. Enter a name like `Price Tracker SMTP` and click **Create**.
3. Copy the 16-character password (shown once, no spaces).
4. This value becomes `SMTP_PASS` in `/opt/price-tracker/.env` on CT 302.

### 2. Cloudflare Email Routing for `alerts@schultzsolutions.tech`

1. Cloudflare dashboard → **schultzsolutions.tech** zone → **Email** → **Email Routing** → **Routes**.
2. Click **Create address**.
3. Custom address: `alerts`
4. Action: **Send to an email** → destination `homelab.schultz@gmail.com` (same destination you already use for `docs@`).
5. Save. Verify the MX/SPF records for Email Routing are already in place (they should be — Paperless has been using them).

### 3. Gmail "Send As" alias

1. `homelab.schultz@gmail.com` → **Settings** (gear) → **See all settings** → **Accounts** tab.
2. Under **Send mail as**, click **Add another email address**.
3. Name: `Price Tracker`. Email: `alerts@schultzsolutions.tech`. ✅ **Treat as an alias** (leave checked). **Next step**.
4. SMTP server: `smtp.gmail.com`. Port: `465`. Username: `homelab.schultz@gmail.com`. Password: the app password from step 1. **Secured connection using SSL** (selected by default). **Add account**.
5. Gmail sends a verification code to `alerts@schultzsolutions.tech` → Cloudflare Routing forwards to `homelab.schultz@gmail.com` inbox. Copy the code, paste into the verification dialog, confirm.
6. In **Send mail as**, optionally set the alias as default — not required; we set the `from` explicitly in the SMTP envelope.

### 4. Populate `/opt/price-tracker/.env` on CT 302

Append:
```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=homelab.schultz@gmail.com
SMTP_PASS=<app password from step 1>
SMTP_FROM="Price Tracker <alerts@schultzsolutions.tech>"
```

Restart service: `systemctl restart price-tracker`.

### 5. Smoke test end-to-end

From the Settings page in the app → enter a recipient address → **Send test email** → confirm arrival.

## Open questions

None.

## Out of scope (future work)

- Retailer favicons / inline price sparklines in the HTML body
- Bounce handling (parsing soft/hard bounces from the homelab inbox)
- DKIM signing for the `schultzsolutions.tech` alias (Gmail's "Treat as alias" path uses Gmail's DKIM — strict receivers may still reject; swap to a transactional service if deliverability becomes an issue)
- Per-channel cooldowns ("ntfy instant, email daily digest") — covered by its own todo item, skip until it matters
