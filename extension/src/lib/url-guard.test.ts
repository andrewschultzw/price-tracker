import { describe, it, expect } from 'vitest';
import {
  unsupportedReason,
  isBlockedRetailerHost,
  blockedRetailerReason,
  getBlockedRetailerHosts,
} from './url-guard.js';

describe('unsupportedReason', () => {
  describe('returns null (i.e. trackable) for', () => {
    it('a real https product page', () => {
      expect(unsupportedReason('https://www.amazon.com/dp/B01N5IB20Q')).toBeNull();
    });

    it('a real http product page (rare, but valid)', () => {
      expect(unsupportedReason('http://example.com/p/1')).toBeNull();
    });

    it('a hostname with subdomain', () => {
      expect(unsupportedReason('https://smile.amazon.com/dp/B01')).toBeNull();
    });

    it('paths with query params', () => {
      expect(unsupportedReason('https://newegg.com/p/abc?tag=foo&ref=bar')).toBeNull();
    });
  });

  describe('returns a reason for', () => {
    it('chrome:// internal pages', () => {
      // The exact reason includes the protocol name so the user knows
      // which page they're on can't be tracked.
      expect(unsupportedReason('chrome://settings')).toMatch(/^chrome:\/\//);
    });

    it('about: pages', () => {
      expect(unsupportedReason('about:blank')).toMatch(/^about:\/\//);
    });

    it('file:// pages', () => {
      expect(unsupportedReason('file:///home/user/page.html')).toMatch(/^file:\/\//);
    });

    it('javascript: URLs', () => {
      expect(unsupportedReason('javascript:void(0)')).toMatch(/^javascript:\/\//);
    });

    it('localhost (no dot in hostname)', () => {
      // Real http(s), but localhost isn't a real retailer — guards against
      // accidentally tracking a dev server.
      expect(unsupportedReason('http://localhost:3000/p/1')).toBe(
        'This page doesn\'t look like a retailer product page.',
      );
    });

    it('IP-literal hostname', () => {
      // 192.168.1.1 has dots but the regex requires letters in the TLD,
      // which rules out IP literals. Treat them as not real product
      // pages — a tracker with a LAN IP can't be scraped by the prod
      // service anyway.
      expect(unsupportedReason('http://192.168.1.1/p/1')).toBe(
        'This page doesn\'t look like a retailer product page.',
      );
    });

    it('completely malformed URL', () => {
      expect(unsupportedReason('not-a-url')).toMatch(/usable URL/);
      expect(unsupportedReason('')).toMatch(/usable URL/);
    });
  });
});

describe('isBlockedRetailerHost', () => {
  it('matches known-blocked hosts with and without www.', () => {
    expect(isBlockedRetailerHost('https://homedepot.com/p/x/123')).toBe(true);
    expect(isBlockedRetailerHost('https://www.homedepot.com/p/x/123')).toBe(true);
    expect(isBlockedRetailerHost('https://bestbuy.com/site/123')).toBe(true);
    expect(isBlockedRetailerHost('https://www.bestbuy.com/site/123')).toBe(true);
  });

  it('case-insensitive matching', () => {
    expect(isBlockedRetailerHost('https://HomeDepot.com/p/x')).toBe(true);
    expect(isBlockedRetailerHost('https://BESTBUY.COM/site')).toBe(true);
  });

  it('returns false for non-blocked retailers', () => {
    expect(isBlockedRetailerHost('https://www.amazon.com/dp/B0XYZ')).toBe(false);
    expect(isBlockedRetailerHost('https://newegg.com/p/abc')).toBe(false);
  });

  it('returns false for invalid URLs', () => {
    expect(isBlockedRetailerHost('not a url')).toBe(false);
    expect(isBlockedRetailerHost('')).toBe(false);
  });

  it('does not substring-match on lookalike hosts', () => {
    expect(isBlockedRetailerHost('https://homedepot.com.evil.example/p/x')).toBe(false);
    expect(isBlockedRetailerHost('https://fakehomedepot.com/p/x')).toBe(false);
  });
});

describe('blockedRetailerReason', () => {
  it('returns a Home-Depot-branded reason for homedepot.com', () => {
    expect(blockedRetailerReason('https://www.homedepot.com/p/x/123')).toMatch(/Home Depot/);
    expect(blockedRetailerReason('https://www.homedepot.com/p/x/123')).toMatch(/scraper/i);
  });

  it('returns a Best-Buy-branded reason for bestbuy.com', () => {
    expect(blockedRetailerReason('https://www.bestbuy.com/site/12345.p')).toMatch(/Best Buy/);
  });

  it('returns null for non-blocked retailers', () => {
    expect(blockedRetailerReason('https://www.amazon.com/dp/B0XYZ')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(blockedRetailerReason('not a url')).toBeNull();
  });
});

describe('getBlockedRetailerHosts', () => {
  it('exposes the host list for the parity test', () => {
    const hosts = getBlockedRetailerHosts();
    expect(hosts).toContain('homedepot.com');
    expect(hosts).toContain('bestbuy.com');
  });
});
