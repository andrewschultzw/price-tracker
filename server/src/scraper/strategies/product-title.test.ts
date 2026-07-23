import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanProductTitle, extractProductTitle } from './product-title.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string =>
  readFileSync(resolve(__dirname, '__fixtures__', name), 'utf8');

describe('extractProductTitle', () => {
  it('prefers JSON-LD Product.name over og:title and <title>', () => {
    const html = `
      <html><head>
        <title>SEO Junk Title | MegaStore</title>
        <meta property="og:title" content="OG Widget">
        <script type="application/ld+json">{"@type":"Product","name":"Widget Pro 3000","offers":{"@type":"Offer","price":"49.99"}}</script>
      </head><body></body></html>`;
    expect(extractProductTitle(html)).toBe('Widget Pro 3000');
  });

  it('finds Product.name inside @graph containers', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Product","name":"Nested Gadget"}]}</script>`;
    expect(extractProductTitle(html)).toBe('Nested Gadget');
  });

  it('falls back to og:title, both attribute orders', () => {
    expect(
      extractProductTitle(`<meta property="og:title" content="OG Widget">`),
    ).toBe('OG Widget');
    expect(
      extractProductTitle(`<meta content="OG Widget" property="og:title">`),
    ).toBe('OG Widget');
  });

  it('falls back to <title> with boilerplate stripped', () => {
    expect(
      extractProductTitle(`<title>Amazon.com: Widget Pro 3000 : Electronics | Amazon</title>`),
    ).toBe('Widget Pro 3000 : Electronics');
  });

  it('returns null on empty/linkless documents', () => {
    expect(extractProductTitle('<html><body>nothing here</body></html>')).toBeNull();
    expect(extractProductTitle('')).toBeNull();
  });

  it('tolerates invalid JSON-LD and keeps cascading', () => {
    const html = `
      <script type="application/ld+json">{not json</script>
      <meta property="og:title" content="Recovered Widget">`;
    expect(extractProductTitle(html)).toBe('Recovered Widget');
  });

  it('extracts a real name from the Newegg fixture', () => {
    const name = extractProductTitle(fixture('newegg-wd-red-10tb.html'));
    expect(name).toBeTruthy();
    expect(name!.length).toBeGreaterThan(10);
    expect(name!).toMatch(/wd|red|10tb|hard drive/i);
  });
});

describe('cleanProductTitle', () => {
  it('decodes entities and collapses whitespace', () => {
    expect(cleanProductTitle('Ben &amp; Jerry&#39;s   Widget')).toBe("Ben & Jerry's Widget");
  });

  it('keeps hyphenated product names but drops store suffixes', () => {
    expect(cleanProductTitle('Widget Pro - Walmart.com')).toBe('Widget Pro');
    expect(cleanProductTitle('Cast Iron Skillet - 12 inch')).toBe('Cast Iron Skillet - 12 inch');
  });

  it('caps at 200 chars and nulls empty results', () => {
    expect(cleanProductTitle('x'.repeat(300))!.length).toBe(200);
    expect(cleanProductTitle('   ')).toBeNull();
  });
});
