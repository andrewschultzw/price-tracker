import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { randomBytes } from 'crypto';
import { _setDbForTesting, getDb } from './connection.js';
import { initializeSchema } from './schema.js';
import {
  generateOrGetWishlistShareToken,
  rotateWishlistShareToken,
  getUserByWishlistToken,
  setTrackerWishlistFlag,
  getOwnerWishlist,
  getPublicWishlistByToken,
  createWishlistClaim,
  deleteWishlistClaim,
  isTrackerInUsersWishlist,
  createTracker,
  setSetting,
} from './queries.js';
import { initSettingsCrypto, _resetForTests as resetCrypto } from '../crypto/settings-crypto.js';

function seedUser(email: string, displayName: string = 'A'): number {
  return Number(getDb().prepare(
    `INSERT INTO users (email, password_hash, display_name, role, is_active)
     VALUES (?, 'h', ?, 'user', 1)`,
  ).run(email, displayName).lastInsertRowid);
}

beforeEach(() => {
  resetCrypto();
  initSettingsCrypto(randomBytes(32).toString('base64'));
  _setDbForTesting(new Database(':memory:'));
  initializeSchema();
});

describe('wishlist share tokens', () => {
  it('generateOrGetWishlistShareToken returns the same token on a repeat call', () => {
    const u = seedUser('a@x.com');
    const t1 = generateOrGetWishlistShareToken(u);
    const t2 = generateOrGetWishlistShareToken(u);
    expect(t1).toBe(t2);
    expect(t1).toMatch(/^wl_[A-Za-z0-9_-]{32}$/);
  });

  it('rotateWishlistShareToken produces a different token and the old one no longer resolves', () => {
    const u = seedUser('a@x.com');
    const t1 = generateOrGetWishlistShareToken(u);
    const t2 = rotateWishlistShareToken(u);
    expect(t1).not.toBe(t2);
    expect(t2).toMatch(/^wl_[A-Za-z0-9_-]{32}$/);
    expect(getUserByWishlistToken(t1)).toBeNull();
    expect(getUserByWishlistToken(t2)?.id).toBe(u);
  });

  it('getUserByWishlistToken returns null on an unknown token', () => {
    expect(getUserByWishlistToken('wl_nope')).toBeNull();
  });
});

describe('setTrackerWishlistFlag', () => {
  it('flips the flag and is ownership-scoped (cross-user returns false)', () => {
    const u1 = seedUser('a@x.com');
    const u2 = seedUser('b@x.com');
    const t = createTracker({ name: 'T', url: 'https://x', user_id: u1 });
    expect(setTrackerWishlistFlag(t.id, u1, true)).toBe(true);
    expect(isTrackerInUsersWishlist(t.id, u1)).toBe(true);
    // Cross-user write must not succeed and must not flip the flag.
    expect(setTrackerWishlistFlag(t.id, u2, false)).toBe(false);
    expect(isTrackerInUsersWishlist(t.id, u1)).toBe(true);
  });

  it('returns false on unknown tracker id', () => {
    const u = seedUser('a@x.com');
    expect(setTrackerWishlistFlag(99999, u, true)).toBe(false);
  });
});

describe('getOwnerWishlist', () => {
  it('returns ONLY wishlisted trackers (no claim columns)', () => {
    const u = seedUser('a@x.com');
    const t1 = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    const t2 = createTracker({ name: 'B', url: 'https://x/2', user_id: u });
    setTrackerWishlistFlag(t1.id, u, true);
    // t2 NOT wishlisted; should be excluded.
    const items = getOwnerWishlist(u);
    expect(items.map(i => i.id)).toEqual([t1.id]);
    // No claim columns leaked into the row.
    expect(Object.keys(items[0])).not.toContain('claim_token');
    expect(Object.keys(items[0])).not.toContain('claimed_at');
    // (t2 referenced for clarity that we created it but it's filtered out.)
    expect(t2.id).not.toBe(t1.id);
  });

  it('returns empty list when the user has no wishlisted trackers', () => {
    const u = seedUser('a@x.com');
    createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    expect(getOwnerWishlist(u)).toHaveLength(0);
  });
});

describe('getPublicWishlistByToken', () => {
  it('returns null on a bad token', () => {
    expect(getPublicWishlistByToken('wl_no_match')).toBeNull();
  });

  it('returns wishlisted items with is_claimed correctly populated', () => {
    const u = seedUser('a@x.com', 'Alice');
    const t1 = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    const t2 = createTracker({ name: 'B', url: 'https://x/2', user_id: u });
    setTrackerWishlistFlag(t1.id, u, true);
    setTrackerWishlistFlag(t2.id, u, true);
    const claim = createWishlistClaim(t1.id);
    expect('claim_token' in claim).toBe(true);
    const token = generateOrGetWishlistShareToken(u);

    const data = getPublicWishlistByToken(token);
    expect(data).not.toBeNull();
    expect(data!.display_name).toBe('Alice');
    expect(data!.items).toHaveLength(2);
    const a = data!.items.find(i => i.tracker_id === t1.id)!;
    const b = data!.items.find(i => i.tracker_id === t2.id)!;
    expect(a.is_claimed).toBe(true);
    expect(b.is_claimed).toBe(false);
  });

  it('exposes share_display_name_on flag derived from the user setting', () => {
    const u = seedUser('a@x.com', 'Alice');
    const token = generateOrGetWishlistShareToken(u);
    // Default = false (setting not present)
    expect(getPublicWishlistByToken(token)?.share_display_name_on).toBe(false);
    setSetting('share_display_name', 'true', u);
    expect(getPublicWishlistByToken(token)?.share_display_name_on).toBe(true);
  });

  it('does not include threshold_price on returned items', () => {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', threshold_price: 50, user_id: u });
    setTrackerWishlistFlag(t.id, u, true);
    const token = generateOrGetWishlistShareToken(u);
    const data = getPublicWishlistByToken(token)!;
    expect(Object.keys(data.items[0])).not.toContain('threshold_price');
  });
});

describe('claims', () => {
  it('createWishlistClaim returns a claim_token on first call and 409 on second', () => {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    setTrackerWishlistFlag(t.id, u, true);
    const r1 = createWishlistClaim(t.id);
    expect('claim_token' in r1).toBe(true);
    const r2 = createWishlistClaim(t.id);
    expect('error' in r2 && r2.error).toBe('already_claimed');
  });

  it('deleteWishlistClaim succeeds with right token, fails with wrong token', () => {
    const u = seedUser('a@x.com');
    const t = createTracker({ name: 'A', url: 'https://x/1', user_id: u });
    setTrackerWishlistFlag(t.id, u, true);
    const r = createWishlistClaim(t.id) as { claim_token: string };
    expect(deleteWishlistClaim(t.id, 'wc_wrong')).toBe(false);
    expect(deleteWishlistClaim(t.id, r.claim_token)).toBe(true);
    // After successful delete, a re-claim should succeed.
    expect('claim_token' in createWishlistClaim(t.id)).toBe(true);
  });
});
