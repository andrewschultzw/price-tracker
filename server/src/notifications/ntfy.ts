import type { Tracker } from '../db/queries.js';
import { logger } from '../logger.js';

/**
 * ntfy has two publish APIs:
 *
 *   1. Per-topic URL with metadata in HTTP headers
 *      (POST https://ntfy.sh/my-topic with Title: / Priority: / etc headers)
 *
 *   2. JSON publish: POST to the instance root with { topic, title, message,
 *      priority, tags, click } in the JSON body.
 *
 * We use (2). Rationale: HTTP header values must be ASCII per RFC 7230, and
 * Node's fetch rejects non-ASCII header values at the client side before the
 * request is even sent. Any tracker name with an emoji, accented letter, or
 * em-dash would cause a silent failure with approach (1). The JSON body is
 * UTF-8 safe.
 *
 * Users paste a topic URL like `https://ntfy.sh/my-topic`. We split that into
 * a base (https://ntfy.sh) and a topic (my-topic) so the JSON publish can
 * target the right instance without a second input.
 *
 * See https://docs.ntfy.sh/publish/#publish-as-json
 */

interface NtfyTarget {
  base: string;
  topic: string;
}

function parseNtfyUrl(url: string): NtfyTarget {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('ntfy URL must be http or https');
  }
  // Strip leading/trailing slashes from the path; ntfy topic is whatever is
  // left. Reject empty topics (bare server URL with no topic).
  const topic = u.pathname.replace(/^\/+|\/+$/g, '');
  if (!topic) {
    throw new Error('ntfy URL is missing a topic (e.g. https://ntfy.sh/my-topic)');
  }
  if (topic.includes('/')) {
    throw new Error('ntfy URL contains nested path segments; expected a single topic name');
  }
  return { base: `${u.protocol}//${u.host}`, topic };
}

interface NtfyPayload {
  topic: string;
  title?: string;
  message: string;
  priority?: number;
  tags?: string[];
  click?: string;
}

async function publish(
  base: string,
  payload: NtfyPayload,
  token?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Optional Bearer auth for self-hosted ntfy instances with
    // auth-default-access=deny-all (our schultzsolutions.tech deployment).
    // Public ntfy.sh with an unguessable topic works without a token, so
    // we only send the header when a token is actually provided.
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(base, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const body = await response.text();
      return { ok: false, error: `ntfy returned ${response.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function sendNtfyPriceAlert(
  tracker: Tracker,
  currentPrice: number,
  ntfyUrl: string,
  ntfyToken?: string,
): Promise<boolean> {
  if (!tracker.threshold_price) return false;

  let target: NtfyTarget;
  try {
    target = parseNtfyUrl(ntfyUrl);
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Invalid ntfy URL');
    return false;
  }

  const savings = (tracker.threshold_price - currentPrice).toFixed(2);
  const result = await publish(target.base, {
    topic: target.topic,
    title: `Price Drop: ${tracker.name}`,
    message: `Now $${currentPrice.toFixed(2)} (target $${tracker.threshold_price.toFixed(2)}, save $${savings})`,
    priority: 4,
    tags: ['tada', 'money_with_wings'],
    click: tracker.url,
  }, ntfyToken);

  if (!result.ok) {
    logger.error({ error: result.error, trackerId: tracker.id }, 'ntfy price alert failed');
    return false;
  }
  logger.info({ trackerId: tracker.id, price: currentPrice }, 'ntfy price alert sent');
  return true;
}

export async function sendNtfyErrorAlert(
  tracker: Tracker,
  error: string,
  ntfyUrl: string,
  ntfyToken?: string,
): Promise<boolean> {
  let target: NtfyTarget;
  try {
    target = parseNtfyUrl(ntfyUrl);
  } catch (err) {
    logger.error({ err, trackerId: tracker.id }, 'Invalid ntfy URL');
    return false;
  }

  const result = await publish(target.base, {
    topic: target.topic,
    title: `Tracker Error: ${tracker.name}`,
    message: `Scrape failed ${tracker.consecutive_failures}x: ${error.slice(0, 300)}`,
    priority: 3,
    tags: ['warning'],
    click: tracker.url,
  }, ntfyToken);

  if (!result.ok) {
    logger.error({ error: result.error, trackerId: tracker.id }, 'ntfy error alert failed');
    return false;
  }
  return true;
}

/**
 * Unlike the price/error alerts, the test function returns the actual error
 * string so the Settings page can display it instead of a bare "Failed".
 */
export async function testNtfyWebhook(
  ntfyUrl: string,
  ntfyToken?: string,
): Promise<{ ok: boolean; error?: string }> {
  let target: NtfyTarget;
  try {
    target = parseNtfyUrl(ntfyUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }

  const result = await publish(target.base, {
    topic: target.topic,
    title: 'Price Tracker - Test Notification',
    message: 'ntfy is wired up and working correctly.',
    priority: 3,
    tags: ['white_check_mark'],
  }, ntfyToken);

  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}
