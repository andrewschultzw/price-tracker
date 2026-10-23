import { describe, it, expect, vi } from 'vitest';
import type { Response } from 'express';
import { resolveCookieSecure } from '../config.js';
import { setAuthCookies, clearAuthCookies } from './tokens.js';

// ---------------------------------------------------------------------------
// resolveCookieSecure — the COOKIE_SECURE override (issue #76)
// ---------------------------------------------------------------------------

describe('resolveCookieSecure', () => {
  it('defaults to true in production', () => {
    expect(resolveCookieSecure({ NODE_ENV: 'production' })).toBe(true);
  });

  it('defaults to false outside production', () => {
    expect(resolveCookieSecure({ NODE_ENV: 'development' })).toBe(false);
    expect(resolveCookieSecure({})).toBe(false);
  });

  it('COOKIE_SECURE=false disables Secure even in production (HTTP homelab deploy)', () => {
    expect(resolveCookieSecure({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toBe(false);
  });

  it('COOKIE_SECURE=true forces Secure outside production', () => {
    expect(resolveCookieSecure({ NODE_ENV: 'development', COOKIE_SECURE: 'true' })).toBe(true);
  });

  it('empty COOKIE_SECURE falls through to the NODE_ENV default', () => {
    expect(resolveCookieSecure({ NODE_ENV: 'production', COOKIE_SECURE: '' })).toBe(true);
    expect(resolveCookieSecure({ NODE_ENV: 'development', COOKIE_SECURE: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setAuthCookies / clearAuthCookies — cookie attributes
// ---------------------------------------------------------------------------

function mockResponse() {
  return {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
  } as unknown as Response & { cookie: ReturnType<typeof vi.fn>; clearCookie: ReturnType<typeof vi.fn> };
}

describe('setAuthCookies', () => {
  it('sets both cookies httpOnly + sameSite=strict with secure from config, refresh scoped to /api/auth', () => {
    const res = mockResponse();
    setAuthCookies(res, 'access-tok', 'refresh-tok');

    expect(res.cookie).toHaveBeenCalledTimes(2);
    const [accessName, accessVal, accessOpts] = res.cookie.mock.calls[0];
    const [refreshName, refreshVal, refreshOpts] = res.cookie.mock.calls[1];

    expect(accessName).toBe('access_token');
    expect(accessVal).toBe('access-tok');
    expect(refreshName).toBe('refresh_token');
    expect(refreshVal).toBe('refresh-tok');

    for (const opts of [accessOpts, refreshOpts]) {
      expect(opts.httpOnly).toBe(true);
      expect(opts.sameSite).toBe('strict');
      // Tests run without NODE_ENV=production or COOKIE_SECURE, so the
      // resolved default is false; the point is it's the CONFIG value,
      // not a hardcoded true (which broke HTTP deploys, issue #76).
      expect(opts.secure).toBe(resolveCookieSecure());
    }
    expect(accessOpts.path).toBe('/');
    expect(refreshOpts.path).toBe('/api/auth');
    expect(accessOpts.maxAge).toBeGreaterThan(0);
    expect(refreshOpts.maxAge).toBeGreaterThan(accessOpts.maxAge);
  });
});

describe('clearAuthCookies', () => {
  it('clears both cookies with matching attributes (required for removal to take effect)', () => {
    const res = mockResponse();
    clearAuthCookies(res);

    expect(res.clearCookie).toHaveBeenCalledTimes(2);
    const [accessName, accessOpts] = res.clearCookie.mock.calls[0];
    const [refreshName, refreshOpts] = res.clearCookie.mock.calls[1];

    expect(accessName).toBe('access_token');
    expect(refreshName).toBe('refresh_token');
    expect(accessOpts.path).toBe('/');
    expect(refreshOpts.path).toBe('/api/auth');
    for (const opts of [accessOpts, refreshOpts]) {
      expect(opts.httpOnly).toBe(true);
      expect(opts.secure).toBe(resolveCookieSecure());
    }
  });
});
