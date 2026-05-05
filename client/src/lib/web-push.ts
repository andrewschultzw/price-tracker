// client/src/lib/web-push.ts
import { subscribeWebPush, listWebPushDevices, deleteWebPushDevice } from '../api';
import type { WebPushDevice } from '../types';

export type SubscriptionState =
  | 'unsupported'
  | 'permission-denied'
  | 'available'
  | 'enabled'
  | 'ios-needs-pwa';

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIOSSafari(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches;
}

export function registerSW(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .catch(err => console.warn('SW registration failed', err));
}

export async function getSubscriptionState(): Promise<SubscriptionState> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') {
    return 'permission-denied';
  }
  if (isIOSSafari() && !isStandalone()) {
    return 'ios-needs-pwa';
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'enabled' : 'available';
}

// localStorage key — used to remember the server-side subscription id for
// THIS browser's subscription, so unsubscribePush() can delete the row
// eagerly instead of waiting for natural 410 cleanup on the next alert.
const DEVICE_ID_LS_KEY = 'price-tracker:web-push-device-id';

export async function subscribePush(): Promise<WebPushDevice> {
  if (!VAPID_PUBLIC) {
    throw new Error('VITE_VAPID_PUBLIC_KEY is not set — server has no VAPID configured');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Notification permission denied');
  }
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
  });
  const json = sub.toJSON();
  const device = await subscribeWebPush({
    endpoint: json.endpoint!,
    keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
  });
  // Remember this device's row id so unsubscribePush() can delete it eagerly.
  try { localStorage.setItem(DEVICE_ID_LS_KEY, String(device.id)); } catch { /* private mode — fall back to 410 cleanup */ }
  return device;
}

export async function unsubscribePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) await sub.unsubscribe();
  // Eagerly delete the server-side row using the cached device id from
  // subscribePush(). If localStorage was cleared (private browsing,
  // manual clear, fresh install), we fall back to natural 410 cleanup
  // on the next push attempt — eventually consistent.
  try {
    const cached = localStorage.getItem(DEVICE_ID_LS_KEY);
    if (cached) {
      const id = Number(cached);
      if (Number.isFinite(id)) {
        try { await deleteWebPushDevice(id); } catch { /* row may already be gone */ }
      }
      localStorage.removeItem(DEVICE_ID_LS_KEY);
    }
  } catch { /* localStorage unavailable — server row will be cleaned via 410 */ }
}

export async function getDevices(): Promise<WebPushDevice[]> {
  return listWebPushDevices();
}

export async function removeDevice(id: number): Promise<void> {
  return deleteWebPushDevice(id);
}
