import type { Tracker, TrackerCreatePayload } from '../types/api.js';
import type { ErrorCode } from './messages.js';

const API_ORIGIN = 'https://prices.schultzsolutions.tech';

export async function getStoredToken(): Promise<string | null> {
  const data = await chrome.storage.local.get(['apiToken']);
  return (data.apiToken as string | undefined) ?? null;
}

export async function setStoredToken(token: string): Promise<void> {
  await chrome.storage.local.set({ apiToken: token });
}

export async function clearStoredToken(): Promise<void> {
  await chrome.storage.local.remove('apiToken');
}

class ApiError extends Error {
  code: ErrorCode;
  detail?: string;
  constructor(code: ErrorCode, detail?: string) {
    super(`api ${code}`);
    this.code = code;
    this.detail = detail;
  }
}

async function request<T>(path: string, init: RequestInit & { method: string }): Promise<T> {
  const token = await getStoredToken();
  if (!token) throw new ApiError('NO_TOKEN');

  let response: Response;
  try {
    response = await fetch(`${API_ORIGIN}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'Content-Type': 'application/json',
        'X-API-Key': token,
      },
    });
  } catch (err) {
    throw new ApiError('NETWORK', String(err));
  }
  if (response.status === 401) throw new ApiError('UNAUTHORIZED');
  if (response.status === 400) throw new ApiError('VALIDATION', await safeBody(response));
  if (response.status === 409) throw new ApiError('CONFLICT');
  if (response.status >= 500) throw new ApiError('SERVER', String(response.status));
  if (!response.ok) throw new ApiError('UNKNOWN', String(response.status));
  return response.json() as Promise<T>;
}

async function safeBody(r: Response): Promise<string> {
  try { return JSON.stringify(await r.json()); } catch { return ''; }
}

export async function listTrackers(): Promise<Tracker[]> {
  return request<Tracker[]>('/api/trackers', { method: 'GET' });
}

export async function createTracker(payload: TrackerCreatePayload): Promise<Tracker> {
  return request<Tracker>('/api/trackers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function testConnection(): Promise<void> {
  await listTrackers();
}
