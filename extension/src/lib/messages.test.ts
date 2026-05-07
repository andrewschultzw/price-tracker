import { describe, it, expect } from 'vitest';
import {
  isCheckDup,
  isCreate,
  isTestConnection,
  isListProjects,
  isAddToProject,
  isUpdateThreshold,
} from './messages.js';

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

  it('isListProjects / isAddToProject / isUpdateThreshold guards', () => {
    expect(isListProjects({ type: 'LIST_PROJECTS' })).toBe(true);
    expect(isAddToProject({ type: 'ADD_TO_PROJECT', project_id: 1, tracker_id: 2 })).toBe(true);
    expect(isUpdateThreshold({ type: 'UPDATE_THRESHOLD', tracker_id: 1, threshold: 25 })).toBe(true);
    expect(isUpdateThreshold({ type: 'UPDATE_THRESHOLD', tracker_id: 1, threshold: null })).toBe(true);
    expect(isListProjects({ type: 'OTHER' })).toBe(false);
    // Reject malformed payloads
    expect(isAddToProject({ type: 'ADD_TO_PROJECT', project_id: '1', tracker_id: 2 })).toBe(false);
    expect(isAddToProject({ type: 'ADD_TO_PROJECT', project_id: 1 })).toBe(false);
    expect(isUpdateThreshold({ type: 'UPDATE_THRESHOLD', tracker_id: 1, threshold: 'cheap' })).toBe(false);
  });
});
