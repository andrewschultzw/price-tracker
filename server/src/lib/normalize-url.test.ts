import { describe, it, expect } from 'vitest';
import { normalizeTrackerUrl } from './normalize-url.js';

describe('normalizeTrackerUrl', () => {
  it('returns null on malformed input', () => {
    expect(normalizeTrackerUrl('')).toBeNull();
    expect(normalizeTrackerUrl('not a url')).toBeNull();
    expect(normalizeTrackerUrl('http://')).toBeNull();
  });

  it('canonicalizes the hostname via the alias table', () => {
    expect(normalizeTrackerUrl('https://smile.amazon.com/dp/B0XYZ'))
      .toBe('amazon.com/dp/b0xyz');
    expect(normalizeTrackerUrl('https://music.amazon.com/dp/B0XYZ'))
      .toBe('amazon.com/dp/b0xyz');
  });

  it('lowercases the pathname', () => {
    expect(normalizeTrackerUrl('https://amazon.com/DP/B0XYZ'))
      .toBe('amazon.com/dp/b0xyz');
  });

  it('strips tracking query params', () => {
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ?tag=abc&utm_source=x'))
      .toBe('amazon.com/dp/b0xyz');
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ?ref=nav&_encoding=UTF8&psc=1'))
      .toBe('amazon.com/dp/b0xyz');
  });

  it('keeps product-identifying params and sorts them deterministically', () => {
    const a = normalizeTrackerUrl('https://newegg.com/p/N82E123?Item=N82E123&utm_source=x&foo=1');
    const b = normalizeTrackerUrl('https://newegg.com/p/N82E123?foo=1&Item=N82E123');
    expect(a).toBe(b);
    expect(a).toContain('Item=N82E123');
    expect(a).toContain('foo=1');
    expect(a).not.toContain('utm_source');
  });

  it('strips trailing slashes and fragments', () => {
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ/#section'))
      .toBe('amazon.com/dp/b0xyz');
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ/'))
      .toBe('amazon.com/dp/b0xyz');
  });

  it('produces the same key for amazon.com and smile.amazon.com with matching paths', () => {
    const a = normalizeTrackerUrl('https://smile.amazon.com/dp/B0XYZ');
    const b = normalizeTrackerUrl('https://www.amazon.com/dp/B0XYZ');
    expect(a).toBe(b);
  });

  it('does NOT collide distinct products', () => {
    expect(normalizeTrackerUrl('https://amazon.com/dp/B0XYZ'))
      .not.toBe(normalizeTrackerUrl('https://amazon.com/dp/B0ABC'));
  });

  it('canonicalizes short-link hostnames but keeps the opaque path', () => {
    const out = normalizeTrackerUrl('https://a.co/d/xyz');
    expect(out).toBe('amazon.com/d/xyz');
  });
});
