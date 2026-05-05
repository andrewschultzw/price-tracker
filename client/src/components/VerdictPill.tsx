import type { Tracker } from '../types';

const TIER_STYLES: Record<NonNullable<Tracker['ai_verdict_tier']>, string> = {
  BUY: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-500/20',
  WAIT: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border border-amber-500/20',
  HOLD: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20',
};

interface Props {
  tier: Tracker['ai_verdict_tier'];
  reason?: string | null;
  size?: 'sm' | 'md';
}

export function VerdictPill({ tier, reason, size = 'sm' }: Props) {
  if (!tier) return null;
  const sizeClass = size === 'sm' ? 'px-1.5 py-0.5 text-xs' : 'px-2 py-1 text-sm';
  return (
    <span
      className={`inline-flex items-center rounded-md font-medium tabular-nums ${TIER_STYLES[tier]} ${sizeClass}`}
      title={reason ?? undefined}
    >
      {tier}
    </span>
  );
}
