import { describe, it, expect } from 'vitest';
import { parsePrice } from './extractor.js';

describe('parsePrice', () => {
  describe('happy path', () => {
    it('parses a plain integer', () => {
      expect(parsePrice('1234')).toBe(1234);
    });

    it('parses a plain decimal', () => {
      expect(parsePrice('19.99')).toBe(19.99);
    });

    it('strips a leading dollar sign', () => {
      expect(parsePrice('$19.99')).toBe(19.99);
    });

    it('strips currency symbols and whitespace', () => {
      expect(parsePrice('  £  29.50 ')).toBe(29.5);
      expect(parsePrice('€29.50')).toBe(29.5);
    });

    it('handles US thousands separator', () => {
      expect(parsePrice('$1,234.56')).toBe(1234.56);
      expect(parsePrice('$12,345.67')).toBe(12345.67);
      expect(parsePrice('$1,234,567.89')).toBe(1234567.89);
    });

    it('handles European decimal comma', () => {
      expect(parsePrice('12,34')).toBe(12.34);
      expect(parsePrice('€12,34')).toBe(12.34);
    });

    it('rounds to two decimal places', () => {
      // Avoids float display issues downstream
      expect(parsePrice('12.345')).toBe(12.35);
      expect(parsePrice('12.344')).toBe(12.34);
    });
  });

  describe('rejects invalid input', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['non-numeric', 'abc'],
      ['zero', '0'],
      ['zero with symbol', '$0'],
      ['negative zero', '-0'],
    ])('%s → null', (_desc, input) => {
      expect(parsePrice(input)).toBeNull();
    });

    it('rejects null-ish', () => {
      expect(parsePrice(null as unknown as string)).toBeNull();
      expect(parsePrice(undefined as unknown as string)).toBeNull();
    });
  });

  describe('ambiguous comma interpretation', () => {
    it('treats "1,234" (3 digits after comma) as thousands separator', () => {
      expect(parsePrice('1,234')).toBe(1234);
    });

    it('treats "12,34" (2 digits after comma) as European decimal', () => {
      expect(parsePrice('12,34')).toBe(12.34);
    });

    it('treats "1,234,567" (multiple commas) as thousands', () => {
      expect(parsePrice('1,234,567')).toBe(1234567);
    });
  });
});
