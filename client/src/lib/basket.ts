import type { Project, BasketMember, CompositeVerdictTier } from '../types';

/**
 * Sums member.last_price across all members. Returns null if any member has
 * no last_price — same gating as the server-side basket eligibility check
 * (which refuses to fire alerts on a partial basket).
 */
export function deriveBasketTotal(members: BasketMember[]): number | null {
  if (members.length === 0) return null;
  if (members.some(m => m.last_price === null)) return null;
  return members.reduce((sum, m) => sum + (m.last_price as number), 0);
}

/**
 * Composite project verdict computed deterministically from member verdicts
 * and basket eligibility. Mirrors the spec rules:
 *   HOLD if total is missing or above target
 *   WAIT if any member's per-tracker AI verdict is WAIT
 *   BUY otherwise
 * Pure — no Claude call, no server round-trip.
 */
export function deriveCompositeVerdict(project: Project, members: BasketMember[]): CompositeVerdictTier {
  const total = deriveBasketTotal(members);
  if (total === null || total > project.target_total) return 'HOLD';
  if (members.some(m => m.ai_verdict_tier === 'WAIT')) return 'WAIT';
  return 'BUY';
}
