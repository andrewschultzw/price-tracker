import { useEffect, useState, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { ProjectDetail } from '../types';
import { getProject, updateProject, deleteProject } from '../api';
import { BasketTotalCard } from '../components/BasketTotalCard';
import { BasketMembersTable } from '../components/BasketMembersTable';
import { AddTrackerModal } from '../components/AddTrackerModal';
import { RecentAlertsSection } from '../components/RecentAlertsSection';

export default function ProjectDetailPage() {
  const { id: idParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const id = Number(idParam);
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editingTarget, setEditingTarget] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [targetInput, setTargetInput] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);

  const reload = useCallback(async () => {
    try {
      const d = await getProject(id);
      setData(d);
      setNameInput(d.project.name);
      setTargetInput(String(d.project.target_total));
    } catch (e) {
      setError(String(e));
    }
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  async function saveName() {
    if (!data) return;
    setEditingName(false);
    if (nameInput.trim() === data.project.name) return;
    try {
      await updateProject(id, { name: nameInput.trim() });
      reload();
    } catch (e) { setError(String(e)); }
  }

  async function saveTarget() {
    if (!data) return;
    setEditingTarget(false);
    const t = Number(targetInput);
    if (!Number.isFinite(t) || t <= 0 || t === data.project.target_total) return;
    try {
      await updateProject(id, { target_total: t });
      reload();
    } catch (e) { setError(String(e)); }
  }

  async function toggleArchive() {
    if (!data) return;
    const next = data.project.status === 'active' ? 'archived' : 'active';
    try {
      await updateProject(id, { status: next });
      reload();
    } catch (e) { setError(String(e)); }
  }

  async function handleDelete() {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    try {
      await deleteProject(id);
      navigate('/projects');
    } catch (e) { setError(String(e)); }
  }

  if (error) return <div className="p-4 text-error">{error}</div>;
  if (!data) return <div className="p-4 text-text-muted">Loading…</div>;

  const memberIds = new Set(data.members.map(m => m.tracker_id));

  return (
    <div className="max-w-4xl mx-auto p-4">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-text-muted hover:text-text text-sm mb-4">
        <ArrowLeft className="w-4 h-4" /> Projects
      </Link>

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0 flex-1">
            {editingName ? (
              <input
                autoFocus
                value={nameInput}
                onChange={e => setNameInput(e.target.value)}
                onBlur={saveName}
                onKeyDown={e => { if (e.key === 'Enter') saveName(); }}
                className="bg-bg border border-border rounded px-3 py-1.5 text-xl font-bold w-full"
              />
            ) : (
              <h1 className="text-xl sm:text-2xl font-bold cursor-pointer" onClick={() => setEditingName(true)}>
                {data.project.name}
              </h1>
            )}
            <div className="text-sm text-text-muted mt-1">
              Target:{' '}
              {editingTarget ? (
                <input
                  autoFocus
                  type="number" step="0.01" min="0.01"
                  value={targetInput}
                  onChange={e => setTargetInput(e.target.value)}
                  onBlur={saveTarget}
                  onKeyDown={e => { if (e.key === 'Enter') saveTarget(); }}
                  className="bg-bg border border-border rounded px-2 py-0.5 text-sm w-24"
                />
              ) : (
                <span className="cursor-pointer" onClick={() => setEditingTarget(true)}>
                  ${data.project.target_total.toFixed(2)}
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={toggleArchive} className="px-2 py-1 text-sm border border-border rounded">
              {data.project.status === 'active' ? 'Archive' : 'Unarchive'}
            </button>
            <button onClick={handleDelete} className="px-2 py-1 text-sm border border-border text-error rounded">
              Delete
            </button>
          </div>
        </div>
      </div>

      <BasketTotalCard project={data.project} members={data.members} />

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6 mb-6">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Items ({data.members.length})</h2>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-3 py-1.5 rounded bg-primary text-white text-sm font-medium"
          >
            + Add Tracker
          </button>
        </div>
        <BasketMembersTable projectId={id} members={data.members} onChange={reload} />
      </div>

      <div className="bg-surface border border-border rounded-xl p-4 sm:p-6">
        <h2 className="font-semibold mb-3">Recent alerts</h2>
        <RecentAlertsSection notifications={data.recent_notifications} />
      </div>

      {showAddModal && (
        <AddTrackerModal
          projectId={id}
          excludeIds={memberIds}
          onClose={() => setShowAddModal(false)}
          onAdded={reload}
        />
      )}
    </div>
  );
}
