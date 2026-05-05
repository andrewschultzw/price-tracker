import type { Project, BasketMember } from '../types';
import { deriveBasketTotal, deriveCompositeVerdict } from '../lib/basket';
import { VerdictPill } from './VerdictPill';

interface Props {
  project: Project;
  members: BasketMember[];
}

export function BasketTotalCard({ project, members }: Props) {
  const total = deriveBasketTotal(members);
  const verdict = deriveCompositeVerdict(project, members);
  const gap = total !== null ? total - project.target_total : null;
  const pct = total !== null ? Math.min(100, Math.round((total / project.target_total) * 100)) : 0;

  return (
    <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <VerdictPill tier={verdict} reason={null} size="md" />
        <div className="text-2xl font-bold">
          {total !== null ? `$${total.toFixed(2)}` : '—'}{' '}
          <span className="text-base font-normal text-text-muted">
            / ${project.target_total.toFixed(2)}
          </span>
        </div>
        {gap !== null && (
          <div className={`text-sm font-medium ${gap > 0 ? 'text-warning' : 'text-success'}`}>
            {gap > 0 ? `▲ $${gap.toFixed(2)} over target` : `▼ $${Math.abs(gap).toFixed(2)} under target`}
          </div>
        )}
      </div>
      <div className="w-full h-2 bg-bg rounded overflow-hidden">
        <div
          className={`h-full transition-all ${verdict === 'BUY' ? 'bg-success' : verdict === 'WAIT' ? 'bg-warning' : 'bg-text-muted'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-text-muted mt-1">{pct}%</div>
    </div>
  );
}
