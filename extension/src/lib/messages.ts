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

export interface ListProjectsMessage {
  type: 'LIST_PROJECTS';
}

export interface AddToProjectMessage {
  type: 'ADD_TO_PROJECT';
  project_id: number;
  tracker_id: number;
}

export interface UpdateThresholdMessage {
  type: 'UPDATE_THRESHOLD';
  tracker_id: number;
  threshold: number | null;
}

export type ExtensionMessage =
  | CheckDupMessage
  | CreateMessage
  | TestConnectionMessage
  | ListProjectsMessage
  | AddToProjectMessage
  | UpdateThresholdMessage;

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

export interface ListProjectsResponse {
  ok: true;
  projects: Array<{ id: number; name: string }>;
}

export interface AddToProjectResponse {
  ok: true;
}

export interface UpdateThresholdResponse {
  ok: true;
  tracker: Tracker;
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
  | CheckDupResponse
  | CreateResponse
  | TestConnectionResponse
  | ListProjectsResponse
  | AddToProjectResponse
  | UpdateThresholdResponse
  | ErrorResponse;

export function isCheckDup(msg: unknown): msg is CheckDupMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'CHECK_DUP';
}

export function isCreate(msg: unknown): msg is CreateMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'CREATE';
}

export function isTestConnection(msg: unknown): msg is TestConnectionMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'TEST_CONNECTION';
}

export function isListProjects(msg: unknown): msg is ListProjectsMessage {
  return !!msg && typeof msg === 'object' && (msg as { type: unknown }).type === 'LIST_PROJECTS';
}

export function isAddToProject(msg: unknown): msg is AddToProjectMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type: unknown; project_id: unknown; tracker_id: unknown };
  return (
    m.type === 'ADD_TO_PROJECT' &&
    typeof m.project_id === 'number' &&
    typeof m.tracker_id === 'number'
  );
}

export function isUpdateThreshold(msg: unknown): msg is UpdateThresholdMessage {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as { type: unknown; tracker_id: unknown; threshold: unknown };
  return (
    m.type === 'UPDATE_THRESHOLD' &&
    typeof m.tracker_id === 'number' &&
    (m.threshold === null || typeof m.threshold === 'number')
  );
}
