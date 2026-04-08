import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';

/**
 * At-rest encryption for sensitive settings (Discord webhook URLs, ntfy
 * topic URLs, generic webhook URLs). These are effectively credentials:
 * anyone who knows the URL can publish to your Discord channel or ntfy
 * topic. Storing them plaintext in sqlite meant a leaked database backup
 * would hand those credentials over.
 *
 * Scheme:
 *   - AES-256-GCM authenticated encryption
 *   - 32-byte key derived from SETTINGS_ENCRYPTION_KEY env var (either a
 *     base64-encoded 32-byte key, or arbitrary input that we hash to 32
 *     bytes via SHA-256 for operator convenience)
 *   - Per-value random 12-byte IV
 *   - Storage format: `v1:<base64(iv | ciphertext | authTag)>`
 *
 * The `v1:` prefix lets us introduce key rotation or a new cipher later
 * without a breaking DB migration — future versions just check the prefix
 * and decrypt with the appropriate key/algorithm.
 *
 * On GCM: each (key, IV) pair must be unique. We use crypto.randomBytes
 * for each IV so collision is statistically impossible.
 */

const VERSION = 'v1';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;
const AUTH_TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

export class SettingsCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsCryptoError';
  }
}

/**
 * Derive a 32-byte key from the env var. Accepts either a base64-encoded
 * 32-byte key (preferred, high-entropy) or any string (which we SHA-256 to
 * get a 32-byte derived key as an operator convenience). Both paths are
 * deterministic given the input.
 */
export function deriveKey(input: string): Buffer {
  if (!input) throw new SettingsCryptoError('Encryption key input is empty');
  // Try base64 decode first — a correctly-sized result means it was meant
  // to be the raw key.
  try {
    const decoded = Buffer.from(input, 'base64');
    if (decoded.length === KEY_BYTES) return decoded;
  } catch {
    // fallthrough to SHA-256 derivation
  }
  // Fallback: SHA-256 of the raw input. Lower entropy than a proper random
  // key but lets an operator use a passphrase without preprocessing.
  return createHash('sha256').update(input, 'utf8').digest();
}

/**
 * Initialize the module with the key material. Must be called once at
 * startup before encrypt/decrypt are used.
 */
export function initSettingsCrypto(keyInput: string | undefined | null): void {
  if (!keyInput) {
    throw new SettingsCryptoError(
      'SETTINGS_ENCRYPTION_KEY is required. Generate one with: ' +
      'node -e "console.log(require(\\"crypto\\").randomBytes(32).toString(\\"base64\\"))"',
    );
  }
  cachedKey = deriveKey(keyInput);
}

/** Reset cached key — for tests only. */
export function _resetForTests(): void {
  cachedKey = null;
}

function getKey(): Buffer {
  if (!cachedKey) {
    throw new SettingsCryptoError('Settings crypto not initialized — call initSettingsCrypto() first');
  }
  return cachedKey;
}

/** True if a stored value is in our v1 ciphertext format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${VERSION}:`);
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, ciphertext, authTag]);
  return `${VERSION}:${blob.toString('base64')}`;
}

export function decrypt(value: string): string {
  if (!isEncrypted(value)) {
    throw new SettingsCryptoError('Value is not encrypted (missing v1: prefix)');
  }
  const key = getKey();
  const blob = Buffer.from(value.slice(VERSION.length + 1), 'base64');
  if (blob.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new SettingsCryptoError('Ciphertext is malformed (too short)');
  }
  const iv = blob.subarray(0, IV_BYTES);
  const authTag = blob.subarray(blob.length - AUTH_TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES, blob.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}
