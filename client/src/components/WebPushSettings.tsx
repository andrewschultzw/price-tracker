import { useEffect, useState, useCallback } from 'react';
import {
  getSubscriptionState,
  subscribePush,
  unsubscribePush,
  getDevices,
  removeDevice,
  type SubscriptionState,
} from '../lib/web-push';
import { getSettings, updateSettings } from '../api';
import type { WebPushDevice } from '../types';

function formatRelative(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso + 'Z').getTime();
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

export function WebPushSettings() {
  const [state, setState] = useState<SubscriptionState | 'loading'>('loading');
  const [devices, setDevices] = useState<WebPushDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minConfidence, setMinConfidence] = useState<string>('');
  const [savingConfidence, setSavingConfidence] = useState(false);
  const [savedConfidence, setSavedConfidence] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await getSubscriptionState());
      setDevices(await getDevices());
      const settings = await getSettings();
      setMinConfidence(settings.web_push_min_confidence || '');
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleEnable() {
    setBusy(true);
    setError(null);
    try {
      await subscribePush();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable() {
    setBusy(true);
    setError(null);
    try {
      await unsubscribePush();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemoveDevice(id: number) {
    setError(null);
    try {
      await removeDevice(id);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function handleSaveMinConfidence() {
    setSavingConfidence(true);
    setSavedConfidence(false);
    try {
      await updateSettings({
        web_push_min_confidence: minConfidence === 'LOW' ? '' : minConfidence,
      });
      setSavedConfidence(true);
      setTimeout(() => setSavedConfidence(false), 3000);
    } finally {
      setSavingConfidence(false);
    }
  }

  const helpText: Record<SubscriptionState | 'loading', string> = {
    'loading': 'Checking notification status...',
    'unsupported': "Your browser doesn't support push notifications.",
    'permission-denied': 'Notifications blocked. Enable in your browser settings.',
    'available': 'Receive price alerts as native browser notifications.',
    'enabled': 'You\'re receiving push notifications on this device.',
    'ios-needs-pwa': 'On iPhone: Share → Add to Home Screen first, then open from the home screen icon.',
  };

  const buttonLabel =
    state === 'enabled' ? 'Disable on this device' :
    state === 'available' ? 'Enable' :
    state === 'loading' ? '…' :
    'Enable';

  const buttonDisabled =
    busy ||
    state === 'unsupported' ||
    state === 'permission-denied' ||
    state === 'ios-needs-pwa' ||
    state === 'loading';

  return (
    <div className="rounded-lg border border-border bg-surface p-4 mb-4">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h3 className="font-semibold">Browser notifications</h3>
          <p className="text-sm text-text-muted mt-1">{helpText[state]}</p>
        </div>
        <button
          onClick={state === 'enabled' ? handleDisable : handleEnable}
          disabled={buttonDisabled}
          className="px-3 py-1.5 rounded bg-primary text-white text-sm font-medium disabled:opacity-50 flex-shrink-0"
        >
          {buttonLabel}
        </button>
      </div>

      {error && <div className="text-error text-sm mb-2">{error}</div>}

      <div className="border-t border-border pt-3 mt-3">
        <div className="text-sm font-medium text-text mb-3">Minimum confidence</div>
        <div className="flex items-end gap-3">
          <div className="flex-1">
            <select
              value={minConfidence || 'LOW'}
              onChange={e => setMinConfidence(e.target.value === 'LOW' ? '' : e.target.value)}
              disabled={savingConfidence}
              className="w-full bg-bg border border-border rounded-lg px-4 py-2.5 text-text focus:outline-none focus:border-primary disabled:opacity-50"
            >
              <option value="LOW">All deals</option>
              <option value="MEDIUM">Good deals only</option>
              <option value="HIGH">Strong deals only</option>
            </select>
          </div>
          <button
            onClick={handleSaveMinConfidence}
            disabled={savingConfidence}
            className="px-4 py-2.5 bg-primary hover:bg-primary-dark text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 flex-shrink-0"
          >
            {savedConfidence ? 'Saved!' : savingConfidence ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>

      {devices.length > 0 && (
        <div className="border-t border-border pt-3 mt-3">
          <div className="text-xs text-text-muted mb-2">Registered devices</div>
          <ul className="space-y-1">
            {devices.map(d => (
              <li key={d.id} className="flex items-center justify-between text-sm">
                <span className="text-text">
                  {d.device_label ?? `Device ${d.id}`}
                  <span className="text-text-muted ml-2">
                    · added {formatRelative(d.created_at)}
                    {d.last_used_at && ` · last fired ${formatRelative(d.last_used_at)}`}
                  </span>
                </span>
                <button
                  onClick={() => handleRemoveDevice(d.id)}
                  className="text-text-muted hover:text-error text-xs"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
