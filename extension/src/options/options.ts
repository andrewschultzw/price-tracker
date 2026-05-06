import { getStoredToken, setStoredToken, clearStoredToken } from '../lib/api.js';
import type { ExtensionResponse } from '../lib/messages.js';

const tokenInput = document.getElementById('token') as HTMLInputElement;
const status = document.getElementById('status')!;

(async () => {
  const existing = await getStoredToken();
  if (existing) {
    tokenInput.value = existing;
    setStatus(`Token loaded (${existing.slice(0, 8)}…).`, 'ok');
  }
})();

document.getElementById('save')!.addEventListener('click', async () => {
  const v = tokenInput.value.trim();
  if (!v) { setStatus('Enter a token first.', 'err'); return; }
  await setStoredToken(v);
  setStatus('Saved.', 'ok');
});

document.getElementById('clear')!.addEventListener('click', async () => {
  await clearStoredToken();
  tokenInput.value = '';
  setStatus('Cleared.', 'ok');
});

document.getElementById('test')!.addEventListener('click', async () => {
  setStatus('Testing…', null);
  const resp = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }) as ExtensionResponse;
  if (resp.ok) setStatus('Connection works.', 'ok');
  else setStatus(`Failed: ${resp.error}${resp.detail ? ' — ' + resp.detail : ''}`, 'err');
});

function setStatus(text: string, cls: 'ok' | 'err' | null) {
  status.textContent = text;
  status.className = 'status' + (cls ? ' ' + cls : '');
}
