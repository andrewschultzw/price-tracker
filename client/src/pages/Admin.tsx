import { useEffect, useState } from 'react';
import { Users, Mail, Copy, Trash2, CheckCircle, Shield, ShieldOff, UserX, UserCheck } from 'lucide-react';
import {
  getUsers, adminUpdateUser, adminDeleteUser,
  createInvite, getInvites, deleteInvite,
} from '../api';
import type { User, InviteCode } from '../types';
import useTitle from '../useTitle';

export default function Admin() {
  useTitle('Admin');
  const [tab, setTab] = useState<'users' | 'invites'>('users');
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<InviteCode[]>([]);
  const [copied, setCopied] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    try {
      const [u, i] = await Promise.all([getUsers(), getInvites()]);
      setUsers(u);
      setInvites(i);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  const handleCreateInvite = async () => {
    await createInvite();
    loadData();
  };

  const handleCopyLink = (code: string, id: number) => {
    const url = `${window.location.origin}/register?code=${code}`;
    navigator.clipboard.writeText(url);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleDeleteInvite = async (id: number) => {
    await deleteInvite(id);
    loadData();
  };

  const handleToggleActive = async (user: User) => {
    await adminUpdateUser(user.id, { is_active: user.is_active ? 0 : 1 });
    loadData();
  };

  const handleToggleRole = async (user: User) => {
    await adminUpdateUser(user.id, { role: user.role === 'admin' ? 'user' : 'admin' });
    loadData();
  };

  const handleDeleteUser = async (user: User) => {
    if (!confirm(`Delete ${user.display_name}? This will delete all their data.`)) return;
    await adminDeleteUser(user.id);
    loadData();
  };

  if (loading) {
    return <div className="flex items-center justify-center h-64 text-text-muted">Loading...</div>;
  }

  const tabClass = (t: string) =>
    `px-4 py-2 text-sm font-medium rounded-lg transition-colors cursor-pointer ${
      tab === t ? 'bg-primary text-white' : 'text-text-muted hover:text-text hover:bg-surface-hover'
    }`;

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Admin</h1>

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('users')} className={tabClass('users')}>
          <span className="flex items-center gap-2"><Users className="w-4 h-4" /> Users</span>
        </button>
        <button onClick={() => setTab('invites')} className={tabClass('invites')}>
          <span className="flex items-center gap-2"><Mail className="w-4 h-4" /> Invites</span>
        </button>
      </div>

      {tab === 'users' && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-text-muted text-left">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map(user => (
                <tr key={user.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-text">{user.display_name}</td>
                  <td className="px-4 py-3 text-text-muted">{user.email}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-1 rounded ${
                      user.role === 'admin' ? 'bg-primary/20 text-primary' : 'bg-surface-hover text-text-muted'
                    }`}>
                      {user.role}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2 py-1 rounded ${
                      user.is_active ? 'bg-success/20 text-success' : 'bg-danger/20 text-danger'
                    }`}>
                      {user.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <button onClick={() => handleToggleRole(user)}
                        title={user.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
                        className="p-1.5 rounded hover:bg-surface-hover text-text-muted hover:text-text transition-colors">
                        {user.role === 'admin' ? <ShieldOff className="w-4 h-4" /> : <Shield className="w-4 h-4" />}
                      </button>
                      <button onClick={() => handleToggleActive(user)}
                        title={user.is_active ? 'Deactivate' : 'Activate'}
                        className="p-1.5 rounded hover:bg-surface-hover text-text-muted hover:text-text transition-colors">
                        {user.is_active ? <UserX className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                      </button>
                      <button onClick={() => handleDeleteUser(user)}
                        title="Delete user"
                        className="p-1.5 rounded hover:bg-danger/20 text-text-muted hover:text-danger transition-colors">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'invites' && (
        <div>
          <button onClick={handleCreateInvite}
            className="flex items-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors mb-4">
            <Mail className="w-4 h-4" />
            Generate Invite
          </button>

          <div className="bg-surface border border-border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-text-muted text-left">
                  <th className="px-4 py-3 font-medium">Code</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invites.map(invite => (
                  <tr key={invite.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 font-mono text-xs text-text">{invite.code}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs font-medium px-2 py-1 rounded ${
                        invite.used_by ? 'bg-surface-hover text-text-muted' : 'bg-success/20 text-success'
                      }`}>
                        {invite.used_by ? 'Used' : 'Available'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-muted">
                      {new Date(invite.created_at + 'Z').toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        {!invite.used_by && (
                          <>
                            <button onClick={() => handleCopyLink(invite.code, invite.id)}
                              title="Copy invite link"
                              className="p-1.5 rounded hover:bg-surface-hover text-text-muted hover:text-text transition-colors">
                              {copied === invite.id ? <CheckCircle className="w-4 h-4 text-success" /> : <Copy className="w-4 h-4" />}
                            </button>
                            <button onClick={() => handleDeleteInvite(invite.id)}
                              title="Revoke invite"
                              className="p-1.5 rounded hover:bg-danger/20 text-text-muted hover:text-danger transition-colors">
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {invites.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-8 text-center text-text-muted">
                      No invite codes yet. Generate one to get started.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
