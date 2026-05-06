// Shared display helpers for the per-seller `condition` enum on tracker_urls.
// Centralized so every notification channel renders the same human label
// for warehouse / refurb / open-box listings — and so the empty-string
// label for 'new' is the single source of truth for "today's alerts look
// unchanged when the winning URL is new".

import type { TrackerUrlCondition } from '../db/queries.js';

const CONDITION_LABEL: Record<TrackerUrlCondition, string> = {
  new: '',
  warehouse: 'Warehouse',
  refurb: 'Refurbished',
  open_box: 'Open Box',
};

export function conditionLabel(condition: TrackerUrlCondition | undefined | null): string {
  if (!condition) return '';
  return CONDITION_LABEL[condition] ?? '';
}

/**
 * Render a price with an optional condition tag. Returns '$239.00' when
 * condition is 'new', undefined, or null (today's behavior). Returns
 * '$239.00 (Warehouse)' (etc.) for non-'new' conditions.
 */
export function formatPriceWithCondition(
  price: number,
  condition: TrackerUrlCondition | undefined | null,
): string {
  const label = conditionLabel(condition);
  const base = `$${price.toFixed(2)}`;
  return label ? `${base} (${label})` : base;
}
