// server/src/projects/basket.ts
import type { Project, BasketMember, BasketState } from './types.js';

export function evaluateBasket(project: Project, members: BasketMember[]): BasketState {
  const target_total = project.target_total;

  if (members.length === 0) {
    return {
      total: null,
      target_total,
      item_count: 0,
      items_with_price: 0,
      items_below_ceiling: 0,
      eligible: false,
      ineligible_reason: 'no_items',
    };
  }

  const item_count = members.length;
  const items_with_price = members.filter(m => m.last_price !== null).length;
  // null ceiling = no constraint; treat as "below"
  const items_below_ceiling = members.filter(m =>
    m.per_item_ceiling === null || (m.last_price !== null && m.last_price <= m.per_item_ceiling)
  ).length;

  // Errored items take precedence — the basket math is unreliable.
  const errored = members.find(m => m.tracker_status === 'error');
  if (errored) {
    const partial = members
      .filter(m => m.last_price !== null)
      .reduce((sum, m) => sum + (m.last_price as number), 0);
    return {
      total: partial,
      target_total,
      item_count,
      items_with_price,
      items_below_ceiling,
      eligible: false,
      ineligible_reason: 'item_errored',
    };
  }

  // Missing price (e.g. brand-new tracker that hasn't scraped yet).
  if (members.some(m => m.last_price === null)) {
    return {
      total: null,
      target_total,
      item_count,
      items_with_price,
      items_below_ceiling,
      eligible: false,
      ineligible_reason: 'item_missing_price',
    };
  }

  const total = members.reduce((sum, m) => sum + (m.last_price as number), 0);
  const eligible = total <= target_total;

  return {
    total,
    target_total,
    item_count,
    items_with_price,
    items_below_ceiling,
    eligible,
    ineligible_reason: eligible ? null : 'over_target',
  };
}
