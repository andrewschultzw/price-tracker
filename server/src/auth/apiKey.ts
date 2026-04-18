import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { config, isApiKeyConfigured } from '../config.js';
import { getUserById } from '../db/user-queries.js';
import { logger } from '../logger.js';

/**
 * X-API-Key auth middleware. Mounted BEFORE the JWT cookie middleware
 * on /api/* routes. Behavior:
 *
 *   - Header absent or empty   → next() with req.user unset; JWT handles it
 *   - Header present + API key auth not configured → 401
 *   - Header present + matches configured key      → sets req.user from
 *     getUserById(PRICE_TRACKER_API_KEY_USER_ID) and calls next()
 *   - Header present + wrong / mismatched length   → 401
 *
 * Uses timingSafeEqual over equal-length Buffers so a mismatched length
 * doesn't crash and a right-prefix doesn't leak information via timing.
 * Never logs the incoming header or the configured key. Successful
 * requests log at info level with a fixed "api-key" source tag for
 * audit purposes.
 */
export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.header('x-api-key');

  // Missing / empty header: let the next middleware (JWT) handle auth.
  if (!headerValue) {
    next();
    return;
  }

  // Header set but API key auth not configured on this deploy → fail
  // closed. Matches the principle: if someone is reaching for header
  // auth, the server shouldn't silently accept/deny without reason.
  if (!isApiKeyConfigured()) {
    res.status(401).json({ error: 'API key auth not configured' });
    return;
  }

  // Constant-time compare over equal-length buffers. If the lengths
  // differ, skip the compare entirely and 401 — timingSafeEqual would
  // throw on length mismatch otherwise.
  const expected = Buffer.from(config.priceTrackerApiKey);
  const got = Buffer.from(headerValue);
  const matches = got.length === expected.length && timingSafeEqual(got, expected);

  if (!matches) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  // Key is good. Look up the configured user so role-gated middleware
  // (e.g., adminMiddleware) still works downstream.
  const user = getUserById(config.priceTrackerApiKeyUserId);
  if (!user) {
    logger.warn(
      { userId: config.priceTrackerApiKeyUserId },
      'API key matched but PRICE_TRACKER_API_KEY_USER_ID does not exist',
    );
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  req.user = { userId: user.id, email: user.email, role: user.role };

  logger.info(
    { source: 'api-key', path: req.path, method: req.method, userId: user.id },
    'API key auth succeeded',
  );

  next();
}
