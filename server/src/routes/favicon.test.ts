import { describe, it, expect } from 'vitest';
import { _test } from './favicon.js';

const { isValidDomain } = _test;

describe('isValidDomain (favicon SSRF guard)', () => {
  describe('accepts real hostnames', () => {
    it.each([
      'amazon.com',
      'www.amazon.com',
      'a.co',
      'some.deeply.nested.example.com',
      'xn--fiq228c5hs.com', // IDN punycode
      'sub-domain.example.co.uk',
      '1.2.3.4.example.com',
    ])('%s → valid', host => {
      expect(isValidDomain(host)).toBe(true);
    });
  });

  describe('rejects abuse attempts', () => {
    it.each([
      ['empty string', ''],
      ['single label (no dot)', 'localhost'],
      ['protocol prefix', 'http://example.com'],
      ['protocol prefix https', 'https://example.com'],
      ['path segment', 'example.com/path'],
      ['query string', 'example.com?foo=bar'],
      ['fragment', 'example.com#frag'],
      ['userinfo', 'user:pass@example.com'],
      ['port', 'example.com:8080'],
      ['@ character', 'evil@internal'],
      ['localhost IP', '127.0.0.1'],  // no letters, regex requires alpha label
      ['internal hostname with underscore', 'internal_host.lan'],
      ['leading dot', '.example.com'],
      ['trailing dot', 'example.com.'],
      ['double dot', 'foo..bar.com'],
      ['leading hyphen', '-example.com'],
      ['label trailing hyphen', 'example-.com'],
      ['uppercase (caller should lowercase first)', 'Example.com'],
      ['whitespace inside', 'exa mple.com'],
      ['null byte', 'example\0.com'],
      ['CRLF injection', 'example.com\r\nX-Injected: 1'],
    ])('%s → invalid', (_desc, host) => {
      expect(isValidDomain(host)).toBe(false);
    });

    it('rejects a 254-character hostname (over the 253 limit)', () => {
      const long = 'a.' + 'b'.repeat(251) + '.c'; // 255 chars
      expect(isValidDomain(long)).toBe(false);
    });
  });
});
