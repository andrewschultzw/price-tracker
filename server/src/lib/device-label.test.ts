import { describe, it, expect } from 'vitest';
import { deriveDeviceLabel } from './device-label.js';

describe('deriveDeviceLabel', () => {
  it('Chrome on Mac → "Mac · Chrome"', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(deriveDeviceLabel(ua)).toBe('Mac · Chrome');
  });

  it('Safari on iPhone → "iPhone · Safari"', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1';
    expect(deriveDeviceLabel(ua)).toBe('iPhone · Safari');
  });

  it('Firefox on Windows → "Windows · Firefox"', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0';
    expect(deriveDeviceLabel(ua)).toBe('Windows · Firefox');
  });

  it('Edge on Mac → "Mac · Edge"', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0';
    expect(deriveDeviceLabel(ua)).toBe('Mac · Edge');
  });

  it('Chrome on Android → "Android · Chrome"', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
    expect(deriveDeviceLabel(ua)).toBe('Android · Chrome');
  });

  it('unknown UA → generic fallback', () => {
    expect(deriveDeviceLabel('SomeBot/1.0')).toBe('Device · Browser');
  });
});
