/**
 * Minimal RFC 4180 CSV serializer. A field needs quoting if it contains a
 * comma, CR/LF, or a double quote. Quotes inside a quoted field are escaped
 * by doubling. We quote every non-primitive string field for safety and
 * consistency — spreadsheets handle it fine either way.
 *
 * Intentionally no dependency on a csv-stringify package for a ~20 line
 * function used in one place.
 */

type CsvValue = string | number | boolean | null | undefined;

function escapeField(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // Always quote string fields to guard against commas, quotes, or newlines
  // in product names. Escape inner quotes by doubling per RFC 4180.
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines: string[] = [];
  lines.push(headers.map(h => escapeField(h)).join(','));
  for (const row of rows) {
    lines.push(row.map(escapeField).join(','));
  }
  // CRLF line endings per RFC 4180; spreadsheets tolerate LF too but CRLF
  // is the spec and works everywhere.
  return lines.join('\r\n') + '\r\n';
}

/**
 * URL-safe slug for use in filenames. Keeps lowercase alphanumerics and
 * collapses everything else into single hyphens. Used by the CSV/JSON
 * export routes so downloaded files have a readable name derived from the
 * tracker name.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')  // strip diacritics
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    || 'tracker';
}
