import { getStoredToken } from '../lib/api.js';
import { unsupportedReason, blockedRetailerReason } from '../lib/url-guard.js';
import type {
  ExtensionResponse,
  CreateMessage,
  CheckDupMessage,
  ListProjectsMessage,
  AddToProjectMessage,
  UpdateThresholdMessage,
  ErrorCode,
} from '../lib/messages.js';
import type { TrackerCreatePayload, Tracker } from '../types/api.js';

const root = document.getElementById('root')!;

async function main() {
  swap('tpl-loading');

  const token = await getStoredToken();
  if (!token) { renderNoToken(); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) { renderError('Could not read the active tab.'); return; }

  // Guard non-product URLs (chrome://, about:, file://, javascript:, and
  // URLs whose "hostname" isn't a real DNS name like `chrome://settings`
  // returning 'settings'). Without this, the form pre-fills with the
  // garbage URL, the user clicks Add, the server rejects with 400, and
  // they see a generic validation error. Show a clear "can't track"
  // state instead — no retry button because there's nothing the user
  // can fix from here, just open a product page.
  const unsupported = unsupportedReason(tab.url);
  if (unsupported) { renderUnsupported(unsupported); return; }

  // Guard retailers whose WAF blanket-blocks our egress IP (Home Depot,
  // Best Buy). The user can still technically submit the form, but the
  // server would just mark the seller status='blocked' on creation and
  // they'd never get a price. Cleaner to short-circuit here with the
  // specific "this retailer blocks our scraper" message so they can
  // try a different retailer for the same item.
  const blocked = blockedRetailerReason(tab.url);
  if (blocked) { renderUnsupported(blocked); return; }

  const dup: ExtensionResponse = await chrome.runtime.sendMessage({
    type: 'CHECK_DUP', url: tab.url,
  } satisfies CheckDupMessage);

  if (dup.ok && 'exists' in dup && dup.exists && dup.tracker) {
    renderDup(dup.tracker);
    return;
  }

  renderForm(tab.url, tab.title ?? '');
}

function renderUnsupported(reason: string) {
  swap('tpl-unsupported');
  (root.querySelector('[data-msg]') as HTMLElement).textContent = reason;
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
  host.textContent = formatHost(url);

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
      void renderSuccess(resp.tracker.id);
    } else if (!resp.ok) {
      showError($error, errorText(resp.error, resp.detail));
    }
  });
}

function renderDup(tracker: Tracker) {
  swap('tpl-dup');
  const host = root.querySelector('.host')!;
  host.textContent = formatHost(tracker.url);
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

  // Threshold display + inline edit
  const thresholdDisplay = root.querySelector('[data-threshold-display]') as HTMLElement;
  const editBtn = root.querySelector('[data-edit-threshold]') as HTMLButtonElement;
  const editRow = root.querySelector('[data-threshold-edit]') as HTMLDivElement;
  const input = root.querySelector('[data-threshold-input]') as HTMLInputElement;
  const saveBtn = root.querySelector('[data-save-threshold]') as HTMLButtonElement;

  function fmtThreshold(v: number | null): string {
    return v !== null ? `$${v.toFixed(2)}` : 'not set';
  }
  thresholdDisplay.textContent = fmtThreshold(tracker.threshold_price);
  input.value = tracker.threshold_price !== null ? String(tracker.threshold_price) : '';

  editBtn.addEventListener('click', () => {
    editRow.classList.remove('hidden');
    editBtn.style.display = 'none';
    input.focus();
    input.select();
  });

  saveBtn.addEventListener('click', async () => {
    const raw = input.value.trim().replace(/[$,\s]/g, '');
    let next: number | null;
    if (raw === '') {
      next = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        saveBtn.textContent = 'Invalid';
        setTimeout(() => { saveBtn.textContent = 'Save'; }, 1500);
        return;
      }
      next = n;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = '...';
    const resp = await chrome.runtime.sendMessage({
      type: 'UPDATE_THRESHOLD',
      tracker_id: tracker.id,
      threshold: next,
    } satisfies UpdateThresholdMessage) as ExtensionResponse;
    if (resp.ok && 'tracker' in resp && resp.tracker) {
      thresholdDisplay.textContent = fmtThreshold(resp.tracker.threshold_price);
      editRow.classList.add('hidden');
      editBtn.style.display = '';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    } else {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Retry';
    }
  });
}

async function renderSuccess(trackerId: number) {
  swap('tpl-success');
  const link = root.querySelector('[data-link]') as HTMLAnchorElement;
  link.href = `https://prices.schultzsolutions.tech/tracker/${trackerId}`;

  let userInteracted = false;
  const projectsContainer = root.querySelector('[data-add-to-project]') as HTMLDivElement;
  const select = root.querySelector('[data-project-select]') as HTMLSelectElement;
  const addBtn = root.querySelector('[data-add-project]') as HTMLButtonElement;

  // Start the 2s auto-close timer up-front so the success state still
  // closes promptly even if LIST_PROJECTS is slow. Defers if user has
  // started interacting with the picker.
  setTimeout(() => {
    if (!userInteracted) window.close();
  }, 2000);

  // Lazy-load projects list. Hide the section if API returns 0 projects
  // or fails — failure is non-fatal for the success state.
  const resp = await chrome.runtime.sendMessage({
    type: 'LIST_PROJECTS',
  } satisfies ListProjectsMessage) as ExtensionResponse;

  if (resp.ok && 'projects' in resp && resp.projects.length > 0) {
    projectsContainer.classList.remove('hidden');
    for (const p of resp.projects) {
      const opt = document.createElement('option');
      opt.value = String(p.id);
      opt.textContent = p.name;
      select.appendChild(opt);
    }
    select.addEventListener('change', () => {
      userInteracted = true;
      if (select.value) addBtn.classList.add('visible');
      else addBtn.classList.remove('visible');
    });
    addBtn.addEventListener('click', async () => {
      const projectId = Number(select.value);
      if (!projectId) return;
      addBtn.disabled = true;
      addBtn.textContent = 'Adding...';
      const result = await chrome.runtime.sendMessage({
        type: 'ADD_TO_PROJECT',
        project_id: projectId,
        tracker_id: trackerId,
      } satisfies AddToProjectMessage) as ExtensionResponse;
      if (result.ok) {
        addBtn.textContent = 'Added ✓';
        setTimeout(() => window.close(), 1000);
      } else {
        addBtn.disabled = false;
        addBtn.textContent = 'Retry';
      }
    });
  }
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

function errorText(code: ErrorCode, _detail?: string): string {
  switch (code) {
    case 'NO_TOKEN': return 'Open Settings to paste your API token.';
    case 'UNAUTHORIZED': return 'Token isn\'t working — re-paste in Settings.';
    case 'NETWORK': return 'Couldn\'t reach prices.schultzsolutions.tech.';
    case 'SERVER': return 'Server hiccup — try again, or add manually.';
    case 'VALIDATION': return 'URL doesn\'t look right or is missing required info.';
    case 'CONFLICT': return 'Already tracking this URL.';
    case 'NOT_IMPLEMENTED': return 'This shouldn\'t happen — please report.';
    case 'UNKNOWN': return 'Something went wrong.';
    default: {
      const _exhaustive: never = code;
      return `Something went wrong${_exhaustive ? '' : ''}.`;
    }
  }
}

function formatHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.hostname;
  } catch {
    return '';
  }
}

main().catch(err => renderError(String(err)));
