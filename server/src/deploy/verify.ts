import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Verify GitHub's X-Hub-Signature-256 over the RAW request body.
 * Must be the exact bytes GitHub sent — re-serialized JSON will not match.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signatureHeader, 'ascii');
  const b = Buffer.from(expected, 'ascii');
  // timingSafeEqual throws on length mismatch — guard first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
