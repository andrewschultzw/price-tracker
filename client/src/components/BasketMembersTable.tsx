import { useState } from 'react';
import type { BasketMember } from '../types';
import { VerdictPill } from './VerdictPill';
import { updateProjectTracker, removeProjectTracker } from '../api';

interface Props {
  projectId: number;
  members: BasketMember[];
  onChange: () => void;
}

export function BasketMembersTable({ projectId, members, onChange }: Props) {
  const [editingCeiling, setEditingCeiling] = useState<number | null>(null);
  const [ceilingInput, setCeilingInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function saveCeiling(trackerId: number) {
    setError(null);
    try {
      const value = ceilingInput.trim() === '' ? null : Number(ceilingInput);
      if (value !== null && (!Number.isFinite(value) || value <= 0)) {
        setError('Ceiling must be a positive number');
        return;
      }
      await updateProjectTracker(projectId, trackerId, { per_item_ceiling: value });
      setEditingCeiling(null);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleRemove(trackerId: number) {
    if (!confirm('Remove this tracker from the project?')) return;
    try {
      await removeProjectTracker(projectId, trackerId);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  }

  if (members.length === 0) {
    return <div className="text-text-muted text-sm py-4">No items yet. Click "Add Tracker" to start.</div>;
  }

  return (
    <div>
      {error && <div className="text-error text-sm mb-2">{error}</div>}
      <ul className="divide-y divide-border">
        {members.map(m => (
          <li key={m.tracker_id} className="py-3 flex flex-wrap items-center gap-3">
            <a
              href={`/trackers/${m.tracker_id}`}
              className="font-medium text-text hover:text-primary flex-1 min-w-0 truncate"
            >
              {m.tracker_name}
            </a>
            <span className="text-text font-semibold tabular-nums">
              {m.last_price !== null ? `$${m.last_price.toFixed(2)}` : '—'}
            </span>
            <VerdictPill tier={m.ai_verdict_tier} reason={m.ai_verdict_reason} size="sm" />
            {editingCeiling === m.tracker_id ? (
              <input
                autoFocus
                type="number"
                step="0.01"
                value={ceilingInput}
                onChange={e => setCeilingInput(e.target.value)}
                onBlur={() => saveCeiling(m.tracker_id)}
                onKeyDown={e => { if (e.key === 'Enter') saveCeiling(m.tracker_id); }}
                className="w-24 bg-bg border border-border rounded px-2 py-1 text-sm"
                placeholder="ceiling"
              />
            ) : (
              <button
                onClick={() => {
                  setEditingCeiling(m.tracker_id);
                  setCeilingInput(m.per_item_ceiling !== null ? String(m.per_item_ceiling) : '');
                }}
                className="text-xs px-2 py-0.5 rounded border border-border text-text-muted hover:border-primary"
              >
                {m.per_item_ceiling !== null ? `ceiling $${m.per_item_ceiling.toFixed(2)}` : '+ ceiling'}
              </button>
            )}
            <button
              onClick={() => handleRemove(m.tracker_id)}
              className="text-text-muted hover:text-error text-sm"
              title="Remove from project"
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
