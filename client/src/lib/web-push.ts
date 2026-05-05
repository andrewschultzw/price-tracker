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
  return subscribeWebPush({
    endpoint: json.endpoint!,
    keys: { p256dh: json.keys!.p256dh, auth: json.keys!.auth },
  });
}

export async function unsubscribePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await sub.unsubscribe();
    // Note: we deliberately don't delete the server-side row here. The
    // /devices endpoint redacts the encrypted endpoint+keys for security,
    // so we can't match by endpoint client-side. Instead, we let natural
    // 410 cleanup handle the server side: the next push attempt to the
    // now-invalidated endpoint will return 410, and the firer deletes the
    // row. Slightly delayed but eventually consistent.
  }
}

export async function getDevices(): Promise<WebPushDevice[]> {
  return listWebPushDevices();
}

export async function removeDevice(id: number): Promise<void> {
  return deleteWebPushDevice(id);
}
