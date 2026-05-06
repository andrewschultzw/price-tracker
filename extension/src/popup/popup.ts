async function main() {
  const root = document.getElementById('root')!;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  root.innerHTML = `
    <div class="header"><strong>Price Tracker</strong></div>
    <div class="body">
      <div>${tab?.title ? escapeHtml(tab.title) : '(no title)'}</div>
      <div class="muted">${tab?.url ? escapeHtml(tab.url) : ''}</div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

main().catch(err => console.error('popup failed', err));
