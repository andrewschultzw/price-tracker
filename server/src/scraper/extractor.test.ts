import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parsePrice, extractPrice, isPageWideRegexUnsafeHost } from './extractor.js';
import { ScrapeError } from './retry.js';

vi.mock('./browser.js', () => ({
  fetchPageContent: vi.fn(),
}));

const { fetchPageContent } = await import('./browser.js');

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

describe('isPageWideRegexUnsafeHost', () => {
  it.each([
    'amazon.com',
    'www.amazon.com',
    'smile.amazon.com',
    'amazon.co.uk',
    'amazon.de',
    'a.co',
    'amzn.to',
  ])('flags %s as unsafe', (host) => {
    expect(isPageWideRegexUnsafeHost(host)).toBe(true);
  });

  it.each([
    'newegg.com',
    'www.newegg.com',
    'walmart.com',
    'bestbuy.com',
    'target.com',
    'ikoolcore.com',
    'amazonsupply.com',
    '',
  ])('does NOT flag %s', (host) => {
    expect(isPageWideRegexUnsafeHost(host)).toBe(false);
  });
});

describe('extractPrice() pipeline — Amazon regex bypass', () => {
  // Synthesized HTML that defeats every structured strategy and contains
  // multiple "$10" mentions. The regex strategy's frequency-mode picks
  // "$10" as the winner. This is the exact failure mode that produced
  // five false price-drop Discord alerts on 2026-04-27 (trackers 17, 18,
  // 21, 22, 24, 25, 26 — all amazon hosts).
  const amazonNoiseHtml = `
    <html>
      <head><title>Some Product</title></head>
      <body>
        <div>Save $10 with coupon</div>
        <div>As low as $10/month with Affirm</div>
        <div>$10 off your first order!</div>
        <div>Earn up to $10/month with our card</div>
        <p>Free shipping on orders over $25.</p>
      </body>
    </html>
  `;

  beforeEach(() => {
    vi.mocked(fetchPageContent).mockReset();
  });

  it('throws ScrapeError instead of reporting $10 on amazon.com URLs', async () => {
    vi.mocked(fetchPageContent).mockResolvedValue({
      html: amazonNoiseHtml,
      finalUrl: 'https://www.amazon.com/dp/B0EXAMPLE',
    });
    await expect(
      extractPrice('https://www.amazon.com/dp/B0EXAMPLE'),
    ).rejects.toThrow(ScrapeError);
  });

  it('throws on a.co/d/* short links (resolved finalUrl is amazon.com)', async () => {
    vi.mocked(fetchPageContent).mockResolvedValue({
      html: amazonNoiseHtml,
      finalUrl: 'https://www.amazon.com/dp/B0EXAMPLE?th=1',
    });
    await expect(extractPrice('https://a.co/d/03wK0ize')).rejects.toThrow(
      ScrapeError,
    );
  });

  it('throws on amzn.to short links', async () => {
    vi.mocked(fetchPageContent).mockResolvedValue({
      html: amazonNoiseHtml,
      finalUrl: 'https://www.amazon.com/dp/B0EXAMPLE',
    });
    await expect(extractPrice('https://amzn.to/4bQZqyA')).rejects.toThrow(
      ScrapeError,
    );
  });

  it('still runs page-wide regex on non-Amazon hosts (returns $10 from same HTML)', async () => {
    vi.mocked(fetchPageContent).mockResolvedValue({
      html: amazonNoiseHtml,
      finalUrl: 'https://www.example-store.com/product/abc',
    });
    const result = await extractPrice('https://www.example-store.com/product/abc');
    // The bypass is scoped to Amazon hosts only. Other retailers without
    // structured data still depend on the regex fallback. This test locks
    // down the bypass scope.
    expect(result.price).toBe(10);
    expect(result.strategy).toBe('regex');
  });
});
