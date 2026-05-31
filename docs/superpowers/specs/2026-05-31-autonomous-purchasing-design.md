# Autonomous Purchasing (Buy-on-Trigger) — v1 Design

**Date:** 2026-05-31
**Status:** Draft, pending implementation plan
**Related:** builds directly on the purchase-log feature in `2026-05-20-purchased-tracking-design.md`

## Summary

Let a tracker be **armed for purchase**. When an armed tracker crosses its price threshold, the system fires a special **purchase-arm** alert (instead of the normal price alert) that links to an in-app **Buy Confirmation** page. The owner taps **Approve**, gets handed into Amazon's own cart with the item pre-loaded, completes native checkout, and taps **"Did it go through?"** to close the loop. A confirmed purchase calls the existing `createPurchase(...)` — reusing the savings ledger, the `'purchased'` status, and the scheduler exclusion already built for the purchase-log feature.

This is v1: **armed + one-tap human confirm + handoff**. Claude controls the *decision*; the retailer owns the *transaction*. No payment data is stored, no checkout is automated, no retailer ToS is touched.

## Why this shape (decisions locked during brainstorming)

| Question | Decision | Reason |
|----------|----------|--------|
| Human-in-the-loop boundary | **Armed + one-tap confirm.** Nothing is ever bought without an explicit owner tap. | The tap is the circuit breaker: a misread price or scraper glitch can never cost money on its own. Removes the need for a spend-cap guardrail in v1. |
| Execution mechanism | **Phased — handoff now, auto-checkout later.** v1 hands the owner into Amazon's native checkout. | Defers every scary problem (stored payment, checkout bot-defenses, ToS on automated buying) until the trigger→approve loop has proven itself. |
| Spend budget (pool / bucket / group) | **Out of v1.** | The pool was only ever an *autonomous*-overspend guardrail. With a per-purchase tap, it's belt-on-a-belt. YAGNI. Becomes load-bearing in v2 (see Forward-Looking). |
| Retailer scope | **Amazon-only in v1.** | Most trackers are Amazon; Best Buy / Home Depot are network-blocked from CT 302 anyway. Amazon has a no-automation, no-stored-payment handoff path (add-to-cart URL). |
| Arming granularity | **Per-tracker flag.** | Matches the mental model and the existing per-tracker threshold. Group/bucket arming is deferred. |
| Terminal "purchased" state | **Reuse `createPurchase(...)`** rather than a parallel ledger. | The purchase-log feature already records the buy, snapshots savings, and excludes the tracker from scraping. |

## Non-Goals (v1)

- No automated checkout, no stored payment, no retailer login automation.
- No spend pool / bucket / group budget (v2 — see Forward-Looking).
- No non-Amazon retailers (they get a plain product deep-link at most; no arming).
- No true 1-Click — "one tap" is the *approve* in our app; Amazon checkout is a few native taps.
- No order-number / receipt capture (the purchase-log feature already declared this a non-goal).

## Scope line: v1 vs v2

- **v1 (this spec):** per-tracker arm flag → purchase-arm alert → auth-gated Buy Confirmation page → Amazon handoff → close-the-loop → `createPurchase()`.
- **v2 (later, separate spec):** removing the per-purchase tap (auto-checkout). The **cumulative-wallet / per-item / recurring spend envelope becomes the mandatory guardrail** that gates graduation to autonomy. v1 does not get autonomy without it.

## Data Model

### New columns on `trackers`

```sql
ALTER TABLE trackers ADD COLUMN buy_armed   INTEGER NOT NULL DEFAULT 0 CHECK(buy_armed IN (0,1));
ALTER TABLE trackers ADD COLUMN buy_quantity INTEGER NOT NULL DEFAULT 1 CHECK(buy_quantity >= 1);
```

### New table: `purchase_intents` (migration v19)

The in-flight arming/approval workflow. This is the **audit log of buy intents** — distinct from `purchases` (the realized ledger). One intent row per arming event.

```sql
CREATE TABLE purchase_intents (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id      INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  tracker_url_id  INTEGER REFERENCES tracker_urls(id) ON DELETE SET NULL,
  asin            TEXT NOT NULL,
  price_at_arm    REAL NOT NULL CHECK(price_at_arm >= 0),
  threshold_at_arm REAL NOT NULL,
  quantity        INTEGER NOT NULL DEFAULT 1 CHECK(quantity >= 1),
  token           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'armed'
                    CHECK(status IN ('armed','approved','purchased','not_completed','expired','canceled')),
  purchase_id     INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at     TEXT,
  resolved_at     TEXT,
  expires_at      TEXT NOT NULL
);
CREATE INDEX idx_purchase_intents_tracker_id ON purchase_intents(tracker_id);
CREATE INDEX idx_purchase_intents_status ON purchase_intents(status);
CREATE UNIQUE INDEX idx_purchase_intents_token ON purchase_intents(token);
```

`migration v19` adds the two columns + the table. The `'purchased'` tracker status and its CHECK already exist (migration v18) — **not touched**. `price_at_arm` / `threshold_at_arm` are snapshotted for the audit trail (same "historical fact shouldn't drift" reasoning as `purchases.first_price`). `purchase_id` back-links a confirmed intent to the realized purchase row.

## State Machine

```
armed ──approve──▶ approved ──┬─▶ purchased       (owner: "yes, it went through" → createPurchase())
  │                           └─▶ not_completed   (owner: "didn't go through")
  ├──expiry sweep────────────────▶ expired        (past expires_at, never approved/resolved)
  └──disarm / re-arm-superseded──▶ canceled
```

**Invariant — at most ONE open intent per tracker.** "Open" = status in (`armed`, `approved`). This is the load-bearing idempotency rule: it guarantees no double-buy and no per-tick notification spam. A deal sitting below threshold for days arms exactly **once**.

Transition rules (all illegal transitions rejected at the query layer):
- `armed → approved`: sets `approved_at`, returns the Amazon cart URL. Idempotent — approving an already-`approved` intent returns the same URL, does not re-notify.
- `approved → purchased`: calls `createPurchase(tracker_id, { purchase_price, quantity, tracker_url_id }, { keep_watching: false })`, stores the returned `purchase_id`, sets `resolved_at`. Tracker → `'purchased'` (via `createPurchase`), which auto-disarms it from scraping. `buy_armed` is also set back to `0`.
- `approved → not_completed`: sets `resolved_at`, no purchase row. Tracker stays `active`, `buy_armed` stays `1` (can re-arm on a future qualifying tick).
- `* → expired`: expiry sweep (see below). `buy_armed` stays `1`.
- `armed/approved → canceled`: owner disarms the tracker, or a (future) re-arm supersedes a stale one.

## Trigger Path

Hooks into the existing cron alert path (`firePriceAlerts`). After a tracker's winning seller is determined and it has crossed threshold, **before** sending the normal price alert, check the arm conditions:

1. `tracker.buy_armed === 1`, AND
2. winning seller host is Amazon, AND
3. an ASIN is extractable from that seller's URL (`extractAsin`), AND
4. no open intent exists for this tracker, AND
5. **no re-arm cooldown is active** — the tracker's most recent intent did not resolve to `expired` / `not_completed` within the last `RE_ARM_COOLDOWN_HOURS`.

If all true → create an `armed` `purchase_intents` row (random token, `expires_at = now + ARM_EXPIRY_HOURS`) and send the **purchase-arm** notification instead of the normal price alert. If any condition fails (not armed, non-Amazon winner, no ASIN, open intent already exists, or re-arm cooling down) → fall through to the **normal price alert** exactly as today.

**Re-arm cooldown** (`RE_ARM_COOLDOWN_HOURS`, default `24`): without it, a deal sitting below threshold would re-arm on the very next cron tick after you tapped "didn't go through" or after an intent expired — nagging you and defeating the expiry. The cooldown keys off the most recent terminal intent's `resolved_at` (for `not_completed`) / `expires_at` (for `expired`). A `purchased` outcome needs no cooldown — the tracker is disarmed and excluded from scraping anyway.

**Arming sits *after* the existing plausibility guard.** Only the per-channel cooldown / confidence *suppression* is bypassed (an armed deal must not be silenced by an unrelated price-alert cooldown). The plausibility guard that rejects absurd misreads still applies — a $0 or implausible scrape never arms a purchase.

**Expiry sweep:** a periodic job (fold into an existing nightly cron) sets any `armed`/`approved` intent past `expires_at` to `expired`. `ARM_EXPIRY_HOURS` config, default `24`.

## Handoff Link

`buildAmazonCartUrl(asin, quantity)`:

```
https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=<asin>&Quantity.1=<quantity>&AssociateTag=<AMAZON_AFFILIATE_TAG>
```

Carries the existing `AMAZON_AFFILIATE_TAG` (`schultzsoluti-20`) so armed buys route through Associates for free — reuses `server/src/lib/affiliate.ts` conventions.

⚠️ **Build-time validation required.** This legacy add-to-cart endpoint has been partially deprecated by Amazon over the years. The implementation plan MUST verify it still pre-loads the cart against a live ASIN. **Fallback** if it no longer works reliably: hand off to a `https://www.amazon.com/dp/<ASIN>?tag=<tag>` product deep-link (one extra tap to add to cart). Either way the owner finishes in Amazon's native UI.

`extractAsin(url)`: pulls the ASIN from `/dp/<ASIN>`, `/gp/product/<ASIN>`. Short links (`a.co/d/...`) are already resolved to canonical `amazon.com/dp/...` form by the existing normalization (`normalized_url`), so extraction runs against the resolved URL. Returns `null` for non-Amazon / unparseable URLs.

## Buy Confirmation Page — `/buy/:token`

**Auth-gated — NOT a public token page like `/wishlist/:token`.** The token identifies the intent; the *action* requires an authenticated session whose user owns the tracker. A leaked link is inert in anyone else's hands.

Page contents:
- Order summary: item name, seller, `price_at_arm`, all-time-low context, and the existing AI verdict pill.
- **Approve → Open in Amazon** button: transitions `armed → approved`, opens `buildAmazonCartUrl(...)` in a new tab/native app.
- After handoff, a **"Did it go through?"** prompt with two taps: **Yes** (`→ purchased`, calls `createPurchase`) / **No** (`→ not_completed`).
- If the intent is already resolved/expired when opened, render the terminal state read-only (no re-approve).

## Backend API

| Method | Path | Auth | Body | Returns |
|--------|------|------|------|---------|
| `PATCH` | `/api/trackers/:id` (existing) | owner | `{ buy_armed?, buy_quantity? }` | updated tracker — arm/disarm toggle |
| `GET` | `/api/buy/:token` | owner of intent | — | intent + tracker + cart URL (only if approvable) |
| `POST` | `/api/buy/:token/approve` | owner of intent | — | `{ cartUrl }`, transitions to `approved` (idempotent) |
| `POST` | `/api/buy/:token/resolve` | owner of intent | `{ outcome: 'purchased' \| 'not_completed' }` | `{ intent, purchase? }` |

All `/api/buy/*` actions authorize the logged-in user against the intent's tracker owner; mismatch → 404 (don't reveal existence).

## Notification Copy

New `purchase-arm` template, distinct from price alerts, across the existing channels (Discord / ntfy / web push / email / webhook):

> 🛒 **Ready to buy: {item}** hit **${price}** (your buy limit ${threshold}). Approve → {`/buy/<token>` link}

The link target is the auth-gated Buy Confirmation page. No payment or token-sensitive data in the notification body beyond the opaque token in the URL.

## UI Changes

- **TrackerDetail:** an "Arm for purchase" toggle with a plain-language explainer ("When this hits your target, you'll get a one-tap approval to buy on Amazon — nothing is purchased without your tap") + a quantity field. Disabled with a hint when the winning seller isn't Amazon.
- **TrackerCard:** a `🛒 armed` badge when `buy_armed`; a distinct **"Ready to buy"** state when an open intent exists.
- **Purchase activity** surfaces on TrackerDetail in a card next to "Recent Alerts" (intent history). A dedicated `/purchase-intents` page is deferred — the realized `/purchased` log already exists.

## Security Posture

- **No payment data anywhere** in v1 — Amazon owns checkout.
- High-entropy, single-purpose, unique `token` tied to one intent; expires with the intent.
- Every `/api/buy/*` action is auth-gated and authorized to the tracker owner — leaked links are inert.
- Status transitions are append-only facts (the audit trail); illegal transitions rejected at the query layer.
- Expiry sweep retires stale intents so nothing lingers approvable indefinitely.
- Arming respects the same input-sanitization as the rest of the API (quantity bounds via CHECK, ASIN validated by `extractAsin`).

## Testing Plan

- `extractAsin`: `/dp/`, `/gp/product/`, resolved short-link, non-Amazon → `null`, malformed.
- `buildAmazonCartUrl`: correct params, affiliate tag attached, quantity, idempotent tag handling.
- **One-open-intent idempotency:** a tracker already holding an open intent does not create a second on the next tick.
- **State machine:** every legal transition + rejection of every illegal one (e.g. `purchased → approved`).
- **Authorization:** another user cannot read/approve/resolve someone else's intent (404).
- **Cron integration:** armed Amazon tracker crossing threshold → creates intent + sends purchase-arm copy; unarmed (or non-Amazon winner, or no ASIN) → normal price alert.
- **Resolve → purchase:** `purchased` outcome calls `createPurchase`, links `purchase_id`, flips tracker to `'purchased'`, disarms; `not_completed` leaves tracker active + armed.
- **Expiry sweep:** `armed`/`approved` past `expires_at` → `expired`.

## Forward-Looking: v2 (autonomous checkout)

v2 removes the per-purchase tap. The gate to ship it is the **spend envelope** that was deliberately cut from v1:
- Cumulative wallet (pool depletes), per-item ceiling, and/or recurring allowance — scoped to bucket / single tracker / group.
- This envelope is the **mandatory autonomous-overspend guardrail**; no auto-checkout ships without it.
- v2 also confronts the deferred hard problems: stored/tokenized payment, checkout bot-defenses, retailer ToS, and a reliable order-confirmation signal (which v1's handoff intentionally lacks). Each gets its own brainstorm.
