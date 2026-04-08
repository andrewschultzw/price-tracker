import type { Tracker, PriceRecord, ScrapeResult, User, InviteCode, SetupStatus } from './types';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });

  if (res.status === 401 && !path.startsWith('/auth/')) {
    const refreshed = await refreshToken();
    if (refreshed) {
      const retryRes = await fetch(`${BASE}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        ...options,
      });
      if (!retryRes.ok) {
        if (retryRes.status === 401) {
          window.location.href = '/login';
          throw new Error('Session expired');
        }
        const body = await retryRes.json().catch(() => ({}));
        throw new Error(body.error?.toString() || `Request failed: ${retryRes.status}`);
      }
      if (retryRes.status === 204) return undefined as T;
      return retryRes.json();
    } else {
      window.location.href = '/login';
      throw new Error('Session expired');
    }
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.toString() || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

async function authRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.toString() || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

async function refreshToken(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Auth
export const login = (email: string, password: string) =>
  authRequest<User>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const register = (data: {
  email: string; password: string; display_name: string;
  invite_code?: string; setup_token?: string;
}) => authRequest<User>('/auth/register', { method: 'POST', body: JSON.stringify(data) });

export const logout = () =>
  authRequest<{ success: boolean }>('/auth/logout', { method: 'POST' });

export const getMe = () => authRequest<User>('/auth/me');

export const getSetupStatus = () => authRequest<SetupStatus>('/auth/setup-status');

// Trackers
export const getTrackers = () => request<Tracker[]>('/trackers');
export const getTracker = (id: number) => request<Tracker>(`/trackers/${id}`);
export const createTracker = (data: {
  name: string; url: string;
  threshold_price?: number | null; check_interval_minutes?: number;
  css_selector?: string | null;
}) => request<Tracker>('/trackers', { method: 'POST', body: JSON.stringify(data) });
export const updateTracker = (id: number, data: Partial<Tracker>) =>
  request<Tracker>(`/trackers/${id}`, { method: 'PUT', body: JSON.stringify(data) });
export const deleteTracker = (id: number) =>
  request<void>(`/trackers/${id}`, { method: 'DELETE' });
export const checkTracker = (id: number) =>
  request<Tracker>(`/trackers/${id}/check`, { method: 'POST' });
export const testScrape = (url: string, css_selector?: string) =>
  request<ScrapeResult>('/trackers/test-scrape', {
    method: 'POST', body: JSON.stringify({ url, css_selector }),
  });

// Price history
export const getPriceHistory = (id: number, range?: string) =>
  request<PriceRecord[]>(`/trackers/${id}/prices${range ? `?range=${range}` : ''}`);
export const getSparklines = () =>
  request<Record<string, number[]>>('/trackers/sparklines');

// Settings
export const getSettings = () => request<Record<string, string>>('/settings');
export const updateSettings = (data: Record<string, string>) =>
  request<Record<string, string>>('/settings', { method: 'PUT', body: JSON.stringify(data) });
export const testWebhook = (url: string) =>
  request<{ success: boolean }>('/settings/test-webhook', {
    method: 'POST', body: JSON.stringify({ url }),
  });
export const testNtfy = (url: string) =>
  request<{ success: boolean }>('/settings/test-ntfy', {
    method: 'POST', body: JSON.stringify({ url }),
  });
export const testGenericWebhook = (url: string) =>
  request<{ success: boolean }>('/settings/test-generic-webhook', {
    method: 'POST', body: JSON.stringify({ url }),
  });

// Admin
export const getUsers = () => request<User[]>('/admin/users');
export const adminUpdateUser = (id: number, data: { role?: string; is_active?: number }) =>
  request<User>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
export const adminDeleteUser = (id: number) =>
  request<void>(`/admin/users/${id}`, { method: 'DELETE' });
export const resetUserPassword = (id: number, new_password: string) =>
  request<{ success: boolean }>(`/admin/users/${id}/reset-password`, {
    method: 'POST', body: JSON.stringify({ new_password }),
  });
export const createInvite = (expiresAt?: string) =>
  request<InviteCode>('/admin/invites', {
    method: 'POST', body: JSON.stringify({ expires_at: expiresAt }),
  });
export const getInvites = () => request<InviteCode[]>('/admin/invites');
export const deleteInvite = (id: number) =>
  request<void>(`/admin/invites/${id}`, { method: 'DELETE' });
