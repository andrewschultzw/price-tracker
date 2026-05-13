/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { PRICE_TEXT_RE, extractPriceText } from './price-shape.js';

describe('PRICE_TEXT_RE', () => {
  it('matches basic price shapes', () => {
    expect(PRICE_TEXT_RE.test('$129.99')).toBe(true);
    expect(PRICE_TEXT_RE.test('$1299.99')).toBe(true);
    expect(PRICE_TEXT_RE.test('$129')).toBe(true);
    expect(PRICE_TEXT_RE.test('129.99')).toBe(true);
  });

  it('matches non-USD currency symbols', () => {
    expect(PRICE_TEXT_RE.test('€129,99')).toBe(true);
    expect(PRICE_TEXT_RE.test('£129.99')).toBe(true);
    expect(PRICE_TEXT_RE.test('¥1299')).toBe(true);
  });

  it('tolerates trailing currency codes', () => {
    expect(PRICE_TEXT_RE.test('129.99 USD')).toBe(true);
    expect(PRICE_TEXT_RE.test('129,99 EUR')).toBe(true);
    expect(PRICE_TEXT_RE.test('129.99 GBP')).toBe(true);
  });

  it('rejects product titles with prices in them', () => {
    // The whole point of the conservative regex: we don't want to
    // false-positive on "Some Product $129" pattern.
    expect(PRICE_TEXT_RE.test('Some Product $129.99')).toBe(false);
    expect(PRICE_TEXT_RE.test('Save $5 today')).toBe(false);
    expect(PRICE_TEXT_RE.test('Price: $129.99')).toBe(false);
  });

  it('rejects free-text and labels', () => {
    expect(PRICE_TEXT_RE.test('Add to cart')).toBe(false);
    expect(PRICE_TEXT_RE.test('')).toBe(false);
    expect(PRICE_TEXT_RE.test('USD')).toBe(false);
  });

  it('rejects prices with too many integer digits (cap at 9999)', () => {
    // A 5+ digit integer is almost certainly NOT a product price —
    // more likely a product ID or model number. Don't flag.
    expect(PRICE_TEXT_RE.test('$12345.99')).toBe(false);
    expect(PRICE_TEXT_RE.test('12345')).toBe(false);
  });
});

/** Small DOM-builder helper that avoids innerHTML (repo-policy guard). */
function span(text: string, className?: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.textContent = text;
  if (className) el.className = className;
  return el;
}

describe('extractPriceText', () => {
  it('returns the price when the element\'s whole text is a price', () => {
    expect(extractPriceText(span('$129.99'))).toBe('$129.99');
  });

  it('trims leading/trailing whitespace before matching', () => {
    expect(extractPriceText(span('   $129.99\n  '))).toBe('$129.99');
  });

  it('walks one level into children to find the first price-shaped child', () => {
    // When the parent's flattened text doesn't match (children mix
    // price + non-price content), the first child whose own text
    // looks price-shaped wins. Mirrors the Amazon a-offscreen pattern
    // where the accessibility span sits as a sibling of the visible
    // price markup.
    const wrapper = document.createElement('div');
    wrapper.appendChild(span('Save now', 'banner'));
    wrapper.appendChild(span('$129.99', 'a-offscreen'));
    expect(extractPriceText(wrapper)).toBe('$129.99');
  });

  it('returns null when neither the element nor any child looks price-shaped', () => {
    const el = document.createElement('div');
    const h1 = document.createElement('h1');
    h1.textContent = 'Big Product Name';
    const p = document.createElement('p');
    p.textContent = 'Description';
    el.appendChild(h1);
    el.appendChild(p);
    expect(extractPriceText(el)).toBeNull();
  });

  it('returns null when an element has no text content at all', () => {
    expect(extractPriceText(document.createElement('div'))).toBeNull();
  });

  it('falls through to child scan when the parent\'s flattened text isn\'t a price', () => {
    // textContent on the parent flattens to "$129.99 not a price",
    // which fails the regex. We then scan the children: the first
    // child is "$129.99" (matches), so that's what we return.
    const el = document.createElement('span');
    el.appendChild(span('$129.99'));
    el.appendChild(span(' not a price'));
    expect(extractPriceText(el)).toBe('$129.99');
  });
});
