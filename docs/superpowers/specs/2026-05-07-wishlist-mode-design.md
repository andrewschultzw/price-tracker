# Wishlist / Gift Mode — Design Spec

**Date:** 2026-05-07
**Status:** Approved (rolling into implementation)
**Branch:** `feature/wishlist-mode`

## Goal

Let users share an anonymous, link-gated wishlist of items they're tracking. Gift-givers can see prices + claim items so two people don't buy the same thing. Owners cannot see what's been claimed — surprise preserved.

Embodies the original todo entry: *"Wishlist / gift mode. Share wishlists; recipient can't see what's been bought."*

## Decisions (per user "go" on defaults)

1. **One implicit wishlist per user.** Not a separate `wishlists` table. Just a per-user share token + a per-tracker `is_wishlisted` flag.
2. **Per-tracker toggle** to add/remove from the wishlist. The wishlist = filter over the user's existing trackers.
3. **Anonymous claim only.** No name/note metadata. Owner CANNOT see claims; other gift-givers CAN see what's already claimed.
4. **Single share link per user.** Anyone with the link can view + claim. Rotatable (regenerates token, invalidates old link).
5. **Claimer-controlled un-claim.** No auto-expiry. Claim token saved in claimer's localStorage; "I changed my mind" button releases the claim.

## Architecture

### Migration v16

```sql
ALTER TABLE users ADD COLUMN wishlist_share_token TEXT UNIQUE;
ALTER TABLE trackers ADD COLUMN is_wishlisted INTEGER NOT NULL DEFAULT 0;

CREATE TABLE wishlist_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracker_id INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL
);
CREATE INDEX idx_wishlist_claims_tracker ON wishlist_claims(tracker_id);
```

Token format: `wl_` + 32 random base64url chars (matches the `pt_` API token pattern). Claim token same shape: `wc_` + 32 chars.

### Routes

**Owner-side (auth required, mounted at `/api/wishlist`):**

- **`POST /api/wishlist/share-token`** — generates or rotates the user's share token. Body `{ rotate?: boolean }`. Returns `{ token, share_url }`. Rotating invalidates the previous token (any old shared links 404).
- **`GET /api/wishlist/me`** — returns the owner's wishlisted trackers. **Strips claim status** so the owner stays surprise-blind. Returns `{ items: [...trackers], share_url: string | null }`.
- **`PATCH /api/wishlist/items/:tracker_id`** — body `{ is_wishlisted: boolean }`. Toggles the tracker's wishlist flag. Verifies `tracker.user_id === req.user.userId`.

**Public (no auth, token-gated, mounted at `/api/public/wishlist`):**

- **`GET /api/public/wishlist/:token`** — returns wishlisted trackers WITH claim status. Only fields safe for gift-givers: `name`, `url`, `last_price`, `ai_verdict_tier`, `ai_verdict_reason`, `is_claimed`. **No `threshold_price`** (that's the owner's private "buy under $X" target — leaking it could be embarrassing). Token mismatch → 404 (no existence leak). Cache-Control: `public, max-age=60` — small to keep claim status fresh.
- **`POST /api/public/wishlist/:token/claim/:tracker_id`** — creates a claim row, returns `{ claim_token }`. 409 if already claimed (with no claim_token return). 404 if token or tracker_id invalid.
- **`DELETE /api/public/wishlist/:token/claim/:tracker_id`** — body or header `claim_token`. Deletes the claim if `claim_token` matches the row. 404 otherwise.

### Tracker route extension

`server/src/routes/trackers.ts` `updateSchema` already supports tracker updates. Add `is_wishlisted: z.boolean().optional()` so existing PUT can flip the flag too. The dedicated PATCH at `/api/wishlist/items/:tracker_id` is the primary path; the field on PUT is convenience.

### Privacy guard

The OWNER's view (`GET /api/wishlist/me`) **must not** include claim status. This is the entire point of "recipient can't see what's been bought." Server-side, the response query joins wishlist_claims but **drops** the claim columns before returning.

The PUBLIC view (`GET /api/public/wishlist/:token`) DOES include `is_claimed: boolean` so gift-givers can avoid double-buying.

## Client UI

### New route in `App.tsx`

`<Route path="/wishlist/:token" element={<WishlistPublic />} />` in the public Routes block alongside `/p/:slug` and `/deals`. Same simplified header (site title + Sign in link). Add `/wishlist/` to the public-prefix early-return check.

### TrackerDetail — wishlist toggle

A new toggle (or pill button) next to the tracker name: "Add to wishlist" / "On wishlist ✓". Click flips `is_wishlisted` via PATCH. Visual badge on the card when `is_wishlisted === true` for at-a-glance owner clarity.

### Settings — Wishlist card

New card visible to all users:
- Heading: "Wishlist"
- Subtitle: "Share with gift-givers. They can see prices and claim items, but you'll never know which."
- If no token: "Generate share link" button → POST /api/wishlist/share-token
- If token exists: shows full URL, "Copy" button, "Rotate link" button (with confirm — invalidates old)
- Counter: "X items on your wishlist" linked to a manage view? Or just to /tracker/<id> dashboard filter? **For v1: counter only, no separate manage page.** User toggles per-tracker via TrackerDetail.

### WishlistPublic page

For anonymous gift-givers visiting `/wishlist/<token>`:
- Header: "Andrew's Wishlist" if `share_display_name='true'` for the owner, else "A Price Tracker Wishlist"
- Card grid of wishlisted items: name, current price, AI verdict pill, link to the retailer (NOT to /tracker/<id> — that's auth-gated)
- Each card has either:
  - "Claim this gift" button (when `is_claimed === false`)
  - "Already claimed by someone" gray badge (when `is_claimed === true` and the visitor doesn't have the claim_token in localStorage)
  - "You claimed this — undo" button (when localStorage has the claim_token for this tracker, regardless of `is_claimed` server state)
- Footer: "Powered by Price Tracker — track your own prices →" (sign-in link)

Claim_token storage: `localStorage.setItem('wishlist_claim_<tracker_id>', '<claim_token>')`. Read on mount, used to render the "you claimed this" state.

## Files modified or created

**Server:**
- Modify `server/src/db/migrations.ts` — append v16
- Create `server/src/db/migration-v16.test.ts`
- Modify `server/src/db/queries.ts` — wishlist helpers (`generateWishlistToken`, `rotateWishlistToken`, `getWishlistByToken`, `getOwnerWishlist`, `setTrackerWishlistFlag`, `createClaim`, `deleteClaim`, `getClaimByTokenAndTracker`)
- Create `server/src/db/wishlist.test.ts`
- Create `server/src/routes/wishlist.ts` — owner-side routes
- Create `server/src/routes/wishlist.test.ts`
- Modify `server/src/routes/public-products.ts` — add the public wishlist routes (or create a new `public-wishlist.ts` file if cleaner)
- Modify `server/src/routes/trackers.ts` — add `is_wishlisted` to updateSchema
- Modify `server/src/index.ts` — mount new routes

**Client:**
- Modify `client/src/types.ts` — add `is_wishlisted: boolean` to Tracker
- Modify `client/src/api.ts` — wishlist wrappers (`getMyWishlist`, `getWishlistShareToken`, `rotateWishlistShareToken`, `setTrackerWishlist`, `getPublicWishlist`, `claimWishlistItem`, `unclaimWishlistItem`)
- Create `client/src/pages/WishlistPublic.tsx`
- Create `client/src/pages/WishlistPublic.test.tsx`
- Create `client/src/components/WishlistCard.tsx` (Settings card)
- Create `client/src/components/WishlistCard.test.tsx`
- Modify `client/src/pages/Settings.tsx` — render the new card
- Modify `client/src/pages/TrackerDetail.tsx` — wishlist toggle
- Modify `client/src/App.tsx` — new `/wishlist/:token` public route + path-prefix update

## Tests

Server (~15 new):
- Migration v16 idempotent + columns added correctly
- Generate token: creates unique `wl_<32>` token; second call without rotate returns same token
- Rotate token: replaces existing, old token returns 404 on lookup
- Owner GET /api/wishlist/me: returns wishlisted items, NO claim columns
- Owner PATCH /api/wishlist/items/:id: flips flag, ownership check (cross-user 404)
- Public GET /api/public/wishlist/:token: returns items with claim status, NO threshold_price
- Public GET with bad token: 404
- Public POST claim: creates row, returns claim_token, idempotency on retry returns 409
- Public DELETE claim with valid claim_token: 204
- Public DELETE claim with wrong claim_token: 404
- Cache-Control header on public GET = 60s

Client (~5 new):
- WishlistPublic renders empty + populated states
- Claim button on un-claimed item, "Already claimed" on claimed-by-other, "Undo" on localStorage-matched
- Settings WishlistCard renders Generate / Rotate / Copy correctly
- Rotate confirms before action

## Privacy threat model

Same posture as public product pages, plus claim privacy:

1. **Owner stays blind to claims.** Hard-coded — owner endpoints never join wishlist_claims columns into responses. Tested.
2. **Threshold price NOT exposed.** Public response excludes `threshold_price` since it's user-private intent.
3. **Token enumeration.** 32 base64url chars = 192 bits of entropy. Brute force infeasible.
4. **Token rotation.** Owner can rotate at any time, invalidates prior link.
5. **Claim un-claim leak.** A gift-giver who clicks claim then deletes can repeatedly claim+unclaim to learn nothing the public GET wouldn't already tell them. No leak.

## Out of scope / future

- Multiple wishlists per user (1b option)
- Named claims ("from Mom") (3b option)
- Auto-expiring claims (5b option)
- Per-recipient links / claim attribution analytics (4b option)
- Claim notifications to owner (would defeat the surprise)
- Wishlist sharing via email blast
- Public wishlist directory
- Importing trackers from someone else's wishlist into your own

Estimated scope: ~500 LOC + tests.
