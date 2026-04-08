import { describe, it, expect } from 'vitest';
import { toCsv, slugify } from './csv.js';

describe('toCsv', () => {
  it('serializes a simple header + rows', () => {
    const out = toCsv(
      ['a', 'b', 'c'],
      [
        ['1', '2', '3'],
        ['4', '5', '6'],
      ],
    );
    expect(out).toBe('"a","b","c"\r\n"1","2","3"\r\n"4","5","6"\r\n');
  });

  it('does not quote numbers or booleans', () => {
    const out = toCsv(
      ['n', 'b'],
      [
        [42, true],
        [3.14, false],
      ],
    );
    expect(out).toBe('"n","b"\r\n42,true\r\n3.14,false\r\n');
  });

  it('escapes double quotes by doubling them', () => {
    const out = toCsv(['name'], [['He said "hi"']]);
    expect(out).toBe('"name"\r\n"He said ""hi"""\r\n');
  });

  it('preserves commas inside quoted fields', () => {
    const out = toCsv(['name'], [['Smith, John']]);
    expect(out).toBe('"name"\r\n"Smith, John"\r\n');
  });

  it('preserves newlines inside quoted fields', () => {
    const out = toCsv(['desc'], [['line1\nline2']]);
    expect(out).toBe('"desc"\r\n"line1\nline2"\r\n');
  });

  it('renders null and undefined as empty fields', () => {
    const out = toCsv(['a', 'b', 'c'], [[null, undefined, 'x']]);
    expect(out).toBe('"a","b","c"\r\n,,"x"\r\n');
  });

  it('handles an empty row set (header only)', () => {
    expect(toCsv(['a', 'b'], [])).toBe('"a","b"\r\n');
  });

  it('ends with a trailing CRLF (RFC 4180)', () => {
    expect(toCsv(['x'], [['y']]).endsWith('\r\n')).toBe(true);
  });
});

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('collapses runs of non-alphanumerics into single hyphens', () => {
    expect(slugify('foo!!!bar   baz')).toBe('foo-bar-baz');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---foo---')).toBe('foo');
    expect(slugify('!!!foo!!!')).toBe('foo');
  });

  it('strips diacritics', () => {
    expect(slugify('Crème Brûlée')).toBe('creme-brulee');
  });

  it('truncates to 60 characters', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });

  it('falls back to "tracker" for an empty or unslugifiable name', () => {
    expect(slugify('')).toBe('tracker');
    expect(slugify('   ')).toBe('tracker');
    expect(slugify('!!!')).toBe('tracker');
  });

  it('handles emoji by dropping them', () => {
    expect(slugify('Widget 🎉')).toBe('widget');
  });
});
