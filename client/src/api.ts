import type { Tracker, PriceRecord, ScrapeResult, User, InviteCode, SetupStatus, Overlap, Project, BasketMember, ProjectDetail, WebPushDevice, SubscribePayload } from './types';

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
export const getOverlap = (trackerId: number) =>
  request<Overlap>(`/trackers/${trackerId}/overlap`);
export const getOverlapCounts = () =>
  request<Record<number, number>>('/trackers/overlap-counts');

// Price history
export const getPriceHistory = (id: number, range?: string) =>
  request<PriceRecord[]>(`/trackers/${id}/prices${range ? `?range=${range}` : ''}`);
export const getSparklines = () =>
  request<Record<string, number[]>>('/trackers/sparklines');
export interface TrackerStat {
  sparkline: number[]
  min_price: number | null
  min_price_at: string | null
}
export const getTrackerStats = () =>
  request<Record<string, TrackerStat>>('/trackers/stats');

// Notifications
export interface NotificationHistoryRow {
  id: number
  tracker_id: number
  tracker_url_id: number | null
  tracker_name: string
  tracker_url: string
  seller_url: string | null
  price: number
  threshold_price: number
  sent_at: string
  channel: string | null
}
export const getNotificationHistory = (trackerId?: number, limit?: number) => {
  const params = new URLSearchParams()
  if (trackerId != null) params.set('tracker_id', String(trackerId))
  if (limit != null) params.set('limit', String(limit))
  const qs = params.toString()
  return request<NotificationHistoryRow[]>(`/notifications${qs ? '?' + qs : ''}`)
}

// Seller URLs (tracker_urls)
import type { TrackerUrl } from './types'
export const getTrackerUrls = (trackerId: number) =>
  request<TrackerUrl[]>(`/trackers/${trackerId}/urls`);
export const addTrackerUrl = (trackerId: number, url: string) =>
  request<TrackerUrl[]>(`/trackers/${trackerId}/urls`, {
    method: 'POST', body: JSON.stringify({ url }),
  });
export const deleteTrackerUrl = (trackerId: number, urlId: number) =>
  request<TrackerUrl[]>(`/trackers/${trackerId}/urls/${urlId}`, { method: 'DELETE' });

// Settings
export const getSettings = () => request<Record<string, string>>('/settings');
export const updateSettings = (data: Record<string, string>) =>
  request<Record<string, string>>('/settings', { method: 'PUT', body: JSON.stringify(data) });
export interface ChannelTestResult { success: boolean; error?: string }
export const testWebhook = (url: string) =>
  request<ChannelTestResult>('/settings/test-webhook', {
    method: 'POST', body: JSON.stringify({ url }),
  });
export const testNtfy = (url: string, token?: string) =>
  request<ChannelTestResult>('/settings/test-ntfy', {
    method: 'POST', body: JSON.stringify({ url, token }),
  });
export const testGenericWebhook = (url: string) =>
  request<ChannelTestResult>('/settings/test-generic-webhook', {
    method: 'POST', body: JSON.stringify({ url }),
  });
export const testEmail = (recipient: string) =>
  request<ChannelTestResult>('/settings/test-email', {
    method: 'POST', body: JSON.stringify({ recipient }),
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

// Projects
export function listProjects(status?: 'active' | 'archived'): Promise<Project[]> {
  const path = status ? `/projects?status=${status}` : '/projects';
  return request<Project[]>(path);
}

export function createProject(args: { name: string; target_total: number }): Promise<Project> {
  return request<Project>('/projects', {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

export function getProject(id: number): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/projects/${id}`);
}

export function updateProject(
  id: number,
  args: { name?: string; target_total?: number; status?: 'active' | 'archived' },
): Promise<Project> {
  return request<Project>(`/projects/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(args),
  });
}

export function deleteProject(id: number): Promise<void> {
  return request<void>(`/projects/${id}`, { method: 'DELETE' });
}

export function addProjectTracker(
  projectId: number,
  args: { tracker_id: number; per_item_ceiling?: number | null; position?: number },
): Promise<BasketMember[]> {
  return request<BasketMember[]>(`/projects/${projectId}/trackers`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
}

export function removeProjectTracker(projectId: number, trackerId: number): Promise<void> {
  return request<void>(`/projects/${projectId}/trackers/${trackerId}`, { method: 'DELETE' });
}

export function updateProjectTracker(
  projectId: number,
  trackerId: number,
  args: { per_item_ceiling?: number | null; position?: number },
): Promise<BasketMember[]> {
  return request<BasketMember[]>(`/projects/${projectId}/trackers/${trackerId}`, {
    method: 'PATCH',
    body: JSON.stringify(args),
  });
}

// === Web Push ===

export function subscribeWebPush(payload: SubscribePayload): Promise<WebPushDevice> {
  return request<WebPushDevice>('/web-push/subscribe', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function listWebPushDevices(): Promise<WebPushDevice[]> {
  return request<WebPushDevice[]>('/web-push/devices');
}

export function deleteWebPushDevice(id: number): Promise<void> {
  return request<void>(`/web-push/subscriptions/${id}`, { method: 'DELETE' });
}

// === API Tokens (Connected Apps) ===

export interface ApiTokenSummary {
  id: number;
  name: string;
  prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface CreatedApiToken extends ApiTokenSummary {
  token: string; // plaintext, only here
}

export async function listApiTokens(): Promise<ApiTokenSummary[]> {
  const r = await fetch('/api/settings/api-tokens', { credentials: 'include' });
  if (!r.ok) throw new Error(`listApiTokens failed: ${r.status}`);
  return r.json();
}

export async function createApiToken(name: string): Promise<CreatedApiToken> {
  const r = await fetch('/api/settings/api-tokens', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`createApiToken failed: ${r.status}`);
  return r.json();
}

export async function revokeApiToken(id: number): Promise<void> {
  const r = await fetch(`/api/settings/api-tokens/${id}`, {
    method: 'DELETE', credentials: 'include',
  });
  if (!r.ok) throw new Error(`revokeApiToken failed: ${r.status}`);
}

// === Per-user invites (Settings → Invites card) ===

export interface InviteQuota {
  used: number;
  /** null = unlimited (admin) */
  remaining: number | null;
  default: number;
}

export async function getMyInvites(): Promise<InviteCode[]> {
  const r = await fetch('/api/invites', { credentials: 'include' });
  if (!r.ok) throw new Error(`getMyInvites failed: ${r.status}`);
  return r.json();
}

export async function getMyInviteQuota(): Promise<InviteQuota> {
  const r = await fetch('/api/invites/quota', { credentials: 'include' });
  if (!r.ok) throw new Error(`getMyInviteQuota failed: ${r.status}`);
  return r.json();
}

export async function createMyInvite(expires_at?: string): Promise<InviteCode> {
  const r = await fetch('/api/invites', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expires_at }),
  });
  if (r.status === 429) throw new Error('QUOTA_REACHED');
  if (!r.ok) throw new Error(`createMyInvite failed: ${r.status}`);
  return r.json();
}

export async function deleteMyInvite(id: number): Promise<void> {
  const r = await fetch(`/api/invites/${id}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!r.ok) throw new Error(`deleteMyInvite failed: ${r.status}`);
}

// === Public product pages (anonymous /p/<slug>) ===

export interface PublicProduct {
  slug: string;
  display_name: string;
  normalized_url: string;
  lowest_current_price: number | null;
  lowest_ever_price: number | null;
  sample_count: number;
  first_observed: string | null;
  price_history: Array<{ date: string; price: number }>;
}

/**
 * Fetch a public product page payload by slug. Deliberately omits
 * `credentials: 'include'` — these endpoints are public and we don't
 * want to send the authenticated user's cookie when it isn't needed.
 * Throws Error('NOT_FOUND') on 404 so the caller can render a clean
 * "Product not found" state.
 */
export async function getPublicProduct(slug: string): Promise<PublicProduct> {
  const r = await fetch(`/api/public/products/${encodeURIComponent(slug)}`);
  if (r.status === 404) throw new Error('NOT_FOUND');
  if (!r.ok) throw new Error(`getPublicProduct failed: ${r.status}`);
  return r.json();
}

// === Community deal feed (anonymous /deals) ===

export interface DealFeedEntry {
  slug: string;
  display_name: string;
  current_price: number;
  threshold_price: number;
  drop_pct: number;
  hours_ago: number;
  normalized_url: string;
}

export interface DealFeedResponse {
  entries: DealFeedEntry[];
  generated_at: string;
}

/**
 * Fetch the public community deal feed. Like getPublicProduct, this
 * deliberately omits `credentials: 'include'` — the endpoint is fully
 * public and we don't want to send the authenticated user's cookie when
 * it isn't needed.
 */
export async function getCommunityDeals(): Promise<DealFeedResponse> {
  const r = await fetch('/api/public/deals');
  if (!r.ok) throw new Error(`getCommunityDeals failed: ${r.status}`);
  return r.json();
}
