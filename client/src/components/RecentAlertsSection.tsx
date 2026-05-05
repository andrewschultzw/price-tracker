import type { ProjectNotificationRecord } from '../types';

interface Props {
  notifications: ProjectNotificationRecord[];
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso + 'Z').getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

const CHANNEL_LABELS: Record<string, string> = {
  discord: 'Discord',
  ntfy: 'ntfy',
  email: 'Email',
  webhook: 'Webhook',
};

export function RecentAlertsSection({ notifications }: Props) {
  if (notifications.length === 0) {
    return <div className="text-text-muted text-sm py-2">No alerts yet.</div>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {notifications.map(n => (
        <li key={n.id} className="flex flex-wrap gap-2 text-text-muted">
          <span>•</span>
          <span>{formatRelative(n.sent_at)}</span>
          <span className="text-text">{CHANNEL_LABELS[n.channel] ?? n.channel}</span>
          <span>${n.basket_total.toFixed(2)} → fired</span>
          {n.ai_commentary && <span className="italic">"{n.ai_commentary}"</span>}
        </li>
      ))}
    </ul>
  );
}
