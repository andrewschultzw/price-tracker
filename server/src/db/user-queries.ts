import { randomBytes } from 'crypto';
import { getDb } from './connection.js';
import { hashToken } from '../auth/tokens.js';

export interface User {
  id: number;
  email: string;
  password_hash: string;
  display_name: string;
  role: 'admin' | 'user';
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface SafeUser {
  id: number;
  email: string;
  display_name: string;
  role: 'admin' | 'user';
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface AdminUserRow extends SafeUser {
  tracker_count: number;
}

export interface InviteCode {
  id: number;
  code: string;
  created_by: number;
  used_by: number | null;
  expires_at: string | null;
  created_at: string;
}

// --- Users ---

export function getUserByEmail(email: string): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE email = ?').get(email) as User | undefined;
}

export function getUserById(id: number): User | undefined {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
}

export function getSafeUserById(id: number): SafeUser | undefined {
  return getDb().prepare(
    'SELECT id, email, display_name, role, is_active, created_at, updated_at FROM users WHERE id = ?'
  ).get(id) as SafeUser | undefined;
}

export function createUser(data: {
  email: string;
  password_hash: string;
  display_name: string;
  role?: 'admin' | 'user';
}): User {
  const stmt = getDb().prepare(`
    INSERT INTO users (email, password_hash, display_name, role)
    VALUES (@email, @password_hash, @display_name, @role)
  `);
  const result = stmt.run({
    email: data.email,
    password_hash: data.password_hash,
    display_name: data.display_name,
    role: data.role ?? 'user',
  });
  return getUserById(Number(result.lastInsertRowid))!;
}

export function getUserCount(): number {
  return (getDb().prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
}

export function getAllUsers(): SafeUser[] {
  return getDb().prepare(
    'SELECT id, email, display_name, role, is_active, created_at, updated_at FROM users ORDER BY created_at DESC'
  ).all() as SafeUser[];
}

/**
 * Admin users list with per-user tracker count. Left join so users with
 * zero trackers still appear (COUNT returns 0 rather than excluding them).
 */
export function getAllUsersForAdmin(): AdminUserRow[] {
  return getDb().prepare(`
    SELECT
      u.id, u.email, u.display_name, u.role, u.is_active,
      u.created_at, u.updated_at,
      COUNT(t.id) as tracker_count
    FROM users u
    LEFT JOIN trackers t ON t.user_id = u.id
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `).all() as AdminUserRow[];
}

export function updateUser(id: number, data: Partial<{ role: string; is_active: number }>): SafeUser | undefined {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(data)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return getSafeUserById(id);

  fields.push("updated_at = datetime('now')");
  getDb().prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = @id`).run(values);
  return getSafeUserById(id);
}

export function deleteUser(id: number): boolean {
  const result = getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
  return result.changes > 0;
}

export function getActiveAdminCount(): number {
  return (getDb().prepare(
    "SELECT COUNT(*) as count FROM users WHERE role = 'admin' AND is_active = 1"
  ).get() as { count: number }).count;
}

export function resetUserPassword(id: number, passwordHash: string): boolean {
  const result = getDb().prepare(
    "UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(passwordHash, id);
  return result.changes > 0;
}

// --- Invite Codes ---

export function createInviteCode(createdBy: number, expiresAt?: string): InviteCode {
  const code = randomBytes(12).toString('hex');
  const stmt = getDb().prepare(`
    INSERT INTO invite_codes (code, created_by, expires_at)
    VALUES (@code, @created_by, @expires_at)
  `);
  const result = stmt.run({
    code,
    created_by: createdBy,
    expires_at: expiresAt ?? null,
  });
  return getDb().prepare('SELECT * FROM invite_codes WHERE id = ?').get(Number(result.lastInsertRowid)) as InviteCode;
}

export function getInviteByCode(code: string): InviteCode | undefined {
  return getDb().prepare('SELECT * FROM invite_codes WHERE code = ?').get(code) as InviteCode | undefined;
}

export function markInviteUsed(code: string, usedBy: number): void {
  getDb().prepare('UPDATE invite_codes SET used_by = ? WHERE code = ?').run(usedBy, code);
}

export function getAllInviteCodes(): InviteCode[] {
  return getDb().prepare('SELECT * FROM invite_codes ORDER BY created_at DESC').all() as InviteCode[];
}

export function deleteInviteCode(id: number): boolean {
  const result = getDb().prepare('DELETE FROM invite_codes WHERE id = ? AND used_by IS NULL').run(id);
  return result.changes > 0;
}

// --- Refresh Tokens ---

export function storeRefreshToken(userId: number, token: string, expiresAt: string): void {
  const tokenHash = hashToken(token);
  getDb().prepare(`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, tokenHash, expiresAt);
}

export function getRefreshTokenByHash(tokenHash: string): { id: number; user_id: number; expires_at: string } | undefined {
  return getDb().prepare(
    'SELECT id, user_id, expires_at FROM refresh_tokens WHERE token_hash = ?'
  ).get(tokenHash) as { id: number; user_id: number; expires_at: string } | undefined;
}

export function deleteRefreshToken(id: number): void {
  getDb().prepare('DELETE FROM refresh_tokens WHERE id = ?').run(id);
}

export function deleteAllRefreshTokensForUser(userId: number): void {
  getDb().prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
}

export function deleteExpiredRefreshTokens(): void {
  getDb().prepare("DELETE FROM refresh_tokens WHERE expires_at <= datetime('now')").run();
}

// --- Orphan Assignment (first-run migration) ---

export function assignOrphanedTrackersToUser(userId: number): number {
  const result = getDb().prepare('UPDATE trackers SET user_id = ? WHERE user_id IS NULL').run(userId);
  return result.changes;
}

export function assignOrphanedSettingsToUser(userId: number): number {
  const result = getDb().prepare('UPDATE settings SET user_id = ? WHERE user_id IS NULL').run(userId);
  return result.changes;
}
