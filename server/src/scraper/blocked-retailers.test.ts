import { describe, it, expect } from 'vitest';
import {
  isBlockedRetailerHost,
  getBlockedRetailerHosts,
  RETAILER_BLOCKED_ERROR_MESSAGE,
} from './blocked-retailers.js';
import { isRetailerBlock } from './browser.js';

describe('isBlockedRetailerHost', () => {
  it('matches known-blocked hosts with and without www.', () => {
    expect(isBlockedRetailerHost('https://homedepot.com/p/x/123')).toBe(true);
    expect(isBlockedRetailerHost('https://www.homedepot.com/p/x/123')).toBe(true);
    expect(isBlockedRetailerHost('https://bestbuy.com/site/123')).toBe(true);
    expect(isBlockedRetailerHost('https://www.bestbuy.com/site/123')).toBe(true);
  });

  it('case-insensitive host matching', () => {
    expect(isBlockedRetailerHost('https://HomeDepot.com/p/x')).toBe(true);
    expect(isBlockedRetailerHost('https://BESTBUY.COM/site')).toBe(true);
  });

  it('returns false for non-blocked retailers', () => {
    expect(isBlockedRetailerHost('https://www.amazon.com/dp/B0XYZ')).toBe(false);
    expect(isBlockedRetailerHost('https://newegg.com/p/abc')).toBe(false);
    expect(isBlockedRetailerHost('https://target.com/p/abc')).toBe(false);
  });

  it('returns false for invalid URLs (caller validates separately)', () => {
    expect(isBlockedRetailerHost('not a url')).toBe(false);
    expect(isBlockedRetailerHost('')).toBe(false);
  });

  it('does not over-match on substring hosts', () => {
    // Domain ends in homedepot.com — phishy lookalike, not the real site.
    // Our matcher uses hostname equality, so a different host like
    // "fakehomedepot.com" or "homedepot.com.evil.example" should NOT match.
    expect(isBlockedRetailerHost('https://fakehomedepot.com/p/x')).toBe(false);
    expect(isBlockedRetailerHost('https://homedepot.com.evil.example/p/x')).toBe(false);
  });

  it('exposes the host list for admin tooling / docs', () => {
    const hosts = getBlockedRetailerHosts();
    expect(hosts).toContain('homedepot.com');
    expect(hosts).toContain('bestbuy.com');
  });

  it('exports a stable, user-facing error message', () => {
    // The string is rendered in the UI as the seller's last_error and is
    // matched on (or near-matched on) by callers. Pin it down so an
    // accidental edit can't silently break the message contract.
    expect(RETAILER_BLOCKED_ERROR_MESSAGE).toMatch(/blocks automated requests/i);
  });
});

describe('isRetailerBlock', () => {
  it('flags Akamai 403 as a retailer block', () => {
    expect(isRetailerBlock(403, { server: 'AkamaiGHost' })).toBe(true);
    // Header values are case-insensitive per HTTP spec; tolerant on case.
    expect(isRetailerBlock(403, { server: 'akamaighost' })).toBe(true);
  });

  it('flags Akamai 429 (rate-limited) as a retailer block', () => {
    // 429 from the same WAF is functionally identical for our purposes —
    // automated requests are being filtered out at the edge.
    expect(isRetailerBlock(429, { server: 'AkamaiGHost' })).toBe(true);
  });

  it('flags Cloudflare bot-mitigation 403 as a retailer block', () => {
    expect(isRetailerBlock(403, { server: 'cloudflare', 'cf-mitigated': 'challenge' })).toBe(true);
  });

  it('does NOT flag plain Cloudflare 403 without cf-mitigated header', () => {
    // Generic CF 403s (e.g., country block, payment required, normal 4xx
    // responses) shouldn't get mis-classified as bot-blocks. The
    // cf-mitigated header is the explicit signal.
    expect(isRetailerBlock(403, { server: 'cloudflare' })).toBe(false);
  });

  it('does NOT flag non-403/429 statuses even from blocking servers', () => {
    expect(isRetailerBlock(404, { server: 'AkamaiGHost' })).toBe(false);
    expect(isRetailerBlock(500, { server: 'AkamaiGHost' })).toBe(false);
    expect(isRetailerBlock(200, { server: 'AkamaiGHost' })).toBe(false);
  });

  it('does NOT flag 403 from unknown servers (be conservative)', () => {
    expect(isRetailerBlock(403, { server: 'nginx' })).toBe(false);
    expect(isRetailerBlock(403, {})).toBe(false);
  });
});
