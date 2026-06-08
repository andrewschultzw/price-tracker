import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifySignature } from './verify.js';

const SECRET = 'test-secret';

function sign(body: Buffer, secret = SECRET): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifySignature', () => {
  it('accepts a correctly signed body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const sig = sign(body);
    const tampered = Buffer.from(JSON.stringify({ hello: 'evil' }));
    expect(verifySignature(tampered, sig, SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const body = Buffer.from('payload');
    expect(verifySignature(body, sign(body, 'wrong'), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifySignature(Buffer.from('x'), undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(verifySignature(Buffer.from('x'), 'garbage', SECRET)).toBe(false);
  });

  it('rejects an empty signature header', () => {
    expect(verifySignature(Buffer.from('x'), '', SECRET)).toBe(false);
  });
});
