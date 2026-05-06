# Browser Extension — Design Spec

**Date:** 2026-05-06
**Status:** Approved (pending implementation plan)
**Branch:** `feature/browser-extension`

## Goal

Kill the friction of "paste a URL into the Add Tracker form." One click on any retailer page should add a tracker. Optimize for the case where the user is already shopping — they shouldn't context-switch back to the SPA to start watching a price.

## Non-goals (v1)

- Live in-page price extraction or content-script overlays
- Element picker / point-and-click CSS selector capture
- Firefox compatibility
- Chrome Web Store distribution
- Quick-edit / delete trackers from the popup
- Add-to-Project flow from the popup
- Telemetry, analytics, or any data leaving the device

These are captured as future work in `tasks/todo.md`.

## High-level architecture

A Chrome MV3 extension at `extension/` (new top-level dir, sibling to `client/` and `server/`). Three runtime components:

- **`manifest.json`** — `manifest_version: 3`. Permissions: `activeTab`, `contextMenus`, `storage`. Host permissions: `https://prices.schultzsolutions.tech/*` only — no retailer hosts, no broad access.
- **Background service worker (`background/service-worker.ts`)** — registers the right-click context menu, routes messages from popup, owns all `fetch()` calls to the API, retrieves the auth token from `chrome.storage.local`, translates errors to UX states.
- **Popup (`popup/popup.html` + `popup.ts` + `popup.css`)** — pure UI. Sends typed messages to the background, renders responses. ~360px wide. Closes on click-outside.
- **Options page (`options/`)** — token paste-in + "Test connection" button. Opens in a new tab.

No content scripts. The popup gets the current tab via `chrome.tabs.query({active: true, currentWindow: true})` (URL + title), which the existing `activeTab` permission covers without any retailer host_permissions.

Server-side, one new self-contained subsystem: per-user API tokens, exposed via Settings → "Connected Apps."

## Server-side: per-user API tokens

### Migration v12

```sql
CREATE TABLE user_api_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL,          -- first 8 chars of plaintext for display ("pt_a3b9c2…")
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX idx_user_api_tokens_user ON user_api_tokens(user_id);
```

### Token format

- 32 random bytes via `crypto.randomBytes(32)` → base64url-encoded → prefixed with `pt_` → 46-char string total (`pt_` + 43 base64url chars)
- Stored as SHA-256 hash in `token_hash`. No bcrypt — high-entropy random tokens don't need slow hashing; SHA-256 is the standard for API keys (matches GitHub, Stripe pattern)
- Plaintext returned to the user **once** at creation (modal: "Copy this — you won't see it again")
- `prefix` column stores first 8 chars of plaintext for display in the token list (`pt_a3b9c2…`) so the user can identify which token is which when revoking

### Routes

Mounted under `/api/settings/api-tokens`. All require `authMiddleware` (logged-in user only — only the user can manage their own tokens).

- **`POST /`** — body `{name: string}` (zod validated, 1-100 chars). Creates row, returns `{id, name, token: <plaintext, ONLY here>, prefix, created_at}`. Logs `api_token_created` with `user_id`, `token_id`, `name`.
- **`GET /`** — returns `{id, name, prefix, created_at, last_used_at, revoked_at}[]` for `req.user.userId`. Plaintext NEVER returned here.
- **`DELETE /:id`** — sets `revoked_at = Date.now()` for tokens owned by `req.user.userId`. Soft-delete preserves audit trail. 404 (not 403) for tokens belonging to other users — avoids existence leak. Logs `api_token_revoked`.

### Middleware extension

Today, `apiKeyMiddleware` checks `X-API-Key` against the global `PRICE_TRACKER_API_KEY` env var (the OpenClaw-style single-user shared key). Extension flow:

1. If header missing/empty → `next()` and let JWT cookie auth handle it (existing behavior, unchanged)
2. Hash the incoming header value with SHA-256
3. Constant-time compare against the global `PRICE_TRACKER_API_KEY` hash (existing flow, but now hash-compared like user tokens) — match → set `req.user` to `priceTrackerApiKeyUserId`'s user row, log `source: 'api-key'`, `next()`
4. Else look up `user_api_tokens WHERE token_hash = ? AND revoked_at IS NULL`. Match → set `req.user` from the token's owner, update `last_used_at = Date.now()`, log `source: 'user-token'` with `user_id` + `token_id`, `next()`
5. No match → 401 `{error: 'Invalid API key'}`. Log `api_token_auth_failed` with token prefix only (NEVER plaintext, NEVER hash).

`timingSafeEqual` over equal-length Buffers for the hash compare (length always 64 hex chars for SHA-256, so length mismatch is impossible if the hashing happened, but the constant-time compare protects against timing leaks on the lookup).

### Settings UI: "Connected Apps" card

New section on the existing Settings page (after the existing notification channel cards). For each token row: name, prefix (`pt_a3b9c2…`), created date, "last used N days ago" (or "never"), revoked badge if applicable, "Revoke" button (with confirm).

"Generate new token" button opens a dialog: name input, primary action "Generate." On success the dialog reveals the plaintext token in a monospace block with a "Copy" button. Closing the dialog clears the plaintext from the DOM.

## Extension components

### File layout

```
extension/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── manifest.json
├── src/
│   ├── background/service-worker.ts
│   ├── popup/popup.html
│   ├── popup/popup.ts
│   ├── popup/popup.css
│   ├── options/options.html
│   ├── options/options.ts
│   ├── options/options.css
│   ├── lib/api.ts            # fetch wrapper, used by background only
│   ├── lib/normalize-url.ts  # port of server's lib/normalize-url.ts
│   ├── lib/domains.ts        # port of server's lib/domains.ts
│   ├── lib/messages.ts       # typed background ↔ popup message contracts
│   └── types/api.ts          # Tracker, TrackerCreatePayload, etc.
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
└── dist/                     # gitignored, build output, what loads in Chrome
```

### Build pipeline

Vite + `@crxjs/vite-plugin` — the de facto MV3 toolchain. Handles manifest preprocessing, multi-entry bundling (popup, options, background as separate entries), and HMR for popup/options during dev. `npm run build` produces `extension/dist/` ready for sideload.

Scripts (`extension/package.json`):
- `npm run dev` — watch mode + HMR; reload extension in `chrome://extensions` after first load
- `npm run build` — production bundle to `extension/dist/`
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — vitest

`extension/` has its own `package.json` and `node_modules`. No npm workspace. Independent of `client/` and `server/`.

### Popup states

Six states the popup can render. State chosen on mount based on `chrome.storage.local` and a single `CHECK_DUP` round-trip to the background.

1. **No-token** — `chrome.storage.local` has no token. Shows: "Set up your API token" + "Open Settings" button. Clicking opens the options page in a new tab.
2. **Loading** — popup is checking dup status. Spinner + "Checking…" (typically 100-300ms).
3. **Add form** — new URL. Fields: `name` (prefilled from `tab.title`, editable), `url` (prefilled from `tab.url`, read-only), `threshold_price` (optional, $-prefixed input), Advanced disclosure (CSS selector, check interval). Primary button "Add Tracker."
4. **Already tracking** — duplicate detected. Shows: tracker name, last price, AI verdict pill (BUY/WAIT/HOLD or "—" if not generated yet), one-line reason. Ghost button "Open in Price Tracker →" links to `https://prices.schultzsolutions.tech/tracker/{id}`.
5. **Just-added** — POST succeeded. Green checkmark, "Tracking now," "First scrape will run within the next cron tick," ghost button "View tracker →," auto-close in 2s.
6. **Error** — covered in Error handling below.

### Duplicate detection

On popup mount, after the no-token gate:

1. Popup posts `{type: 'CHECK_DUP', url: tab.url}` to background
2. Background ensures it has a fresh `tracker_list` cache (fetch `GET /api/trackers` if cache missing or older than 60s). Cache stored in `chrome.storage.session` (auto-cleared on browser close).
3. Background normalizes `tab.url` via the ported `normalizeTrackerUrl` and compares against each tracker's `normalized_url`
4. Match → respond `{exists: true, tracker: {id, name, last_price, ai_verdict_tier, ai_verdict_reason}}`
5. No match → respond `{exists: false}`

The 60s cache prevents hammering `/api/trackers` when the user opens the popup multiple times in quick succession. Cache is keyed only on the user — invalidated when the user adds a new tracker via the popup itself (background updates the cache locally instead of refetching).

### Click-flow end-to-end (Add path)

1. User right-clicks page → "Add to Price Tracker" (or clicks toolbar icon)
2. `contextMenus.onClicked` handler in background calls `chrome.action.openPopup()`. Toolbar icon click does the same via the manifest's `action.default_popup`.
3. Popup mounts. Reads `chrome.storage.local` token — if missing, render no-token state and stop
4. Token present → posts `{type: 'CHECK_DUP', url}` to background
5. Background returns dup status. Popup renders "Already tracking" or "Add form" accordingly
6. (Add form path) User reviews fields, optionally edits, clicks Add. Popup posts `{type: 'CREATE', name, url, threshold_price?, css_selector?, check_interval_minutes?}`
7. Background calls `POST /api/trackers` with token in `X-API-Key`
8. Success → background updates its tracker_list cache, responds `{ok: true, tracker}`. Popup renders just-added state, auto-closes after 2s.
9. Failure → background responds `{ok: false, error: <category>}`. Popup renders error state.

### Context menu wiring

- `contextMenus.create({id: 'add-to-price-tracker', title: 'Add to Price Tracker', contexts: ['page', 'link'], documentUrlPatterns: ['<all_urls>']})` in `chrome.runtime.onInstalled`
- `contextMenus.onClicked` handler: opens the popup. (Chrome MV3 `chrome.action.openPopup()` works inside the user-gesture handler.)

## Type sharing with the server

Manual mirror in `extension/src/types/api.ts`. Surface is small — the create payload is 5 fields. Same call the existing `client/src/lib/domains.ts` already makes vs. its server twin. A shared `packages/types/` workspace would require splitting out the server's zod schemas — not worth it for this much surface.

`extension/src/lib/normalize-url.ts` and `lib/domains.ts` are direct ports of the server's twins (already 1:1 with `client/`'s versions). Drift is detected by parity test: both server and extension pin the same fixture inputs to the same expected outputs in their respective unit tests.

## Error handling

| Failure | UX | Server log |
|---|---|---|
| No token configured | "Set up your API token" state | n/a |
| 401 (token invalid/revoked) | "Token isn't working — re-paste in Settings" + Open Settings | `api_token_auth_failed` (prefix only) |
| Network / fetch threw | "Couldn't reach prices.schultzsolutions.tech" + Retry | n/a |
| 5xx | "Server hiccup — try again, or add manually" + Retry + "Open Price Tracker" | (existing 5xx logs) |
| 400 (zod validation) | Inline error under offending field | `tracker_create_validation_failed` |
| 409 (race-condition duplicate) | Falls through to "Already tracking" view | `duplicate_tracker_create_blocked` |

Background `fetch()` always wraps in try/catch, `console.warn`s with method/path/status. Visible via `chrome://extensions → Service worker → Inspect`. No errors leave the device.

## Observability

**Server (additions):**
- `api_token_created` — user_id, token_id, name (NEVER plaintext or hash)
- `api_token_revoked` — user_id, token_id
- `api_token_auth_failed` — token prefix only
- Existing auth-success log gains `source: 'user-token'` with `user_id` + `token_id` to distinguish from the global `source: 'api-key'`
- `last_used_at` updates on every successful auth

**Extension:**
- `console.warn` for failed fetches, with method/path/status
- No telemetry, no analytics, no remote logging

## Security posture

- **Token storage:** `chrome.storage.local` — extension-scoped, isolated from web pages and other extensions. NOT `sync` (don't replicate tokens via Google account)
- **Token at rest:** SHA-256 hash. Plaintext shown once on creation, then discarded (server has no way to recover it)
- **Token in transit:** HTTPS only. Manifest `host_permissions` restricts to `https://prices.schultzsolutions.tech/*`
- **CORS:** No new CORS rules. Background service worker bypasses CORS via `host_permissions`. Existing CORS allowlist (`https://prices.schultzsolutions.tech` only) stays as-is
- **Manifest permissions, minimum:** `activeTab` (URL/title of current tab on click), `contextMenus`, `storage`. No content scripts, no broad retailer host permissions
- **Constant-time compare** on token hash lookup via `timingSafeEqual`
- **Audit trail preserved** via soft-delete of tokens (`revoked_at`)

## Testing strategy

### Server (vitest, existing harness)

- Migration test: v12 idempotent, schema matches expectations
- Token route tests: CRUD + ownership scoping (user A 404s when listing/revoking user B's tokens)
- Middleware tests: valid token, invalid token, revoked token, timing-safe compare verified, `last_used_at` updates on success, `api_token_auth_failed` log on failure
- Hash storage: inserting a token never persists plaintext (assert `token_hash` is 64-char hex)

### Extension (vitest, new harness in `extension/`)

- `lib/normalize-url.ts` parity tests — same fixture set as server's `normalize-url.test.ts`, must produce same outputs (drift detector)
- `lib/domains.ts` parity tests — same alias set
- Message-router tests: CHECK_DUP / CREATE / TEST_CONNECTION dispatch correctly
- API client tests: `vi.mock` over `fetch`, verify token in `X-API-Key`, body shape, error categorization

### Manual smoke (in PR test plan)

- Load `extension/dist/` unpacked → paste token in Options → "Test connection" → success
- Right-click on amazon.com page → "Add to Price Tracker" → confirm in popup → tracker appears in SPA at `/tracker/<id>`
- Right-click again on same URL → "Already tracking" state shows correct last price + verdict
- Toolbar icon click on a third retailer → Add form, threshold price field, Advanced disclosure works
- Revoke token in Settings → next add fails → "Token isn't working" state → re-paste flow recovers

### Out of scope for testing

- Playwright extension e2e (~3× the test infra; manual smoke covers happy path, unit tests cover logic)

## Implementation phases / milestones

1. **Server-side tokens.** Migration, routes, middleware extension, "Connected Apps" UI on Settings page. Ships independently — no extension work yet.
2. **Extension scaffolding.** Manifest, build pipeline, empty popup that says "Hello" and reads the active tab. Sideloads cleanly.
3. **Options page + token storage.** "Test connection" round-trip works.
4. **Add flow.** Popup form, background fetch, context menu wiring, success/error states.
5. **Duplicate detection.** Cached tracker list, normalize-url parity, "Already tracking" state.
6. **Polish.** Icons (replace placeholders), focus states, empty/loading transitions, RELEASE.md sideload instructions.

Each milestone produces a committable, testable, sideloadable artifact.

## Open questions for plan-writing

None — design is fully specified.
