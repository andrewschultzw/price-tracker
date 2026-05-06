import { describe, it, expect } from 'vitest';
import { isCheckDup, isCreate, isTestConnection } from './messages.js';

describe('message type guards', () => {
  it('isCheckDup', () => {
    expect(isCheckDup({ type: 'CHECK_DUP', url: 'https://x' })).toBe(true);
    expect(isCheckDup({ type: 'CREATE' })).toBe(false);
    expect(isCheckDup(null)).toBe(false);
  });

  it('isCreate', () => {
    expect(isCreate({ type: 'CREATE', payload: { name: 'x', url: 'https://x' } })).toBe(true);
    expect(isCreate({ type: 'CHECK_DUP' })).toBe(false);
  });

  it('isTestConnection', () => {
    expect(isTestConnection({ type: 'TEST_CONNECTION' })).toBe(true);
    expect(isTestConnection({ type: 'OTHER' })).toBe(false);
  });
});
