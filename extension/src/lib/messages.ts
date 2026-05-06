import type { TrackerCreatePayload, Tracker } from '../types/api.js';

export interface CheckDupMessage {
  type: 'CHECK_DUP';
  url: string;
}

export interface CreateMessage {
  type: 'CREATE';
  payload: TrackerCreatePayload;
}

export interface TestConnectionMessage {
  type: 'TEST_CONNECTION';
}

export type ExtensionMessage = CheckDupMessage | CreateMessage | TestConnectionMessage;

export interface CheckDupResponse {
  ok: true;
  exists: boolean;
  tracker?: Tracker;
}

export interface CreateResponse {
  ok: true;
  tracker: Tracker;
}

export interface TestConnectionResponse {
  ok: true;
}

export type ErrorCode =
  | 'NO_TOKEN' | 'UNAUTHORIZED' | 'NETWORK' | 'SERVER'
  | 'VALIDATION' | 'CONFLICT' | 'NOT_IMPLEMENTED' | 'UNKNOWN';

export interface ErrorResponse {
  ok: false;
  error: ErrorCode;
  detail?: string;
}

export type ExtensionResponse =
  | CheckDupResponse | CreateResponse | TestConnectionResponse | ErrorResponse;

export function isCheckDup(msg: unknown): msg is CheckDupMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'CHECK_DUP';
}

export function isCreate(msg: unknown): msg is CreateMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'CREATE';
}

export function isTestConnection(msg: unknown): msg is TestConnectionMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'TEST_CONNECTION';
}
