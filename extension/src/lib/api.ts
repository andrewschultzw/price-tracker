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

function assertTrackerShape(data: unknown): asserts data is Tracker {
  if (!data || typeof data !== 'object') {
    throw new ApiError('UNKNOWN', 'Tracker response is not an object');
  }
  const required: ReadonlyArray<keyof Tracker> = [
    'id', 'name', 'url', 'normalized_url', 'threshold_price',
    'check_interval_minutes', 'last_price', 'ai_verdict_tier', 'ai_verdict_reason',
  ];
  for (const k of required) {
    if (!(k in data)) {
      throw new ApiError('UNKNOWN', `Tracker response missing field: ${String(k)}`);
    }
  }
}

function assertTrackerListShape(data: unknown): asserts data is Tracker[] {
  if (!Array.isArray(data)) {
    throw new ApiError('UNKNOWN', 'Trackers response is not an array');
  }
  for (const t of data) assertTrackerShape(t);
}

export async function listTrackers(): Promise<Tracker[]> {
  const data = await request<unknown>('/api/trackers', { method: 'GET' });
  assertTrackerListShape(data);
  return data;
}

export async function createTracker(payload: TrackerCreatePayload): Promise<Tracker> {
  const data = await request<unknown>('/api/trackers', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  assertTrackerShape(data);
  return data;
}

export async function testConnection(): Promise<void> {
  await listTrackers();
}
