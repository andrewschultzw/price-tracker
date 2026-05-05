import type { Tracker } from '../types';
import { VerdictPill } from './VerdictPill';

function formatRelative(ms: number | null | undefined): string {
  if (!ms) return '';
  const diffMin = Math.round((Date.now() - ms) / 60000);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

interface Props {
  tracker: Tracker;
}

export function AIInsightsCard({ tracker }: Props) {
  const hasVerdict = !!tracker.ai_verdict_tier;
  const hasSummary = !!tracker.ai_summary;
  if (!hasVerdict && !hasSummary) return null;

  return (
    <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <VerdictPill
            tier={tracker.ai_verdict_tier ?? null}
            reason={tracker.ai_verdict_reason ?? null}
            size="md"
          />
          {tracker.ai_verdict_updated_at && (
            <span className="text-xs text-text-muted">
              Updated {formatRelative(tracker.ai_verdict_updated_at)}
            </span>
          )}
        </div>
      </div>

      {tracker.ai_verdict_reason && (
        <p className="text-sm font-medium text-text mb-2">
          {tracker.ai_verdict_reason}
        </p>
      )}

      {tracker.ai_summary && (
        <p className="text-sm italic text-text-muted">
          {tracker.ai_summary}
        </p>
      )}
    </div>
  );
}
