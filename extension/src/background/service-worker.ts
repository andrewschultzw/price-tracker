import { isTestConnection } from '../lib/messages.js';
import { testConnection } from '../lib/api.js';
import type { ExtensionResponse, ErrorCode } from '../lib/messages.js';

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

async function dispatch(msg: unknown): Promise<ExtensionResponse> {
  try {
    if (isTestConnection(msg)) {
      await testConnection();
      return { ok: true };
    }
    return { ok: false, error: 'NOT_IMPLEMENTED' };
  } catch (err) {
    const e = err as { code?: ErrorCode; detail?: string };
    return { ok: false, error: e.code ?? 'UNKNOWN', detail: e.detail };
  }
}
