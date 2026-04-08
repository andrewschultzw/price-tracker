import { describe, it, expect, beforeEach } from 'vitest';
import {
  initSettingsCrypto,
  _resetForTests,
  encrypt,
  decrypt,
  isEncrypted,
  deriveKey,
  SettingsCryptoError,
} from './settings-crypto.js';
import { randomBytes } from 'crypto';

describe('settings-crypto', () => {
  beforeEach(() => {
    _resetForTests();
    initSettingsCrypto(randomBytes(32).toString('base64'));
  });

  describe('round-trip', () => {
    it('encrypts and decrypts a simple string', () => {
      const plaintext = 'https://discord.com/api/webhooks/1234/abcdef';
      const ct = encrypt(plaintext);
      expect(decrypt(ct)).toBe(plaintext);
    });

    it('encrypts to a different ciphertext each time (random IV)', () => {
      const plaintext = 'https://ntfy.sh/my-topic';
      const ct1 = encrypt(plaintext);
      const ct2 = encrypt(plaintext);
      expect(ct1).not.toBe(ct2);
      expect(decrypt(ct1)).toBe(plaintext);
      expect(decrypt(ct2)).toBe(plaintext);
    });

    it('handles unicode content', () => {
      const plaintext = 'https://example.com/hooks/Crème Brûlée 🎉';
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });

    it('handles empty string', () => {
      expect(decrypt(encrypt(''))).toBe('');
    });

    it('handles long strings', () => {
      const plaintext = 'a'.repeat(10000);
      expect(decrypt(encrypt(plaintext))).toBe(plaintext);
    });
  });

  describe('format', () => {
    it('prefixes ciphertext with v1:', () => {
      const ct = encrypt('hello');
      expect(ct.startsWith('v1:')).toBe(true);
    });

    it('isEncrypted recognizes v1: prefix', () => {
      expect(isEncrypted('v1:somebase64data')).toBe(true);
      expect(isEncrypted('https://example.com')).toBe(false);
      expect(isEncrypted('')).toBe(false);
    });
  });

  describe('tamper detection (GCM auth tag)', () => {
    it('throws if the ciphertext body is modified', () => {
      const ct = encrypt('hello');
      // Flip a byte in the middle of the payload. 'v1:' is 3 chars, base64
      // follows; mutating any middle char breaks the auth tag.
      const tampered = ct.slice(0, 5) + (ct[5] === 'A' ? 'B' : 'A') + ct.slice(6);
      expect(() => decrypt(tampered)).toThrow();
    });

    it('throws if the auth tag is stripped', () => {
      const ct = encrypt('hello');
      const shortened = ct.slice(0, ct.length - 8);
      expect(() => decrypt(shortened)).toThrow();
    });

    it('throws on malformed (too short) ciphertext', () => {
      expect(() => decrypt('v1:short')).toThrow(SettingsCryptoError);
    });

    it('throws on missing version prefix', () => {
      expect(() => decrypt('not-our-format')).toThrow(SettingsCryptoError);
    });
  });

  describe('key derivation', () => {
    it('accepts a base64-encoded 32-byte key directly', () => {
      const raw = randomBytes(32);
      const key = deriveKey(raw.toString('base64'));
      expect(key.equals(raw)).toBe(true);
    });

    it('falls back to SHA-256 for non-base64 or wrong-length input', () => {
      const k1 = deriveKey('some-passphrase-here');
      const k2 = deriveKey('some-passphrase-here');
      expect(k1.length).toBe(32);
      expect(k1.equals(k2)).toBe(true); // deterministic
      const k3 = deriveKey('different-passphrase');
      expect(k1.equals(k3)).toBe(false);
    });

    it('rejects empty input', () => {
      expect(() => deriveKey('')).toThrow(SettingsCryptoError);
    });
  });

  describe('initialization guards', () => {
    it('encrypt throws if not initialized', () => {
      _resetForTests();
      expect(() => encrypt('hello')).toThrow(SettingsCryptoError);
    });

    it('decrypt throws if not initialized', () => {
      _resetForTests();
      expect(() => decrypt('v1:somedata')).toThrow(SettingsCryptoError);
    });

    it('init throws on missing key', () => {
      _resetForTests();
      expect(() => initSettingsCrypto(undefined)).toThrow(SettingsCryptoError);
      expect(() => initSettingsCrypto('')).toThrow(SettingsCryptoError);
      expect(() => initSettingsCrypto(null)).toThrow(SettingsCryptoError);
    });
  });

  describe('cross-instance compatibility', () => {
    it('a value encrypted with one key cannot be decrypted with another', () => {
      const plaintext = 'https://example.com/hook';
      const ct = encrypt(plaintext);

      _resetForTests();
      initSettingsCrypto(randomBytes(32).toString('base64'));
      expect(() => decrypt(ct)).toThrow();
    });

    it('a value encrypted and decrypted with the same key input round-trips', () => {
      const keyInput = randomBytes(32).toString('base64');
      _resetForTests();
      initSettingsCrypto(keyInput);
      const ct = encrypt('hello');
      _resetForTests();
      initSettingsCrypto(keyInput);
      expect(decrypt(ct)).toBe('hello');
    });
  });
});
