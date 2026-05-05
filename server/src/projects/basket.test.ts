import { describe, it, expect } from 'vitest';
import { evaluateBasket } from './basket.js';
import type { Project, BasketMember } from './types.js';

const project: Project = {
  id: 1, user_id: 1, name: 'Test', target_total: 100,
  status: 'active', created_at: '2026-05-05', updated_at: '2026-05-05',
};

const member = (overrides: Partial<BasketMember> = {}): BasketMember => ({
  tracker_id: 1, tracker_name: 'X', last_price: 50, tracker_status: 'active',
  per_item_ceiling: null, position: 0,
  ai_verdict_tier: null, ai_verdict_reason: null,
  ...overrides,
});

describe('evaluateBasket', () => {
  it('returns no_items when members list is empty', () => {
    const s = evaluateBasket(project, []);
    expect(s.eligible).toBe(false);
    expect(s.ineligible_reason).toBe('no_items');
    expect(s.total).toBeNull();
    expect(s.item_count).toBe(0);
  });

  it('returns item_errored when any member has tracker_status === "error"', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30 }),
      member({ tracker_id: 2, last_price: 40, tracker_status: 'error' }),
    ]);
    expect(s.eligible).toBe(false);
    expect(s.ineligible_reason).toBe('item_errored');
  });

  it('returns item_missing_price when any active member has null last_price', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30 }),
      member({ tracker_id: 2, last_price: null }),
    ]);
    expect(s.eligible).toBe(false);
    expect(s.ineligible_reason).toBe('item_missing_price');
    expect(s.total).toBeNull();
  });

  it('returns eligible true when total < target', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30 }),
      member({ tracker_id: 2, last_price: 40 }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.ineligible_reason).toBeNull();
    expect(s.total).toBe(70);
  });

  it('returns eligible true when total === target (boundary)', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 60 }),
      member({ tracker_id: 2, last_price: 40 }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.total).toBe(100);
  });

  it('returns over_target when total > target', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 80 }),
      member({ tracker_id: 2, last_price: 40 }),
    ]);
    expect(s.eligible).toBe(false);
    expect(s.ineligible_reason).toBe('over_target');
    expect(s.total).toBe(120);
  });

  it('counts items_with_price correctly', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30 }),
      member({ tracker_id: 2, last_price: 40 }),
    ]);
    expect(s.item_count).toBe(2);
    expect(s.items_with_price).toBe(2);
  });

  it('counts items_below_ceiling when ceiling is set and item is below', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30, per_item_ceiling: 35 }),
      member({ tracker_id: 2, last_price: 40, per_item_ceiling: 50 }),
      member({ tracker_id: 3, last_price: 60, per_item_ceiling: 50 }), // over ceiling
    ]);
    // Ceilings are display-only; eligibility unaffected.
    expect(s.items_below_ceiling).toBe(2);
  });

  it('items_below_ceiling counts items WITHOUT a ceiling as "below" (no constraint)', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30, per_item_ceiling: null }),
      member({ tracker_id: 2, last_price: 40, per_item_ceiling: 50 }),
    ]);
    // Both pass — null ceiling = no constraint, so it counts as "below"
    expect(s.items_below_ceiling).toBe(2);
  });

  it('paused members with last_price still contribute to total + eligibility', () => {
    // Paused != error. A paused tracker has a known last_price; the
    // user opted to stop scraping but the price stands.
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 30, tracker_status: 'active' }),
      member({ tracker_id: 2, last_price: 40, tracker_status: 'paused' }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.total).toBe(70);
  });

  it('error precedence: error trumps missing-price', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: null }),
      member({ tracker_id: 2, last_price: 40, tracker_status: 'error' }),
    ]);
    expect(s.ineligible_reason).toBe('item_errored');
  });

  it('returns target_total in the state regardless of eligibility', () => {
    const s = evaluateBasket(project, []);
    expect(s.target_total).toBe(100);
  });

  it('handles single-tracker basket eligible', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 50 }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.total).toBe(50);
    expect(s.item_count).toBe(1);
  });

  it('handles fractional cents correctly', () => {
    const s = evaluateBasket(project, [
      member({ tracker_id: 1, last_price: 33.33 }),
      member({ tracker_id: 2, last_price: 33.33 }),
      member({ tracker_id: 3, last_price: 33.34 }),
    ]);
    expect(s.eligible).toBe(true);
    expect(s.total).toBeCloseTo(100, 2);
  });
});
