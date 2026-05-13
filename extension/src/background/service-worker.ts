import {
  isTestConnection,
  isCreate,
  isCheckDup,
  isListProjects,
  isAddToProject,
  isUpdateThreshold,
  isStartPicker,
} from '../lib/messages.js';
import {
  testConnection,
  createTracker,
  listTrackers,
  listProjects,
  addTrackerToProject,
  updateTrackerThreshold,
} from '../lib/api.js';
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
const BADGE_TRACKED = '✓';
const BADGE_COLOR = '#10b981';

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

async function updateBadgeForTab(tabId: number, url: string | undefined): Promise<void> {
  if (!url) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  const normalized = normalizeTrackerUrl(url);
  if (!normalized) {
    await chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  // Best-effort: skip silently on token errors / network failures.
  try {
    const trackers = await getCachedTrackerList();
    const matched = trackers.some(t => t.normalized_url === normalized);
    if (matched) {
      await chrome.action.setBadgeText({ tabId, text: BADGE_TRACKED });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
    } else {
      await chrome.action.setBadgeText({ tabId, text: '' });
    }
  } catch {
    await chrome.action.setBadgeText({ tabId, text: '' });
  }
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateBadgeForTab(tabId, tab.url);
  } catch {
    // tab might be gone — ignore
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only react when the page finishes loading. URL updates without a
  // 'complete' status (e.g. SPA pushState) won't be reliable anyway.
  if (changeInfo.status !== 'complete') return;
  await updateBadgeForTab(tabId, tab.url);
});

async function repaintActiveTabBadge(): Promise<void> {
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id && activeTab.url) {
      await updateBadgeForTab(activeTab.id, activeTab.url);
    }
  } catch {
    // ignore — badge is best-effort
  }
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
      // Re-prime the cache so the new tracker is included, then repaint
      // the badge on the active tab so the green ✓ appears immediately.
      await getCachedTrackerList();
      await repaintActiveTabBadge();
      return { ok: true, tracker };
    }
    if (isListProjects(msg)) {
      const projects = await listProjects();
      return { ok: true, projects: projects.map(p => ({ id: p.id, name: p.name })) };
    }
    if (isAddToProject(msg)) {
      await addTrackerToProject(msg.project_id, msg.tracker_id);
      return { ok: true };
    }
    if (isUpdateThreshold(msg)) {
      const tracker = await updateTrackerThreshold(msg.tracker_id, msg.threshold);
      await invalidateTrackerCache();
      return { ok: true, tracker };
    }
    if (isStartPicker(msg)) {
      // Inject the picker content script into the user's active tab.
      // activeTab + scripting permissions cover this: no broad
      // host_permissions needed — the user clicked our button on this
      // very tab, which is the modern MV3 idiom.
      //
      // The picker.ts source lives in the manifest's content_scripts
      // array (with a never-matching pattern, so it doesn't auto-
      // inject). @crxjs bundles it into a content-hashed file under
      // assets/; we read that path from the live manifest at runtime
      // rather than hard-coding it.
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return { ok: false, error: 'UNKNOWN', detail: 'No active tab' };
      const pickerJs = chrome.runtime.getManifest().content_scripts?.[0]?.js?.[0];
      if (!pickerJs) {
        return { ok: false, error: 'UNKNOWN', detail: 'Picker bundle not found in manifest' };
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: [pickerJs],
        });
        return { ok: true };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'UNKNOWN', detail };
      }
    }
    return { ok: false, error: 'NOT_IMPLEMENTED' };
  } catch (err) {
    const e = err as { code?: ErrorCode; detail?: string };
    return { ok: false, error: e.code ?? 'UNKNOWN', detail: e.detail };
  }
}
