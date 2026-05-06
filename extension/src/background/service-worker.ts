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

chrome.runtime.onMessage.addListener((_msg, _sender, sendResponse) => {
  sendResponse({ ok: false, error: 'NOT_IMPLEMENTED' });
  return true;
});
