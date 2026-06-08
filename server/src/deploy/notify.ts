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
    const res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic,
        title: 'price-tracker deploy FAILED',
        message: `commit ${sha.slice(0, 12)}\n${detail}`,
        priority: 5,
        tags: ['rotating_light'],
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'deploy alert: ntfy publish returned non-ok');
    }
  } catch (err) {
    logger.warn({ err }, 'deploy alert: failed to send ntfy notification');
  }
}
