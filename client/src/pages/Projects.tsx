import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Project, ProjectDetail } from '../types';
import { listProjects, getProject, createProject } from '../api';
import { ProjectListCard } from '../components/ProjectListCard';

type StatusFilter = 'active' | 'archived';

export default function ProjectsPage() {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [projects, setProjects] = useState<Project[]>([]);
  const [details, setDetails] = useState<Map<number, ProjectDetail>>(new Map());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listProjects(statusFilter);
        if (cancelled) return;
        setProjects(list);

        // Fetch details for each project to render members + last alert.
        // For small N this is fine — 3-5 projects per user typical.
        const detailEntries = await Promise.all(list.map(p => getProject(p.id).then(d => [p.id, d] as const)));
        if (cancelled) return;
        setDetails(new Map(detailEntries));
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [statusFilter]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const target = Number(newTarget);
      if (!newName.trim() || !Number.isFinite(target) || target <= 0) {
        setError('Name and positive target required');
        return;
      }
      const project = await createProject({ name: newName.trim(), target_total: target });
      setProjects(prev => [project, ...prev]);
      setNewName('');
      setNewTarget('');
      setCreating(false);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="max-w-4xl mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Projects</h1>
        <button
          onClick={() => setCreating(c => !c)}
          className="px-3 py-1.5 rounded bg-primary text-white text-sm font-medium hover:opacity-90"
        >
          {creating ? 'Cancel' : '+ New Project'}
        </button>
      </div>

      <div className="flex gap-2 mb-4">
        {(['active', 'archived'] as const).map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded text-sm ${statusFilter === s ? 'bg-primary text-white' : 'bg-surface border border-border'}`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {creating && (
        <form onSubmit={handleCreate} className="bg-surface border border-border rounded-lg p-4 mb-4 space-y-3">
          <input
            autoFocus
            placeholder="Project name (e.g., NAS Build)"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            className="w-full bg-bg border border-border rounded px-3 py-2"
          />
          <input
            type="number" step="0.01" min="0.01"
            placeholder="Target total ($)"
            value={newTarget}
            onChange={e => setNewTarget(e.target.value)}
            className="w-full bg-bg border border-border rounded px-3 py-2"
          />
          <button type="submit" className="px-4 py-2 rounded bg-primary text-white font-medium">Create</button>
        </form>
      )}

      {error && <div className="text-error text-sm mb-4">{error}</div>}

      {projects.length === 0 ? (
        <div className="text-center py-12 text-text-muted">
          No {statusFilter} projects.{' '}
          <Link to="/" className="text-primary underline">Browse trackers</Link> to add to a project.
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map(p => {
            const detail = details.get(p.id);
            const lastAlert = detail?.recent_notifications[0]?.sent_at ?? null;
            return (
              <ProjectListCard
                key={p.id}
                project={p}
                members={detail?.members ?? []}
                lastAlertAt={lastAlert}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
