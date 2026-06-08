import { logger } from '../logger.js';

/**
 * Best-effort ntfy alert on deploy failure. No-op if unconfigured. NEVER
 * throws — a failed alert must not wedge or crash the deploy queue. Uses
 * ntfy's JSON publish API (UTF-8 safe), mirroring notifications/ntfy.ts.
 */
export async function notifyDeployFailure(
  ntfyUrl: string | undefined,
  sha: string,
  detail: string,
  token?: string,
): Promise<void> {
  if (!ntfyUrl) return;
  try {
    const u = new URL(ntfyUrl);
    const base = `${u.protocol}//${u.host}`;
    const topic = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!topic) {
      logger.warn({ ntfyUrl }, 'deploy alert: ntfy URL missing topic; skipping');
      return;
    }
    // Bearer auth for self-hosted ntfy instances that require it; omitted when
    // no token is set (public ntfy.sh with an unguessable topic needs none).
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        topic,
        title: 'price-tracker deploy FAILED',
        message: `commit ${sha.slice(0, 12)}\n${detail}`,
        priority: 5,
        tags: ['rotating_light'],
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'deploy alert: ntfy publish returned non-ok');
    }
  } catch (err) {
    logger.warn({ err }, 'deploy alert: failed to send ntfy notification');
  }
}
