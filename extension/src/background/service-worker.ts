import { isTestConnection, isCreate, isCheckDup } from '../lib/messages.js';
import { testConnection, createTracker, listTrackers } from '../lib/api.js';
import { normalizeTrackerUrl } from '../lib/normalize-url.js';
import type { ExtensionResponse, ErrorCode } from '../lib/messages.js';
import type { Tracker } from '../types/api.js';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'add-to-price-tracker',
    title: 'Add to Price Tracker',
    contexts: ['page', 'link'],
    documentUrlPatterns: ['<all_urls>'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'add-to-price-tracker' || !tab?.id) return;
  void chrome.action.openPopup();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  void (async () => {
    sendResponse(await dispatch(msg));
  })();
  return true;
});

const TRACKER_LIST_TTL_MS = 60_000;

interface CachedList {
  fetchedAt: number;
  trackers: Tracker[];
}

async function getCachedTrackerList(): Promise<Tracker[]> {
  const data = await chrome.storage.session.get(['trackerListCache']);
  const cached = data.trackerListCache as CachedList | undefined;
  if (cached && Date.now() - cached.fetchedAt < TRACKER_LIST_TTL_MS) {
    return cached.trackers;
  }
  const trackers = await listTrackers();
  await chrome.storage.session.set({
    trackerListCache: { fetchedAt: Date.now(), trackers } satisfies CachedList,
  });
  return trackers;
}

async function invalidateTrackerCache(): Promise<void> {
  await chrome.storage.session.remove('trackerListCache');
}

async function dispatch(msg: unknown): Promise<ExtensionResponse> {
  try {
    if (isTestConnection(msg)) {
      await testConnection();
      return { ok: true };
    }
    if (isCheckDup(msg)) {
      const target = normalizeTrackerUrl(msg.url);
      if (!target) return { ok: true, exists: false };
      const trackers = await getCachedTrackerList();
      const match = trackers.find(t => t.normalized_url === target);
      return match
        ? { ok: true, exists: true, tracker: match }
        : { ok: true, exists: false };
    }
    if (isCreate(msg)) {
      const tracker = await createTracker(msg.payload);
      await invalidateTrackerCache();
      return { ok: true, tracker };
    }
    return { ok: false, error: 'NOT_IMPLEMENTED' };
  } catch (err) {
    const e = err as { code?: ErrorCode; detail?: string };
    return { ok: false, error: e.code ?? 'UNKNOWN', detail: e.detail };
  }
}
