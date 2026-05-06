import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual, createHash } from 'crypto';
import { getUserById } from '../db/user-queries.js';
import { findActiveTokenByHash, touchTokenLastUsed } from '../db/queries.js';
import { logger } from '../logger.js';

export function apiKeyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const headerValue = req.header('x-api-key');

  if (!headerValue) {
    next();
    return;
  }

  // Branch 1 — global PRICE_TRACKER_API_KEY (OpenClaw-style shared key).
  // Read from process.env at runtime to allow test env mutations.
  const globalApiKey = process.env.PRICE_TRACKER_API_KEY || '';
  const globalApiKeyUserId = parseInt(process.env.PRICE_TRACKER_API_KEY_USER_ID || '0', 10);
  const isGlobalKeyConfigured = !!(globalApiKey && globalApiKeyUserId > 0);

  if (isGlobalKeyConfigured) {
    const expected = Buffer.from(globalApiKey);
    const got = Buffer.from(headerValue);
    if (got.length === expected.length && timingSafeEqual(got, expected)) {
      const user = getUserById(globalApiKeyUserId);
      if (!user) {
        logger.warn(
          { userId: globalApiKeyUserId },
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
      return;
    }
  }

  // Branch 2 — per-user token. Hash the incoming header and look up.
  const hash = createHash('sha256').update(headerValue).digest('hex');
  const token = findActiveTokenByHash(hash);
  if (token) {
    const user = getUserById(token.user_id);
    if (!user) {
      logger.warn({ tokenId: token.id, userId: token.user_id }, 'User token matched but user missing');
      res.status(401).json({ error: 'Invalid API key' });
      return;
    }
    touchTokenLastUsed(token.id);
    req.user = { userId: user.id, email: user.email, role: user.role };
    logger.info(
      { source: 'user-token', path: req.path, method: req.method, userId: user.id, tokenId: token.id },
      'API key auth succeeded',
    );
    next();
    return;
  }

  logger.info({ prefix: headerValue.slice(0, 8) }, 'api_token_auth_failed');
  res.status(401).json({ error: 'Invalid API key' });
}
