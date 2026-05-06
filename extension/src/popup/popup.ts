import { getStoredToken } from '../lib/api.js';
import type { ExtensionResponse, CreateMessage, CheckDupMessage } from '../lib/messages.js';
import type { TrackerCreatePayload, Tracker } from '../types/api.js';

const root = document.getElementById('root')!;

async function main() {
  swap('tpl-loading');

  const token = await getStoredToken();
  if (!token) { renderNoToken(); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) { renderError('Could not read the active tab.'); return; }

  const dup: ExtensionResponse = await chrome.runtime.sendMessage({
    type: 'CHECK_DUP', url: tab.url,
  } satisfies CheckDupMessage);

  if (dup.ok && 'exists' in dup && dup.exists && dup.tracker) {
    renderDup(dup.tracker);
    return;
  }

  renderForm(tab.url, tab.title ?? '');
}

function renderNoToken() {
  swap('tpl-no-token');
  root.querySelector('[data-action="open-options"]')!.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
}

function renderForm(url: string, title: string) {
  swap('tpl-form');
  const host = root.querySelector('.host')!;
  host.textContent = new URL(url).hostname;

  const $name = root.querySelector('[data-field="name"]') as HTMLInputElement;
  const $url = root.querySelector('[data-field="url"]') as HTMLInputElement;
  const $threshold = root.querySelector('[data-field="threshold"]') as HTMLInputElement;
  const $css = root.querySelector('[data-field="css"]') as HTMLInputElement;
  const $interval = root.querySelector('[data-field="interval"]') as HTMLInputElement;
  $name.value = title;
  $url.value = url;
  $name.focus();
  $name.select();

  const $error = root.querySelector('[data-error]') as HTMLDivElement;

  root.querySelector('[data-action="add"]')!.addEventListener('click', async () => {
    $error.classList.add('hidden');
    const payload: TrackerCreatePayload = {
      name: $name.value.trim(),
      url: $url.value,
      threshold_price: parseThreshold($threshold.value),
      css_selector: $css.value.trim() || null,
      check_interval_minutes: parseInterval($interval.value),
    };
    if (!payload.name) { showError($error, 'Name is required.'); return; }
    const msg: CreateMessage = { type: 'CREATE', payload };
    const resp = await chrome.runtime.sendMessage(msg) as ExtensionResponse;
    if (resp.ok && 'tracker' in resp && resp.tracker) {
      renderSuccess(resp.tracker.id);
    } else if (!resp.ok) {
      showError($error, errorText(resp.error, resp.detail));
    }
  });
}

function renderDup(tracker: Tracker) {
  swap('tpl-dup');
  const host = root.querySelector('.host')!;
  try { host.textContent = new URL(tracker.url).hostname; } catch { /* keep blank */ }
  (root.querySelector('[data-name]') as HTMLElement).textContent = tracker.name;
  (root.querySelector('[data-price]') as HTMLElement).textContent =
    tracker.last_price !== null ? `$${tracker.last_price.toFixed(2)}` : '—';
  if (tracker.ai_verdict_tier) {
    const pill = root.querySelector('[data-verdict]') as HTMLElement;
    pill.textContent = tracker.ai_verdict_tier;
    pill.classList.remove('hidden');
    pill.classList.add(tracker.ai_verdict_tier.toLowerCase());
  }
  (root.querySelector('[data-reason]') as HTMLElement).textContent =
    tracker.ai_verdict_reason ?? '';
  (root.querySelector('[data-link]') as HTMLAnchorElement).href =
    `https://prices.schultzsolutions.tech/tracker/${tracker.id}`;
}

function renderSuccess(trackerId: number) {
  swap('tpl-success');
  const link = root.querySelector('[data-link]') as HTMLAnchorElement;
  link.href = `https://prices.schultzsolutions.tech/tracker/${trackerId}`;
  setTimeout(() => window.close(), 2000);
}

function renderError(text: string) {
  swap('tpl-error');
  (root.querySelector('[data-msg]') as HTMLElement).textContent = text;
  root.querySelector('[data-action="retry"]')!.addEventListener('click', () => location.reload());
  root.querySelector('[data-action="open-options"]')!.addEventListener('click', () => chrome.runtime.openOptionsPage());
}

function swap(tplId: string) {
  const tpl = document.getElementById(tplId) as HTMLTemplateElement;
  root.replaceChildren(tpl.content.cloneNode(true));
}

function showError(node: HTMLDivElement, msg: string) {
  node.textContent = msg;
  node.classList.remove('hidden');
}

function parseThreshold(s: string): number | null {
  const n = parseFloat(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseInterval(s: string): number | undefined {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n >= 5 ? n : undefined;
}

function errorText(code: string, detail?: string): string {
  switch (code) {
    case 'NO_TOKEN': return 'Open Settings to paste your API token.';
    case 'UNAUTHORIZED': return 'Token isn\'t working — re-paste in Settings.';
    case 'NETWORK': return 'Couldn\'t reach prices.schultzsolutions.tech.';
    case 'SERVER': return 'Server hiccup — try again, or add manually.';
    case 'VALIDATION': return `URL doesn't look right${detail ? ` (${detail})` : ''}.`;
    case 'CONFLICT': return 'Already tracking this URL.';
    default: return 'Something went wrong.';
  }
}

main().catch(err => renderError(String(err)));
