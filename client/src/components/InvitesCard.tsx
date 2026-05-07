import { useEffect, useState } from 'react';
import { Mail, Copy, X } from 'lucide-react';
import {
  getMyInvites,
  getMyInviteQuota,
  createMyInvite,
  deleteMyInvite,
  type InviteQuota,
} from '../api';
import type { InviteCode } from '../types';

/**
 * Per-user invites card. Visible to all authenticated users on Settings.
 * - Non-admins see "Used: X of N · M remaining"; the Generate button
 *   disables at quota.
 * - Admins see "Unlimited (admin)" and the button never disables on
 *   quota grounds.
 *
 * Spec: docs/superpowers/specs/2026-05-06-per-user-invite-quotas-design.md
 */
export function InvitesCard() {
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [quota, setQuota] = useState<InviteQuota | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      const [q, inv] = await Promise.all([getMyInviteQuota(), getMyInvites()]);
      setQuota(q);
      // Only render unused invites — used ones aren't actionable here.
      setInvites(inv.filter((i) => i.used_by === null));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      await createMyInvite();
      await refresh();
    } catch (e) {
      setError(
        String(e) === 'Error: QUOTA_REACHED'
          ? 'Quota reached.'
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    if (!confirm('Revoke this invite?')) return;
    try {
      await deleteMyInvite(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function copyLink(code: string) {
    navigator.clipboard.writeText(
      `${window.location.origin}/register?code=${code}`,
    );
  }

  const isAdmin = quota?.remaining === null;
  const remaining = quota?.remaining ?? 0;
  const canGenerate = isAdmin || remaining > 0;

  return (
    <section className="bg-surface border border-border rounded-xl p-4 sm:p-6">
      <header className="flex items-center justify-between mb-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Mail className="w-5 h-5 text-primary" /> Invites
        </h2>
        <button
          onClick={handleCreate}
          disabled={busy || !canGenerate}
          className="text-sm bg-primary hover:bg-primary-dark text-white px-3 py-1.5 rounded disabled:opacity-50"
        >
          Generate invite link
        </button>
      </header>

      {quota && (
        <p className="text-text-muted text-sm mb-3">
          {isAdmin
            ? 'Unlimited (admin)'
            : `Used: ${quota.used} of ${quota.default} · ${remaining} remaining`}
        </p>
      )}

      {error && <div className="text-danger text-sm mb-2">{error}</div>}

      {invites.length === 0 ? (
        <p className="text-text-muted text-sm">No active invites.</p>
      ) : (
        <ul className="divide-y divide-border">
          {invites.map((inv) => (
            <li key={inv.id} className="py-2 flex items-center gap-3 flex-wrap">
              <code className="text-text-muted text-xs">{inv.code}</code>
              {inv.expires_at && (
                <span className="text-text-muted text-xs">
                  expires {new Date(inv.expires_at + 'Z').toLocaleDateString()}
                </span>
              )}
              <span className="flex-1" />
              <button
                onClick={() => copyLink(inv.code)}
                className="text-text-muted hover:text-primary text-xs flex items-center gap-1"
                title="Copy invite link"
              >
                <Copy className="w-3 h-3" /> Copy
              </button>
              <button
                onClick={() => handleDelete(inv.id)}
                className="text-text-muted hover:text-danger text-sm"
                title="Revoke"
              >
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
