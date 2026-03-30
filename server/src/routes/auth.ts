import { Router, Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { hashPassword, verifyPassword } from '../auth/passwords.js';
import {
  signAccessToken, generateRefreshToken, hashToken,
  setAuthCookies, clearAuthCookies,
} from '../auth/tokens.js';
import { authMiddleware } from '../auth/middleware.js';
import {
  getUserByEmail, getUserById, createUser, getUserCount,
  getInviteByCode, markInviteUsed,
  storeRefreshToken, getRefreshTokenByHash,
  deleteRefreshToken, deleteAllRefreshTokensForUser,
  assignOrphanedTrackersToUser, assignOrphanedSettingsToUser,
  getSafeUserById,
} from '../db/user-queries.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  display_name: z.string().min(1).max(100),
  invite_code: z.string().optional(),
  setup_token: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

let setupToken: string | null = null;

export function getSetupToken(): string | null {
  return setupToken;
}

export function generateSetupToken(): string {
  setupToken = randomBytes(32).toString('hex');
  return setupToken;
}

// POST /api/auth/register
router.post('/register', async (req: Request, res: Response) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { email, password, display_name, invite_code, setup_token: reqSetupToken } = parsed.data;

  const userCount = getUserCount();
  const isFirstUser = userCount === 0;

  if (isFirstUser) {
    if (!reqSetupToken || reqSetupToken !== setupToken) {
      res.status(403).json({ error: 'Invalid setup token' });
      return;
    }
  } else {
    if (!invite_code) {
      res.status(400).json({ error: 'Invite code is required' });
      return;
    }

    const invite = getInviteByCode(invite_code);
    if (!invite) {
      res.status(400).json({ error: 'Invalid invite code' });
      return;
    }
    if (invite.used_by) {
      res.status(400).json({ error: 'Invite code has already been used' });
      return;
    }
    if (invite.expires_at && new Date(invite.expires_at + 'Z') < new Date()) {
      res.status(400).json({ error: 'Invite code has expired' });
      return;
    }
  }

  if (getUserByEmail(email)) {
    res.status(409).json({ error: 'Email already registered' });
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = createUser({
    email,
    password_hash: passwordHash,
    display_name,
    role: isFirstUser ? 'admin' : 'user',
  });

  if (!isFirstUser && invite_code) {
    markInviteUsed(invite_code, user.id);
  }

  if (isFirstUser) {
    const trackers = assignOrphanedTrackersToUser(user.id);
    const settings = assignOrphanedSettingsToUser(user.id);
    logger.info({ userId: user.id, trackers, settings }, 'Assigned orphaned data to admin user');
    setupToken = null;
  }

  const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.jwtRefreshExpiryDays * 24 * 60 * 60 * 1000).toISOString();
  storeRefreshToken(user.id, refreshToken, expiresAt);

  setAuthCookies(res, accessToken, refreshToken);
  res.status(201).json({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  });
});

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid credentials' });
    return;
  }

  const { email, password } = parsed.data;
  const user = getUserByEmail(email);

  if (!user || !await verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  if (!user.is_active) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  const accessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.jwtRefreshExpiryDays * 24 * 60 * 60 * 1000).toISOString();
  storeRefreshToken(user.id, refreshToken, expiresAt);

  setAuthCookies(res, accessToken, refreshToken);
  res.json({
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    role: user.role,
  });
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refresh_token;
  if (refreshToken) {
    const tokenHash = hashToken(refreshToken);
    const stored = getRefreshTokenByHash(tokenHash);
    if (stored) {
      deleteRefreshToken(stored.id);
    }
  }
  clearAuthCookies(res);
  res.json({ success: true });
});

// POST /api/auth/refresh
router.post('/refresh', (req: Request, res: Response) => {
  const refreshToken = req.cookies?.refresh_token;
  if (!refreshToken) {
    res.status(401).json({ error: 'No refresh token' });
    return;
  }

  const tokenHash = hashToken(refreshToken);
  const stored = getRefreshTokenByHash(tokenHash);

  if (!stored) {
    clearAuthCookies(res);
    res.status(401).json({ error: 'Invalid refresh token' });
    return;
  }

  if (new Date(stored.expires_at + 'Z') < new Date()) {
    deleteRefreshToken(stored.id);
    clearAuthCookies(res);
    res.status(401).json({ error: 'Refresh token expired' });
    return;
  }

  const user = getUserById(stored.user_id);
  if (!user || !user.is_active) {
    deleteAllRefreshTokensForUser(stored.user_id);
    clearAuthCookies(res);
    res.status(401).json({ error: 'Account deactivated' });
    return;
  }

  deleteRefreshToken(stored.id);
  const newAccessToken = signAccessToken({ userId: user.id, email: user.email, role: user.role });
  const newRefreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + config.jwtRefreshExpiryDays * 24 * 60 * 60 * 1000).toISOString();
  storeRefreshToken(user.id, newRefreshToken, expiresAt);

  setAuthCookies(res, newAccessToken, newRefreshToken);
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  const user = getSafeUserById(req.user!.userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json(user);
});

// GET /api/auth/setup-status
router.get('/setup-status', (_req: Request, res: Response) => {
  const userCount = getUserCount();
  res.json({ needsSetup: userCount === 0, hasSetupToken: setupToken !== null });
});

export default router;
