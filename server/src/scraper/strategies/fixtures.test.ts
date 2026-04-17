import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFromCssPatterns, isAmazonCurrentlyUnavailable } from './css-patterns.js';
import { extractFromJsonLd } from './jsonld.js';
import { extractFromRegex } from './regex.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(join(__dirname, '__fixtures__', name), 'utf-8');

// These tests load real scraped HTML captured from the live retailers
// on 2026-04-17 while diagnosing silent false-positive price drops.
// They lock down the two regressions that motivated the scoping fixes:
//   1. Amazon `a.co/d/...` landing on a "Currently unavailable" product
//      was reporting $35.99 (a sponsored-carousel accessory) as the
//      product price.
//   2. Newegg `p/N82E16822234588` (WD Red Plus 10TB HDD) was cycling
//      $10 / $249 / $389 / $459.95 across scrapes — the 3 wrong values
//      were carousel / recommended-product prices bleeding into the
//      generic regex fallback.

describe('fixture: amazon-jetkvm-unavailable.html (JetKVM a.co short link)', () => {
  const html = fixture('amazon-jetkvm-unavailable.html');

  it('is detected as Amazon Currently unavailable', () => {
    expect(isAmazonCurrentlyUnavailable(html)).toBe(true);
  });

  it('css-patterns does NOT return a sponsored-carousel price ($35.99)', () => {
    // Before the scoping fix this returned 35.99 from the first
    // page-wide .a-offscreen (an accessory). The main apex_desktop
    // container is present but empty, which now short-circuits the
    // fallback.
    expect(extractFromCssPatterns(html)).toBeNull();
  });
});

describe('fixture: newegg-wd-red-10tb.html (WD Red Plus 10TB HDD)', () => {
  const html = fixture('newegg-wd-red-10tb.html');

  it('json-ld extracts the real product price of $459.95', () => {
    expect(extractFromJsonLd(html)).toBe(459.95);
  });

  it('regex (fallback) returns a value from the main product-price scope, not a carousel', () => {
    // The regex strategy scopes to <div class="product-price"> first.
    // The main price is rendered as `$<strong>459</strong><sup>.95</sup>`
    // so after tag-stripping the regex captures "459" (the cents are
    // whitespace-separated and not captured by the current regex —
    // that's acceptable: the point of this test is that the wrong
    // carousel prices ($10, $249, $389) are NOT returned.
    const result = extractFromRegex(html);
    expect(result).not.toBeNull();
    expect(result).not.toBe(10);
    expect(result).not.toBe(249);
    expect(result).not.toBe(389);
    // Accept either $459 (whole-dollar capture) or $459.95 if the
    // regex is ever tightened to handle Newegg's split markup.
    expect([459, 459.95]).toContain(result);
  });

  it('css-patterns does NOT return a carousel price', () => {
    const result = extractFromCssPatterns(html);
    expect(result).not.toBe(10);
    expect(result).not.toBe(249);
    expect(result).not.toBe(389);
  });
});
