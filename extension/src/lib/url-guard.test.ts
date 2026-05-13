import { describe, it, expect } from 'vitest';
import { unsupportedReason } from './url-guard.js';

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
