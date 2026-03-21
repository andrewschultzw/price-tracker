export function extractFromOpenGraph(html: string): number | null {
  const patterns = [
    /meta[^>]*property=["'](?:og:price:amount|product:price:amount)["'][^>]*content=["']([^"']+)["']/gi,
    /meta[^>]*content=["']([^"']+)["'][^>]*property=["'](?:og:price:amount|product:price:amount)["']/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match) {
      const parsed = parseFloat(match[1]);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  }

  return null;
}
