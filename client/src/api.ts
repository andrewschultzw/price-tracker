import type { Tracker, PriceRecord, ScrapeResult } from './types';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.toString() || `Request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// Trackers
export const getTrackers = () => request<Tracker[]>('/trackers');
export const getTracker = (id: number) => request<Tracker>(`/trackers/${id}`);
export const createTracker = (data: {
  name: string;
  url: string;
  threshold_price?: number | null;
  check_interval_minutes?: number;
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
    method: 'POST',
    body: JSON.stringify({ url, css_selector }),
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
    method: 'POST',
    body: JSON.stringify({ url }),
  });
