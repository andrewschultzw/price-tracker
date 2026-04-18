import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

// Mock config and user-queries before importing the module under test.
vi.mock('../config.js', () => ({
  config: {
    priceTrackerApiKey: 'test-api-key-123456',
    priceTrackerApiKeyUserId: 7,
  },
  isApiKeyConfigured: () => true,
}));

vi.mock('../db/user-queries.js', () => ({
  getUserById: vi.fn((id: number) => {
    if (id === 7) {
      return { id: 7, email: 'admin@example.com', role: 'admin' };
    }
    return undefined;
  }),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { apiKeyMiddleware } from './apiKey.js';

function makeReqResNext(header?: string) {
  const req = { header: vi.fn((name: string) => (name.toLowerCase() === 'x-api-key' ? header : undefined)), path: '/api/trackers', method: 'POST' } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

describe('apiKeyMiddleware', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('calls next() without setting req.user when header is absent', () => {
    const { req, res, next } = makeReqResNext(undefined);
    apiKeyMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('calls next() when header is the empty string (treated as absent)', () => {
    const { req, res, next } = makeReqResNext('');
    apiKeyMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toBeUndefined();
  });

  it('sets req.user and calls next() on a matching key', () => {
    const { req, res, next } = makeReqResNext('test-api-key-123456');
    apiKeyMiddleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toEqual({ userId: 7, email: 'admin@example.com', role: 'admin' });
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 on a wrong key', () => {
    const { req, res, next } = makeReqResNext('wrong-key');
    apiKeyMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' });
  });

  it('returns 401 on a mismatched-length key without crashing', () => {
    const { req, res, next } = makeReqResNext('short');
    apiKeyMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 401 when the mapped user does not exist in the DB', async () => {
    const userQueries = await import('../db/user-queries.js');
    (userQueries.getUserById as any).mockReturnValueOnce(undefined);
    const { req, res, next } = makeReqResNext('test-api-key-123456');
    apiKeyMiddleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('apiKeyMiddleware when API key auth is not configured', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('returns 401 when a header is set but auth is unconfigured', async () => {
    vi.doMock('../config.js', () => ({
      config: { priceTrackerApiKey: '', priceTrackerApiKeyUserId: 0 },
      isApiKeyConfigured: () => false,
    }));
    vi.resetModules();
    const { apiKeyMiddleware: mw } = await import('./apiKey.js');
    const { req, res, next } = makeReqResNext('anything');
    mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'API key auth not configured' });
    vi.doUnmock('../config.js');
    vi.resetModules();
  });

  it('calls next() without setting req.user when header absent AND unconfigured (fall-through to JWT)', async () => {
    vi.doMock('../config.js', () => ({
      config: { priceTrackerApiKey: '', priceTrackerApiKeyUserId: 0 },
      isApiKeyConfigured: () => false,
    }));
    vi.resetModules();
    const { apiKeyMiddleware: mw } = await import('./apiKey.js');
    const { req, res, next } = makeReqResNext(undefined);
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toBeUndefined();
    vi.doUnmock('../config.js');
    vi.resetModules();
  });
});
