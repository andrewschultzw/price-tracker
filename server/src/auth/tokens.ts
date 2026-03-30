import jwt from 'jsonwebtoken';
import { randomBytes, createHash } from 'crypto';
import type { Response } from 'express';
import { config } from '../config.js';

export interface TokenPayload {
  userId: number;
  email: string;
  role: string;
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtAccessExpirySeconds,
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, config.jwtSecret) as TokenPayload;
}

export function generateRefreshToken(): string {
  return randomBytes(64).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict' as const,
    path: '/',
  };

  res.cookie('access_token', accessToken, {
    ...cookieOptions,
    maxAge: config.jwtAccessExpirySeconds * 1000,
  });

  res.cookie('refresh_token', refreshToken, {
    ...cookieOptions,
    maxAge: config.jwtRefreshExpiryDays * 24 * 60 * 60 * 1000,
    path: '/api/auth',
  });
}

export function clearAuthCookies(res: Response): void {
  const cookieOptions = {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: 'strict' as const,
    path: '/',
  };

  res.clearCookie('access_token', cookieOptions);
  res.clearCookie('refresh_token', { ...cookieOptions, path: '/api/auth' });
}
