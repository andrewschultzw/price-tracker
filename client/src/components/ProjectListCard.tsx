import { Link } from 'react-router-dom';
import type { Project, BasketMember, CompositeVerdictTier } from '../types';
import { VerdictPill } from './VerdictPill';

interface Props {
  project: Project;
  members: BasketMember[];
  lastAlertAt: string | null;
}

function deriveBasketTotal(members: BasketMember[]): number | null {
  if (members.length === 0) return null;
  if (members.some(m => m.last_price === null)) return null;
  return members.reduce((sum, m) => sum + (m.last_price as number), 0);
}

function deriveCompositeVerdict(project: Project, members: BasketMember[]): CompositeVerdictTier {
  const total = deriveBasketTotal(members);
  if (total === null || total > project.target_total) return 'HOLD';
  if (members.some(m => m.ai_verdict_tier === 'WAIT')) return 'WAIT';
  return 'BUY';
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso + 'Z').getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function ProjectListCard({ project, members, lastAlertAt }: Props) {
  const total = deriveBasketTotal(members);
  const verdict = deriveCompositeVerdict(project, members);
  const pct = total !== null ? Math.min(100, Math.round((total / project.target_total) * 100)) : 0;

  return (
    <Link
      to={`/projects/${project.id}`}
      className="block rounded-lg border border-border bg-surface p-4 hover:border-primary transition-colors"
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-text">{project.name}</h3>
        <VerdictPill tier={verdict} reason={null} size="sm" />
      </div>
      <div className="text-sm text-text-muted mb-2">
        {members.length} {members.length === 1 ? 'item' : 'items'} ·{' '}
        {total !== null ? `$${total.toFixed(2)}` : '—'} / ${project.target_total.toFixed(2)} target
      </div>
      <div className="w-full h-2 bg-bg rounded overflow-hidden mb-2">
        <div
          className={`h-full transition-all ${verdict === 'BUY' ? 'bg-success' : verdict === 'WAIT' ? 'bg-warning' : 'bg-text-muted'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="text-xs text-text-muted">
        {lastAlertAt ? `Last alert: ${formatRelative(lastAlertAt)}` : 'No alerts yet'}
      </div>
    </Link>
  );
}
