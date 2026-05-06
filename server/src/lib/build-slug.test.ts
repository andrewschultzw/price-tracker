import { describe, it, expect } from 'vitest';
import { buildSlug } from './build-slug.js';
import { createHash } from 'crypto';

function expectedHash(normalizedUrl: string): string {
  return createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 6);
}

describe('buildSlug', () => {
  it('produces a clean slug with hash suffix for a basic name', () => {
    const slug = buildSlug('Samsung 990 Pro 4TB', 'amazon.com/dp/B0CKGVDJL2');
    expect(slug).toBe(`samsung-990-pro-4tb-${expectedHash('amazon.com/dp/B0CKGVDJL2')}`);
  });

  it('strips Unicode and special characters from the slug body', () => {
    // Sony® symbol, em-dash, parentheses → all stripped. Spaces become hyphens.
    const slug = buildSlug('Sony® WH-1000XM5 (2024) — black', 'amazon.com/dp/B09Y2LD3RR');
    // After strip: "sony wh-1000xm5 2024  black" → "sony-wh-1000xm5-2024-black"
    expect(slug).toBe(`sony-wh-1000xm5-2024-black-${expectedHash('amazon.com/dp/B09Y2LD3RR')}`);
    // No double hyphens, no leading/trailing dashes in the body.
    expect(slug).not.toMatch(/--/);
  });

  it('truncates the name body to 60 chars before the hash suffix', () => {
    const longName = 'A'.repeat(80);
    const slug = buildSlug(longName, 'example.com/x');
    const hash = expectedHash('example.com/x');
    // Body part should be exactly 60 chars of "a"
    expect(slug).toBe(`${'a'.repeat(60)}-${hash}`);
  });

  it('produces a deterministic hash suffix for the same normalized_url', () => {
    const a = buildSlug('Display Name One', 'amazon.com/dp/B0XYZ');
    const b = buildSlug('Different Name Two', 'amazon.com/dp/B0XYZ');
    // Different name bodies, identical hash suffix.
    const aHash = a.slice(a.lastIndexOf('-') + 1);
    const bHash = b.slice(b.lastIndexOf('-') + 1);
    expect(aHash).toBe(bHash);
    expect(aHash).toBe(expectedHash('amazon.com/dp/B0XYZ'));
  });

  it('falls back to bare hash when display name is empty or whitespace', () => {
    const hash = expectedHash('amazon.com/dp/B0XYZ');
    expect(buildSlug('', 'amazon.com/dp/B0XYZ')).toBe(hash);
    expect(buildSlug('   ', 'amazon.com/dp/B0XYZ')).toBe(hash);
    // No leading dash on the slug when the body is empty.
    expect(buildSlug('   ', 'amazon.com/dp/B0XYZ').startsWith('-')).toBe(false);
  });

  it('handles a name that contains only special characters by falling back to bare hash', () => {
    // "®®®" → strips all to ""
    const hash = expectedHash('amazon.com/dp/X');
    expect(buildSlug('®®®', 'amazon.com/dp/X')).toBe(hash);
  });

  it('preserves embedded hyphens but collapses runs', () => {
    // "Pro - 4TB --- Plus" → "pro-4tb-plus"
    const slug = buildSlug('Pro - 4TB --- Plus', 'example.com/x');
    expect(slug.startsWith('pro-4tb-plus-')).toBe(true);
    expect(slug).not.toMatch(/--/);
  });
});
