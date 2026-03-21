export function extractFromMicrodata(html: string): number | null {
  // Match itemprop="price" with content attribute
  const contentRegex = /itemprop=["']price["'][^>]*content=["']([^"']+)["']/gi;
  let match = contentRegex.exec(html);
  if (match) {
    const parsed = parseFloat(match[1]);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // Reverse order: content before itemprop
  const reverseRegex = /content=["']([^"']+)["'][^>]*itemprop=["']price["']/gi;
  match = reverseRegex.exec(html);
  if (match) {
    const parsed = parseFloat(match[1]);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // itemprop="price" with text content
  const textRegex = /itemprop=["']price["'][^>]*>([^<]+)</gi;
  match = textRegex.exec(html);
  if (match) {
    const cleaned = match[1].replace(/[^0-9.,]/g, '');
    const parsed = parseFloat(cleaned.replace(/,/g, ''));
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}
