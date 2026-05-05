import { useEffect, useState } from 'react';
import type { Tracker } from '../types';
import { addProjectTracker } from '../api';

interface Props {
  projectId: number;
  excludeIds: Set<number>;
  onClose: () => void;
  onAdded: () => void;
}

export function AddTrackerModal({ projectId, excludeIds, onClose, onAdded }: Props) {
  const [trackers, setTrackers] = useState<Tracker[]>([]);
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [ceilingInput, setCeilingInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch('/api/trackers', { credentials: 'include' });
        if (!resp.ok) throw new Error(`status ${resp.status}`);
        const all = await resp.json() as Tracker[];
        setTrackers(all.filter(t => !excludeIds.has(t.id)));
      } catch (e) {
        setError(String(e));
      }
    })();
  }, [excludeIds]);

  const filtered = trackers.filter(t =>
    t.name.toLowerCase().includes(search.toLowerCase())
  );

  async function handleAdd() {
    if (selectedId === null) return;
    setError(null);
    try {
      const ceiling = ceilingInput.trim() === '' ? null : Number(ceilingInput);
      if (ceiling !== null && (!Number.isFinite(ceiling) || ceiling <= 0)) {
        setError('Ceiling must be a positive number');
        return;
      }
      await addProjectTracker(projectId, { tracker_id: selectedId, per_item_ceiling: ceiling });
      onAdded();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-surface border border-border rounded-lg p-4 w-full max-w-md max-h-[80vh] overflow-y-auto">
        <h3 className="font-bold mb-3">Add tracker to project</h3>
        <input
          autoFocus
          placeholder="Search trackers..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full bg-bg border border-border rounded px-3 py-2 mb-3"
        />
        <div className="max-h-64 overflow-y-auto border border-border rounded mb-3">
          {filtered.length === 0 ? (
            <div className="p-3 text-text-muted text-sm">No trackers match.</div>
          ) : (
            filtered.map(t => (
              <button
                key={t.id}
                onClick={() => setSelectedId(t.id)}
                className={`w-full text-left p-2 hover:bg-bg ${selectedId === t.id ? 'bg-bg ring-1 ring-primary' : ''}`}
              >
                <div className="font-medium">{t.name}</div>
                <div className="text-xs text-text-muted">
                  {t.last_price !== null ? `$${t.last_price.toFixed(2)}` : '—'}
                </div>
              </button>
            ))
          )}
        </div>
        <input
          type="number" step="0.01" min="0.01"
          placeholder="Per-item ceiling (optional)"
          value={ceilingInput}
          onChange={e => setCeilingInput(e.target.value)}
          className="w-full bg-bg border border-border rounded px-3 py-2 mb-3"
        />
        {error && <div className="text-error text-sm mb-2">{error}</div>}
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 rounded border border-border">Cancel</button>
          <button
            onClick={handleAdd}
            disabled={selectedId === null}
            className="px-3 py-1.5 rounded bg-primary text-white font-medium disabled:opacity-50"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
