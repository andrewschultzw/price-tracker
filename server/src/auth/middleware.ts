import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type TokenPayload } from './tokens.js';

declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // If an earlier middleware (e.g., apiKeyMiddleware) has already set
  // req.user, skip the cookie check — the request is already authenticated.
  if (req.user) {
    next();
    return;
  }

  const token = req.cookies?.access_token;

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function adminMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}
