/**
 * Element-picker content script. Injected on-demand into the active
 * tab via `chrome.scripting.executeScript` when the user clicks the
 * "Pick price element" affordance in the popup. No `<all_urls>`
 * host permission needed — we ride on `activeTab` granted at the
 * moment of the user's explicit action.
 *
 * Behavior:
 *   - Adds a 2px outline to whatever element the cursor is over.
 *   - Floating tooltip near the cursor shows a live preview of the
 *     CSS selector + matched element's price-shaped text (if any).
 *   - Click commits: computes the final selector via @medv/finder,
 *     stores it in chrome.storage.session keyed by tab+url, fires a
 *     success toast, and removes the overlay.
 *   - Esc cancels: removes the overlay, doesn't store anything.
 *   - Right-click also cancels (heuristic for "user changed mind").
 *
 * Idempotency guard: re-injecting the script when a picker is already
 * active is a no-op — we check for an existing overlay root.
 */

import { finder } from '@medv/finder';
import { extractPriceText } from '../lib/price-shape.js';

const OVERLAY_ID = '__price-tracker-picker-overlay__';
const TOOLTIP_ID = '__price-tracker-picker-tooltip__';
const TOAST_ID = '__price-tracker-picker-toast__';
const STYLE_ID = '__price-tracker-picker-style__';

const ACCENT = '#0ea5e9'; // sky-500 — matches the popup's primary

interface PickerResult {
  selector: string;
  matchedText: string | null;
  /** Element's tagName at pick time — useful for the user to sanity-check. */
  tagName: string;
}

interface PickerState {
  cleanup: () => void;
}

function installStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Inline stylesheet so we don't need web_accessible_resources. Scoped
  // to our specific IDs/classes so it can't collide with the host page.
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      pointer-events: none;
      z-index: 2147483646;
      border: 2px solid ${ACCENT};
      box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.15);
      transition: top 60ms linear, left 60ms linear, width 60ms linear, height 60ms linear;
      box-sizing: border-box;
    }
    #${TOOLTIP_ID} {
      position: fixed;
      pointer-events: none;
      z-index: 2147483647;
      background: #0f172a;
      color: #f1f5f9;
      font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 6px 10px;
      border-radius: 6px;
      max-width: 320px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    #${TOOLTIP_ID} .pt-pick-selector {
      color: ${ACCENT};
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #${TOOLTIP_ID} .pt-pick-match {
      color: #34d399;
      margin-left: 8px;
    }
    #${TOOLTIP_ID} .pt-pick-hint {
      color: #94a3b8;
      font-size: 11px;
      margin-top: 2px;
    }
    #${TOAST_ID} {
      position: fixed;
      bottom: 24px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 2147483647;
      background: #0f172a;
      color: #f1f5f9;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 10px 16px;
      border-radius: 8px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.3);
      border-left: 3px solid ${ACCENT};
      animation: ptToastIn 180ms ease-out;
    }
    @keyframes ptToastIn {
      from { opacity: 0; transform: translate(-50%, 8px); }
      to   { opacity: 1; transform: translate(-50%, 0); }
    }
  `;
  document.documentElement.appendChild(style);
}

function ensureNotAlreadyActive(): boolean {
  if (document.getElementById(OVERLAY_ID)) return false;
  return true;
}

function makeTooltip(): HTMLDivElement {
  const tip = document.createElement('div');
  tip.id = TOOLTIP_ID;
  document.documentElement.appendChild(tip);
  return tip;
}

function makeOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  document.documentElement.appendChild(overlay);
  return overlay;
}

function positionOverlay(overlay: HTMLDivElement, rect: DOMRect): void {
  overlay.style.top = `${rect.top}px`;
  overlay.style.left = `${rect.left}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
}

function positionTooltip(tip: HTMLDivElement, ev: MouseEvent): void {
  // Place ~12px below and right of the cursor; flip when near edges.
  const margin = 12;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  let x = ev.clientX + margin;
  let y = ev.clientY + margin;
  if (x + w > window.innerWidth - 8) x = ev.clientX - margin - w;
  if (y + h > window.innerHeight - 8) y = ev.clientY - margin - h;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}

/**
 * Compute a selector for `el` using @medv/finder, with options tuned
 * for the kinds of class names retailers actually emit. Default
 * finder options work fine; we constrain to short selectors (max 4
 * levels deep) because anything longer is more likely to break on
 * the retailer's next CSS refactor than it is to be necessary.
 */
function computeSelector(el: Element): string {
  return finder(el, {
    seedMinLength: 1,
    optimizedMinLength: 2,
    // Hard ceiling so a worst-case DOM doesn't freeze the page while
    // we hover during a fast mouse drag. 100ms is well under the
    // typical mouse-move frame budget and finder's heuristics return
    // a usable selector long before then in normal cases.
    timeoutMs: 100,
    maxNumberOfPathChecks: 200,
  });
}

function startPicker(): PickerState {
  installStyles();
  const overlay = makeOverlay();
  const tooltip = makeTooltip();
  let currentTarget: Element | null = null;

  function renderTooltip(selector: string, matchedText: string | null): void {
    // replaceChildren() clears the tooltip in one call without going
    // through innerHTML — keeps the repo's security-hook regex happy
    // and avoids the (theoretical, since we own all content) XSS risk.
    tooltip.replaceChildren();
    const sel = document.createElement('span');
    sel.className = 'pt-pick-selector';
    sel.textContent = selector;
    tooltip.appendChild(sel);
    if (matchedText) {
      const match = document.createElement('span');
      match.className = 'pt-pick-match';
      match.textContent = `→ ${matchedText}`;
      tooltip.appendChild(match);
    }
    const hint = document.createElement('div');
    hint.className = 'pt-pick-hint';
    hint.textContent = matchedText
      ? 'Click to use • Esc to cancel'
      : 'Click to use (not price-shaped) • Esc to cancel';
    tooltip.appendChild(hint);
  }

  function onMouseMove(ev: MouseEvent): void {
    const target = document.elementFromPoint(ev.clientX, ev.clientY);
    if (!target || target === currentTarget) {
      positionTooltip(tooltip, ev);
      return;
    }
    // Skip our own overlay elements, defensively.
    if ((target as HTMLElement).id === OVERLAY_ID ||
        (target as HTMLElement).id === TOOLTIP_ID ||
        (target as HTMLElement).id === TOAST_ID) {
      return;
    }
    currentTarget = target;
    const rect = target.getBoundingClientRect();
    positionOverlay(overlay, rect);

    let selector: string;
    try {
      selector = computeSelector(target);
    } catch {
      selector = target.tagName.toLowerCase();
    }
    const matchedText = extractPriceText(target);
    renderTooltip(selector, matchedText);
    positionTooltip(tooltip, ev);
  }

  function showToast(message: string): void {
    const existing = document.getElementById(TOAST_ID);
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.id = TOAST_ID;
    toast.textContent = message;
    document.documentElement.appendChild(toast);
    setTimeout(() => { toast.remove(); }, 3500);
  }

  function commit(ev: MouseEvent): void {
    if (!currentTarget) return;
    ev.preventDefault();
    ev.stopPropagation();
    let selector: string;
    try {
      selector = computeSelector(currentTarget);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast(`Couldn't compute a selector for that element: ${msg}`);
      teardown();
      return;
    }
    const matchedText = extractPriceText(currentTarget);
    const result: PickerResult = {
      selector,
      matchedText,
      tagName: currentTarget.tagName.toLowerCase(),
    };
    // chrome.storage.session is the right home for this: short-lived
    // (cleared on browser close), per-profile, and reachable from the
    // popup without needing a runtime message. Keyed by URL so opening
    // the popup on a different tab won't accidentally pick up someone
    // else's selector.
    chrome.storage.session.set({
      pickedSelector: {
        url: location.href,
        ...result,
        pickedAt: Date.now(),
      },
    });
    showToast(matchedText
      ? `Selector saved • matched "${matchedText}" • open the extension to add this tracker`
      : `Selector saved • open the extension to add this tracker (no price-shape match — double-check)`);
    teardown();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      teardown();
    }
  }

  function onScroll(): void {
    // Re-evaluate the hovered element on scroll — without this, the
    // overlay sits stale at the pre-scroll coordinates. Easier than
    // continuously re-emitting mousemove events.
    if (currentTarget) {
      const rect = currentTarget.getBoundingClientRect();
      positionOverlay(overlay, rect);
    }
  }

  function onContextMenu(ev: MouseEvent): void {
    // Right-click cancels — interpret as "I changed my mind".
    ev.preventDefault();
    teardown();
  }

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('click', commit, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('contextmenu', onContextMenu, true);
  window.addEventListener('scroll', onScroll, true);

  function teardown(): void {
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', commit, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    window.removeEventListener('scroll', onScroll, true);
    overlay.remove();
    tooltip.remove();
  }

  return { cleanup: teardown };
}

if (ensureNotAlreadyActive()) {
  startPicker();
}
