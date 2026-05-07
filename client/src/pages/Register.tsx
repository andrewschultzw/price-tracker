import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, UserPlus } from 'lucide-react';
import { register } from '../api';
import { useAuth } from '../context/AuthContext';

export default function Register() {
  const [searchParams] = useSearchParams();
  const inviteCode = searchParams.get('code') || '';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [inviteState, setInviteState] = useState<'idle' | 'checking' | 'valid' | 'invalid'>('idle');
  const [inviterName, setInviterName] = useState<string | null>(null);
  const [invalidReason, setInvalidReason] = useState<string | null>(null);
  const { setUser } = useAuth();
  const navigate = useNavigate();

  // Validate invite code on mount
  useEffect(() => {
    if (!inviteCode) return;
    setInviteState('checking');
    fetch(`/api/auth/invite-info/${inviteCode}`)
      .then(async r => {
        const data = await r.json();
        if (data.valid) {
          setInviteState('valid');
          setInviterName(data.inviter_name);
        } else {
          setInviteState('invalid');
          setInvalidReason(data.reason);
        }
      })
      .catch(() => {
        setInviteState('invalid');
        setInvalidReason('not_found');
      });
  }, [inviteCode]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const user = await register({
        email,
        password,
        display_name: displayName,
        invite_code: inviteCode,
      });
      setUser(user);
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setSubmitting(false);
    }
  };

  // No code in URL
  if (!inviteCode) {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <div className="bg-surface border border-border rounded-xl p-6 max-w-sm w-full text-center">
          <h2 className="text-lg font-semibold mb-2">Invite Required</h2>
          <p className="text-text-muted text-sm">
            You need an invite link to create an account. Ask an admin for one.
          </p>
        </div>
      </div>
    );
  }

  // Validating the invite code
  if (inviteState === 'checking') {
    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <div className="bg-surface border border-border rounded-xl p-6 max-w-sm w-full text-center">
          <div className="mb-4">
            <div className="inline-block w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          </div>
          <p className="text-text-muted text-sm">Checking invite...</p>
        </div>
      </div>
    );
  }

  // Invalid invite code
  if (inviteState === 'invalid') {
    const reasonMessages: Record<string, string> = {
      'not_found': 'This invite link doesn\'t exist.',
      'already_used': 'This invite has already been redeemed.',
      'expired': 'This invite has expired.',
    };
    const message = reasonMessages[invalidReason || 'not_found'] || 'Invalid invite link.';

    return (
      <div className="min-h-screen bg-bg flex items-center justify-center px-4">
        <div className="bg-surface border border-border rounded-xl p-6 max-w-sm w-full text-center">
          <h2 className="text-lg font-semibold mb-2 text-danger">Invite Invalid</h2>
          <p className="text-text-muted text-sm">
            {message}
          </p>
        </div>
      </div>
    );
  }

  // Valid invite - show form
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-8">
          <BarChart3 className="w-8 h-8 text-primary" />
          <h1 className="text-2xl font-bold text-text">Price Tracker</h1>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-1 text-center">Create Account</h2>
          {inviterName ? (
            <p className="text-text-muted text-sm text-center mb-4">Invited by {inviterName}</p>
          ) : (
            <p className="text-text-muted text-sm text-center mb-4">Invited</p>
          )}

          {error && (
            <div className="bg-danger/10 border border-danger/30 text-danger rounded-lg px-4 py-2 mb-4 text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1.5">Display Name</label>
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
                required autoFocus
                className="w-full bg-bg border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1.5">Email</label>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                required
                className="w-full bg-bg border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary" />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-muted mb-1.5">Password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                required minLength={8}
                className="w-full bg-bg border border-border rounded-lg px-4 py-2.5 text-text placeholder-text-muted/50 focus:outline-none focus:border-primary" />
              <p className="text-xs text-text-muted mt-1">Minimum 8 characters</p>
            </div>
            <button type="submit" disabled={submitting}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg font-medium transition-colors disabled:opacity-50">
              <UserPlus className="w-4 h-4" />
              {submitting ? 'Creating account...' : 'Create Account'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
