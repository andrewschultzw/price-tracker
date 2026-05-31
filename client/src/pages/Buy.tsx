import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getBuyIntent, approveBuyIntent, resolveBuyIntent, type BuyIntentView } from '../api';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; data: BuyIntentView }
  | { kind: 'not-found' }
  | { kind: 'error'; message: string };

export default function Buy() {
  const { token } = useParams<{ token: string }>();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);

  const load = () => {
    if (!token) { setState({ kind: 'not-found' }); return; }
    setState({ kind: 'loading' });
    getBuyIntent(token)
      .then(data => setState({ kind: 'ready', data }))
      .catch(err => setState(err.message === 'NOT_FOUND'
        ? { kind: 'not-found' }
        : { kind: 'error', message: String(err.message ?? err) }));
  };
  useEffect(load, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.kind === 'loading') return <div className="p-6">Loading…</div>;
  if (state.kind === 'not-found') return <div className="p-6">This purchase link isn't valid anymore.</div>;
  if (state.kind === 'error') return <div className="p-6 text-red-600">Error: {state.message}</div>;

  const { intent, tracker, cartUrl } = state.data;
  const isOpen = intent.status === 'armed' || intent.status === 'approved';

  const onApprove = async () => {
    if (!token) return;
    setBusy(true);
    try {
      const { cartUrl: url } = await approveBuyIntent(token);
      window.open(url, '_blank', 'noopener');
      load();
    } finally { setBusy(false); }
  };

  const onResolve = async (outcome: 'purchased' | 'not_completed') => {
    if (!token) return;
    setBusy(true);
    try { await resolveBuyIntent(token, outcome); load(); }
    finally { setBusy(false); }
  };

  return (
    <div className="max-w-md mx-auto p-6 space-y-4">
      <h1 className="text-xl font-semibold">🛒 {tracker.name}</h1>
      <div className="rounded-lg border p-4 space-y-1">
        <div>Price: <strong>${intent.price_at_arm.toFixed(2)}</strong></div>
        <div className="text-sm text-gray-500">Your limit: ${intent.threshold_at_arm.toFixed(2)} · Qty {intent.quantity}</div>
        <div className="text-sm text-gray-500">Status: {intent.status}</div>
      </div>

      {intent.status === 'armed' && (
        <button
          disabled={busy}
          onClick={onApprove}
          className="w-full rounded-lg bg-amber-500 text-white py-3 font-medium disabled:opacity-50"
        >
          Approve → Open in Amazon
        </button>
      )}

      {intent.status === 'approved' && (
        <div className="space-y-3">
          {cartUrl && (
            <a href={cartUrl} target="_blank" rel="noopener" className="block text-center underline">
              Re-open Amazon cart
            </a>
          )}
          <div className="text-sm font-medium">Did it go through?</div>
          <div className="flex gap-3">
            <button
              disabled={busy}
              onClick={() => onResolve('purchased')}
              className="flex-1 rounded-lg bg-green-600 text-white py-2 disabled:opacity-50"
            >
              Yes, bought it
            </button>
            <button
              disabled={busy}
              onClick={() => onResolve('not_completed')}
              className="flex-1 rounded-lg border py-2 disabled:opacity-50"
            >
              No
            </button>
          </div>
        </div>
      )}

      {!isOpen && (
        <div className="text-sm text-gray-500">
          This purchase is closed ({intent.status}).
        </div>
      )}
    </div>
  );
}
