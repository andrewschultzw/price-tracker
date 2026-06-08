import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import { verifySignature, shouldDeploy } from './verify.js';

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

function workflowRun(over: Record<string, unknown> = {}) {
  return {
    action: 'completed',
    workflow_run: {
      name: 'CI',
      conclusion: 'success',
      head_branch: 'main',
      head_sha: 'abc123',
      ...over,
    },
  };
}

describe('shouldDeploy', () => {
  it('deploys on completed + CI + success + main', () => {
    const r = shouldDeploy(workflowRun());
    expect(r.deploy).toBe(true);
    expect(r.sha).toBe('abc123');
  });

  it('skips when the run failed', () => {
    expect(shouldDeploy(workflowRun({ conclusion: 'failure' })).deploy).toBe(false);
  });

  it('skips a non-main branch', () => {
    expect(shouldDeploy(workflowRun({ head_branch: 'feature/x' })).deploy).toBe(false);
  });

  it('skips a non-CI workflow', () => {
    expect(shouldDeploy(workflowRun({ name: 'Release' })).deploy).toBe(false);
  });

  it('skips actions other than completed', () => {
    expect(shouldDeploy({ ...workflowRun(), action: 'requested' }).deploy).toBe(false);
  });

  it('skips a run with a null conclusion (in-progress)', () => {
    expect(shouldDeploy(workflowRun({ conclusion: null })).deploy).toBe(false);
  });

  it('skips a payload with no workflow_run (e.g. a ping event)', () => {
    expect(shouldDeploy({ zen: 'hi' }).deploy).toBe(false);
  });

  it('returns a human-readable reason', () => {
    expect(shouldDeploy(workflowRun({ conclusion: 'failure' })).reason).toMatch(/conclusion/i);
  });
});
